'use strict'

const chalk = require('chalk')
const semver = require('semver')

const get = (obj, path, defaultValue) => {
  return path.split('.').filter(Boolean).every(step => !(step && !(obj = obj[step]))) ? obj : defaultValue
}

class DeploymentBucketPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.provider = this.serverless.providers.aws

    const configPath = semver.satisfies(serverless.version, '>=2.10.0')
        ? 'provider.deploymentBucket'
        : 'provider.deploymentBucketObject';
    this.deploymentBucket = get(this.serverless.service, configPath, {})
    
    this.config = get(this.serverless.service, 'custom.deploymentBucket', {})

    this.hooks = {}

    if (this.config.enabled !== undefined && this.config.enabled === false) {
      return;
    }

    if (this.deploymentBucket.name) {
      this.config.versioning = get(this.config, 'versioning', false)
      this.config.accelerate = get(this.config, 'accelerate', false)
      this.config.policy = get(this.config, 'policy', undefined)

      const serverlessCommand = get(this.serverless, 'processedInput.commands', [])
      if (!serverlessCommand.includes('package')) {
        this.hooks['before:aws:common:validate:validate'] = this.applyDeploymentBucket.bind(this)
      }
    }
  }

  async bucketExists(name) {
    var params = {
      Bucket: name
    };

    try {
      await this.provider.request('S3', 'headBucket', params)
      return true
    } catch (e) {
      return false
    }
  }

  async waitFor(name, state) {
    var params = {
      Bucket: name
    };

    try {
      const service = new this.provider.sdk['S3'](this.provider.getCredentials())
      await service.waitFor(state, params).promise()

      return true
    } catch (e) {
      this.serverless.cli.log(`Unable to wait for '${state}' - ${e.message}`)

      return false
    }
  }

  async createBucket(name) {
    const params = {
      Bucket: name,
      ACL: 'private'
    };

    return await this.provider.request('S3', 'createBucket', params)
  }

  async hasBucketEncryption(name) {
    const params = {
      Bucket: name
    };

    try {
      await this.provider.request('S3', 'getBucketEncryption', params)
      return true
    } catch (e) {
      return false
    }
  }

  async putBucketEncryption(name, sseAlgorithm, kmsMasterKeyId) {
    const params = {
      Bucket: name,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: sseAlgorithm,
              KMSMasterKeyID: kmsMasterKeyId
            }
          }
        ]
      }
    }

    return await this.provider.request('S3', 'putBucketEncryption', params)
  }

  async hasBucketVersioning(name) {
    const params = {
      Bucket: name
    };

    try {
      const response = await this.provider.request('S3', 'getBucketVersioning', params)
      if (response.Status && response.Status == 'Enabled') {
        return true
      }

      return false
    } catch (e) {
      return false
    }
  }

  async putBucketVersioning(name, status) {
    const params = {
      Bucket: name,
      VersioningConfiguration: {
        Status: status ? 'Enabled' : 'Suspended'
      }
    };

    return await this.provider.request('S3', 'putBucketVersioning', params)
  }

  async hasBucketAcceleration(name) {
    const params = {
      Bucket: name
    };

    try {
      const response = await this.provider.request('S3', 'getBucketAccelerateConfiguration', params)
      if (response.Status && response.Status == 'Enabled') {
        return true
      }

      return false
    } catch (e) {
      return false
    }
  }

  async putBucketAcceleration(name, status) {
    const params = {
      Bucket: name,
      AccelerateConfiguration: {
        Status: status ? 'Enabled' : 'Suspended'
      }
    };

    return await this.provider.request('S3', 'putBucketAccelerateConfiguration', params)
  }

  async putBucketPolicy(name, policy) {
    const params = {
      Bucket: name,
      Policy: JSON.stringify(policy),
    };
    return await this.provider.request('S3', 'putBucketPolicy', params)
  }

  async applyDeploymentBucket() {
    try {
      if (await this.bucketExists(this.deploymentBucket.name)) {
        this.serverless.cli.log(`Using deployment bucket '${this.deploymentBucket.name}'`)
      } else {
        this.serverless.cli.log(`Creating deployment bucket '${this.deploymentBucket.name}'...`)

        await this.createBucket(this.deploymentBucket.name)
        await this.waitFor(this.deploymentBucket.name, 'bucketExists')
      }

      if (this.deploymentBucket.serverSideEncryption) {
        if (!(await this.hasBucketEncryption(this.deploymentBucket.name))) {
          await this.putBucketEncryption(this.deploymentBucket.name, this.deploymentBucket.serverSideEncryption)

          this.serverless.cli.log(`Applied SSE (${this.deploymentBucket.serverSideEncryption}) to deployment bucket`)
        }
      }

      if ((await this.hasBucketVersioning(this.deploymentBucket.name)) != this.config.versioning) {
        await this.putBucketVersioning(this.deploymentBucket.name, this.config.versioning)

        if (this.config.versioning) {
          this.serverless.cli.log('Enabled versioning on deployment bucket')
        } else {
          this.serverless.cli.log('Suspended versioning on deployment bucket')
        }
      }

      if ((await this.hasBucketAcceleration(this.deploymentBucket.name)) != this.config.accelerate) {
        await this.putBucketAcceleration(this.deploymentBucket.name, this.config.accelerate)

        if (this.config.accelerate) {
          this.serverless.cli.log('Enabled acceleration on deployment bucket')
        } else {
          this.serverless.cli.log('Suspended acceleration on deployment bucket')
        }
      }

      if (this.config.policy) {
        await this.putBucketPolicy(this.deploymentBucket.name, this.config.policy)
        this.serverless.cli.log(`Applied deployment bucket policy`)
      }
    } catch (e) {
      console.error(chalk.red(`\n-------- Deployment Bucket Error --------\n${e.message}`))
    }
  }
}

module.exports = DeploymentBucketPlugin
