const jwt = require('jsonwebtoken');

// Test JWT validation with hardcoded secret
const jwtSecret = 'K9x2pLmclear!nR6fWbY7jDcH4sTqZ5eNwVrA1uFgB9oIzX0MlPdS';

console.log('🧪 Testing JWT validation with hardcoded secret...');
console.log('JWT Secret:', jwtSecret.substring(0, 10) + '...');

// Generate a test JWT token
const testPayload = {
  walletAddress: '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300, // 5 minutes
  nonce: 'test-nonce-' + Date.now(),
  sessionId: 'test-session-' + Date.now()
};

const token = jwt.sign(testPayload, jwtSecret);
console.log('Generated token:', token.substring(0, 50) + '...');

// Verify the token
try {
  const decoded = jwt.verify(token, jwtSecret);
  console.log('✅ JWT verification successful:', decoded);
} catch (error) {
  console.error('❌ JWT verification failed:', error.message);
}

// Test with the exact token from our test
const testToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3YWxsZXRBZGRyZXNzIjoiNkIxUzZUclF3bTFXcnQyTWRjcmVxV0RybUo2dENLY1pTVWl1OEdaakNGZEEiLCJpYXQiOjE3NTk4MDUwMTksImV4cCI6MTc1OTgwNTMxOSwibm9uY2UiOiJ0ZXN0LW5vbmNlIiwic2Vzc2lvbklkIjoidGVzdC1zZXNzaW9uIn0.BPCUlgs_Gs7KhROk7fQhdc2Eybj3u5Y2POR1khehlCA';

console.log('\n🧪 Testing with exact token from test...');
try {
  const decoded = jwt.verify(testToken, jwtSecret);
  console.log('✅ JWT verification successful:', decoded);
} catch (error) {
  console.error('❌ JWT verification failed:', error.message);
}
