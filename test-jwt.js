const jwt = require('jsonwebtoken');

// Test JWT token generation and validation
const secretKey = process.env.JWT_SECRET || 'your-secret-key';

// Generate a test JWT token
const payload = {
  walletAddress: '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour
};

const token = jwt.sign(payload, secretKey, { algorithm: 'HS256' });

console.log('🔐 [JWT] Generated token:', token);
console.log('🔐 [JWT] Payload:', payload);

// Test validation
try {
  const decoded = jwt.verify(token, secretKey, { algorithms: ['HS256'] });
  console.log('✅ [JWT] Token validation successful:', decoded);
} catch (error) {
  console.error('❌ [JWT] Token validation failed:', error.message);
}
