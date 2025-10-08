const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Test WebSocket authentication flow
async function testWebSocketAuth() {
  console.log('🧪 Testing WebSocket authentication flow...');
  
  // Generate a test JWT token
  const testPayload = {
    walletAddress: '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300, // 5 minutes
    nonce: 'test-nonce-' + Date.now(),
    sessionId: 'test-session-' + Date.now()
  };
  
  const jwtSecret = 'K9x2pLmclear!nR6fWbY7jDcH4sTqZ5eNwVrA1uFgB9oIzX0MlPdS';
  const token = jwt.sign(testPayload, jwtSecret);
  
  console.log('🔑 Generated JWT token:', token.substring(0, 50) + '...');
  
  // Connect to auth endpoint
  const ws = new WebSocket('ws://localhost:3001/auth');
  
  ws.on('open', () => {
    console.log('✅ Connected to auth endpoint');
    
    // Wait for AUTH_CHALLENGE
    setTimeout(() => {
      console.log('📤 Sending AUTH_LOGIN...');
      const authLogin = {
        type: 'AUTH_LOGIN',
        payload: {
          walletAddress: '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA',
          jwtToken: token
        }
      };
      
      ws.send(JSON.stringify(authLogin));
    }, 1000);
  });
  
  ws.on('message', (data) => {
    try {
      // Try to parse as JSON first
      const message = JSON.parse(data.toString());
      console.log('📨 Received JSON message:', JSON.stringify(message, null, 2));
      
      if (message.type === 'AUTH_LOGIN_RESPONSE') {
        console.log('🎉 SUCCESS! Received encrypted AUTH_LOGIN_RESPONSE!');
        console.log('🔐 Response structure:', {
          type: message.type,
          success: message.success,
          encrypted: message.encrypted,
          hasData: !!message.data,
          hasEncrypted: !!message.data?.encrypted,
          hasIv: !!message.data?.iv,
          hasTag: !!message.data?.tag
        });
      }
    } catch (error) {
      // Try MessagePack
      try {
        const msgpack = require('msgpack-lite');
        const [eventType, payload, timestamp] = msgpack.decode(data);
        console.log('📨 Received MessagePack message:', eventType, payload);
      } catch (msgpackError) {
        console.log('📨 Received raw message:', data.toString());
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
  
  ws.on('close', (code, reason) => {
    console.log('🔌 WebSocket closed:', code, reason.toString());
  });
  
  // Close after 10 seconds
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 10000);
}

testWebSocketAuth().catch(console.error);