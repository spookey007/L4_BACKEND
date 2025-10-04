// lib/encryption.js (Node.js only)

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ENCRYPTION_KEY = process.env.WEBSOCKET_ENCRYPTION_KEY || 
  '0000000000000000000000000000000000000000000000000000000000000000'; // 64 hex chars

function getKeyBuffer() {
  if (ENCRYPTION_KEY.length !== 64) {
    throw new Error('WEBSOCKET_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes');
  }
  return key;
}

async function encryptData(data) {
  const dataString = JSON.stringify(data);
  const key = getKeyBuffer();
  const iv = randomBytes(12); // 96 bits for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  const ciphertext = cipher.update(dataString, 'utf8');
  cipher.final();
  const authTag = cipher.getAuthTag();

  return {
    encrypted: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: authTag.toString('base64')
  };
}

// Optional: keep decryptData for server-side testing
async function decryptData(encryptedData) {
  const key = getKeyBuffer();
  const iv = Buffer.from(encryptedData.iv, 'base64');
  const tag = Buffer.from(encryptedData.tag, 'base64');
  const ciphertext = Buffer.from(encryptedData.encrypted, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = decipher.update(ciphertext, undefined, 'utf8');
  decipher.final();
  return JSON.parse(plaintext);
}

module.exports = { encryptData, decryptData };