const Minio = require('minio');

class MinioService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.bucketName = process.env.MINIO_BUCKET_NAME || 'lay4rdev';
    this.init();
  }

  async init() {
    // Initialize client but don't block on connection
    try {
      let endPoint = process.env.MINIO_ENDPOINT || 'localhost';
      let port = parseInt(process.env.MINIO_PORT) || 9000;
      let useSSL = process.env.MINIO_USE_SSL === 'true';
      
      // Handle URL format (e.g., https://s3.lay4r.io)
      if (endPoint.includes('://')) {
        const url = new URL(endPoint);
        endPoint = url.hostname;
        port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);
        useSSL = url.protocol === 'https:';
      }

      const config = {
        endPoint,
        port,
        useSSL,
        accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
        secretKey: process.env.MINIO_SECRET_KEY || 'SuperSecurePass123!',
        region: process.env.MINIO_REGION || 'us-east-1',
        pathStyle: true // Force path-style URLs instead of virtual-hosted-style
      };

      console.log('🔧 [MINIO] Initializing MinIO client with config:', {
        endPoint: config.endPoint,
        port: config.port,
        useSSL: config.useSSL,
        bucketName: this.bucketName,
        accessKey: config.accessKey ? '***' : 'none'
      });

      this.client = new Minio.Client(config);
      
      // Test connection asynchronously (don't block module loading)
      this.testConnection();
      
    } catch (error) {
      console.error('❌ [MINIO] Failed to initialize MinIO client:', error);
      this.isConnected = false;
    }
  }

  async testConnection() {
    try {
      const buckets = await this.client.listBuckets();
      console.log('Buckets:', buckets);
      await this.ensureBucketExists();
      
      this.isConnected = true;
      console.log('✅ [MINIO] Connected to MinIO successfully');
    } catch (error) {
      console.error('❌ [MINIO] MinIO connection failed (will retry on use):', error.message);
      this.isConnected = false;
    }
  }

  async ensureBucketExists() {
    try {
      const exists = await this.client.bucketExists(this.bucketName);
      if (!exists) {
        console.log(`🔧 [MINIO] Creating bucket: ${this.bucketName}`);
        await this.client.makeBucket(this.bucketName, 'us-east-1');
        console.log(`✅ [MINIO] Bucket created: ${this.bucketName}`);
      } else {
        console.log(`✅ [MINIO] Bucket exists: ${this.bucketName}`);
      }
    } catch (error) {
      console.error('❌ [MINIO] Error ensuring bucket exists:', error);
      throw error;
    }
  }

  async uploadFile(fileName, fileBuffer, contentType = 'application/octet-stream', metadata = {}) {
    // Ensure connection before uploading
    if (!this.isConnected) {
      console.log('🔄 [MINIO] Connection not ready, testing connection...');
      await this.testConnection();
      if (!this.isConnected) {
        throw new Error('MinIO client not connected');
      }
    }

    try {
      console.log(`📤 [MINIO] Uploading file: ${fileName}`);
      console.log(`📤 [MINIO] File details:`, {
        fileName,
        bucketName: this.bucketName,
        size: fileBuffer.length,
        contentType,
        metadata
      });
      
      const uploadOptions = {
        'Content-Type': contentType,
        ...metadata
      };
      
      console.log(`📤 [MINIO] Upload options:`, uploadOptions);
      
      const result = await this.client.putObject(
        this.bucketName,
        fileName,
        fileBuffer,
        fileBuffer.length,
        uploadOptions
      );

      console.log(`✅ [MINIO] File uploaded successfully:`, {
        fileName,
        bucketName: this.bucketName,
        size: fileBuffer.length,
        etag: result.etag,
        result
      });
      
      return { success: true, fileName, bucketName: this.bucketName, size: fileBuffer.length, etag: result.etag };
    } catch (error) {
      console.error(`❌ [MINIO] Upload failed ${fileName}:`, error);
      console.error(`❌ [MINIO] Error details:`, {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
        stack: error.stack
      });
      throw error;
    }
  }

  async downloadFile(fileName) {
    if (!this.isConnected) throw new Error('MinIO client not connected');

    try {
      console.log(`📥 [MINIO] Downloading: ${fileName}`);
      const stream = await this.client.getObject(this.bucketName, fileName);
      
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      
      console.log(`✅ [MINIO] Downloaded: ${fileName}`);
      return { success: true, fileName, buffer, size: buffer.length };
    } catch (error) {
      console.error(`❌ [MINIO] Download failed ${fileName}:`, error);
      throw error;
    }
  }

  async getFileInfo(fileName) {
    if (!this.isConnected) throw new Error('MinIO client not connected');

    try {
      console.log(`🔍 [MINIO] Getting info: ${fileName}`);
      const stat = await this.client.statObject(this.bucketName, fileName);
      
      return {
        success: true,
        fileName,
        size: stat.size,
        etag: stat.etag,
        lastModified: stat.lastModified,
        contentType: stat.metaData['content-type'] || 'application/octet-stream',
        metadata: stat.metaData
      };
    } catch (error) {
      console.error(`❌ [MINIO] Stat failed ${fileName}:`, error);
      throw error;
    }
  }

  // ✅ FIXED: Use Minio.CopyConditions (not this.client.CopyConditions)
  async copyFile(sourceFileName, destFileName) {
    if (!this.isConnected) throw new Error('MinIO client not connected');

    try {
      console.log(`📋 [MINIO] Copying: ${sourceFileName} → ${destFileName}`);
      
      const copyConditions = new Minio.CopyConditions(); // ✅ Correct
      await this.client.copyObject(
        this.bucketName,
        destFileName,
        `/${this.bucketName}/${sourceFileName}`,
        copyConditions
        // ❌ Metadata is NOT a valid 5th parameter in MinIO JS SDK
      );

      console.log(`✅ [MINIO] Copied: ${sourceFileName} → ${destFileName}`);
      return { success: true, sourceFileName, destFileName };
    } catch (error) {
      console.error(`❌ [MINIO] Copy failed ${sourceFileName}:`, error);
      throw error;
    }
  }

  async deleteFile(fileName) {
    if (!this.isConnected) throw new Error('MinIO client not connected');
    try {
      console.log(`🗑️ [MINIO] Deleting: ${fileName}`);
      await this.client.removeObject(this.bucketName, fileName);
      console.log(`✅ [MINIO] Deleted: ${fileName}`);
      return { success: true, fileName };
    } catch (error) {
      console.error(`❌ [MINIO] Delete failed ${fileName}:`, error);
      throw error;
    }
  }

  async listFiles(prefix = '', recursive = true) {
    if (!this.isConnected) throw new Error('MinIO client not connected');

    return new Promise((resolve, reject) => {
      console.log(`📋 [MINIO] Listing files: ${prefix}`);
      const objectsList = [];
      const stream = this.client.listObjects(this.bucketName, prefix, recursive);
      
      stream.on('data', (obj) => {
        console.log(`📋 [MINIO] Found object:`, {
          name: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag
        });
        objectsList.push({
          name: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag
        });
      });
      
      stream.on('error', (error) => {
        console.error(`❌ [MINIO] List objects error:`, error);
        reject(error);
      });
      stream.on('end', () => {
        console.log(`✅ [MINIO] Listed ${objectsList.length} files`);
        resolve({ success: true, files: objectsList, count: objectsList.length });
      });
    });
  }

  // ✅ PRESIGNED URLS — return raw URL (no fake "shared" API)
  async getPresignedUrl(fileName, expiry = 7 * 24 * 60 * 60) {
    // Ensure connection before generating presigned URL
    if (!this.isConnected) {
      console.log('🔄 [MINIO] Connection not ready, testing connection...');
      await this.testConnection();
      if (!this.isConnected) {
        throw new Error('MinIO client not connected');
      }
    }
    try {
      console.log(`🔗 [MINIO] Presigned URL: ${fileName}`);
      const url = await this.client.presignedGetObject(this.bucketName, fileName, expiry);
      console.log(`✅ [MINIO] URL generated`);
      return { success: true, fileName, url, expiry };
    } catch (error) {
      console.error(`❌ [MINIO] Presigned URL failed ${fileName}:`, error);
      throw error;
    }
  }

  async getPresignedUploadUrl(fileName, expiry = 60 * 60) {
    if (!this.isConnected) throw new Error('MinIO client not connected');
    try {
      console.log(`📤 [MINIO] Presigned upload URL: ${fileName}`);
      const url = await this.client.presignedPutObject(this.bucketName, fileName, expiry);
      console.log(`✅ [MINIO] Upload URL generated`);
      return { success: true, fileName, url, expiry };
    } catch (error) {
      console.error(`❌ [MINIO] Upload URL failed ${fileName}:`, error);
      throw error;
    }
  }

  // ❌ REMOVE: MinIO has NO /api/v1/download-shared-object endpoint
  // This is a custom proxy you'd need to build separately — not part of MinIO SDK

  async healthCheck() {
    if (!this.isConnected) {
      return { connected: false, error: 'Not initialized' };
    }
    try {
      await this.client.bucketExists(this.bucketName);
      return { connected: true, bucketName: this.bucketName, timestamp: new Date().toISOString() };
    } catch (error) {
      return { connected: false, error: error.message, timestamp: new Date().toISOString() };
    }
  }
}

module.exports = new MinioService();