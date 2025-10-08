const crypto = require('crypto');

class EncryptionService {
  constructor() {
    // Use a strong encryption key from environment variables
    this.algorithm = 'aes-256-gcm';
    this.key = process.env.WEBSOCKET_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    
    // Ensure key is 32 bytes for AES-256
    if (this.key.length !== 64) {
      this.key = crypto.createHash('sha256').update(this.key).digest('hex');
    }
    
    console.log('🔐 [ENCRYPTION] Service initialized with algorithm:', this.algorithm);
  }

  /**
   * Encrypt data using AES-256-GCM
   * @param {any} data - Data to encrypt
   * @returns {Object} - Encrypted data with iv and tag
   */
  encrypt(data) {
    try {
      const iv = crypto.randomBytes(16);
      const keyBuffer = Buffer.from(this.key, 'hex');
      const cipher = crypto.createCipheriv(this.algorithm, keyBuffer, iv);
      
      // Convert data to string if it's an object
      const dataString = typeof data === 'string' ? data : JSON.stringify(data);
      
      let encrypted = cipher.update(dataString, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      
      const tag = cipher.getAuthTag();
      
      return {
        encrypted: encrypted,
        iv: iv.toString('base64'),
        tag: tag.toString('base64')
      };
    } catch (error) {
      console.error('❌ [ENCRYPTION] Encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  /**
   * Decrypt data using AES-256-GCM
   * @param {Object} encryptedData - Encrypted data with iv and tag
   * @returns {any} - Decrypted data
   */
  decrypt(encryptedData) {
    try {
      const { encrypted, iv, tag } = encryptedData;
      
      if (!encrypted || !iv || !tag) {
        throw new Error('Invalid encrypted data structure');
      }
      
      const keyBuffer = Buffer.from(this.key, 'hex');
      const ivBuffer = Buffer.from(iv, 'base64');
      const decipher = crypto.createDecipheriv(this.algorithm, keyBuffer, ivBuffer);
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      
      let decrypted = decipher.update(encrypted, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      
      // Try to parse as JSON, fallback to string
      try {
        return JSON.parse(decrypted);
      } catch {
        return decrypted;
      }
    } catch (error) {
      console.error('❌ [ENCRYPTION] Decryption failed:', error);
      throw new Error('Decryption failed');
    }
  }

  /**
   * Create an encrypted response in the old format
   * @param {any} data - Data to encrypt
   * @param {string} type - Response type
   * @param {boolean} success - Success status
   * @returns {Object} - Encrypted response
   */
  createEncryptedResponse(data, type, success = true) {
    console.log('🔐 [ENCRYPTION] Creating encrypted response for type:', type);
    console.log('🔐 [ENCRYPTION] Data to encrypt:', JSON.stringify(data, null, 2));
    
    const encryptedData = this.encrypt(data);
    console.log('🔐 [ENCRYPTION] Encrypted data created:', {
      hasEncrypted: !!encryptedData.encrypted,
      hasIv: !!encryptedData.iv,
      hasTag: !!encryptedData.tag,
      encryptedLength: encryptedData.encrypted?.length || 0
    });
    
    const response = {
      type: type,
      success: success,
      data: encryptedData,
      encrypted: true
    };
    
    console.log('🔐 [ENCRYPTION] Final response structure:', {
      type: response.type,
      success: response.success,
      encrypted: response.encrypted,
      hasData: !!response.data
    });
    
    return response;
  }
}

module.exports = new EncryptionService();