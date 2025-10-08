/**
 * Test WebSocket with invalid JWT token
 */

const WebSocket = require('ws');

async function testInvalidJWT() {
  console.log('🔍 Testing WebSocket with invalid JWT token...');
  
  const ws = new WebSocket('ws://localhost:3001/auth');
  
  ws.on('open', () => {
    console.log('✅ Connected to WebSocket server');
  });
  
  ws.on('message', (data) => {
    try {
      // Try to parse as JSON first
      let message;
      try {
        message = JSON.parse(data.toString());
        console.log('📨 Parsed as JSON:', message);
      } catch (jsonError) {
        // Try MessagePack
        const msgpack = require('msgpack-lite');
        try {
          const decoded = msgpack.decode(data);
          console.log('📨 Parsed as MessagePack:', decoded);
          message = decoded;
        } catch (msgpackError) {
          console.log('📨 Could not parse as JSON or MessagePack');
          return;
        }
      }
      
      if (message.type === 'AUTH_CHALLENGE' || (Array.isArray(message) && message[0] === 'AUTH_CHALLENGE')) {
        console.log('🔐 Received authentication challenge, sending invalid JWT...');
        
        // Send invalid JWT token
        const authMessage = {
          type: 'AUTH_LOGIN',
          payload: {
            walletAddress: '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA',
            jwtToken: 'invalid-jwt-token'
          }
        };
        
        console.log('📤 Sending invalid JWT AUTH_LOGIN:', authMessage);
        ws.send(JSON.stringify(authMessage));
        
      } else if (message.type === 'AUTH_SUCCESS' || (Array.isArray(message) && message[0] === 'AUTH_SUCCESS')) {
        console.log('✅ Authentication successful!');
        
      } else if (message.type === 'AUTH_FAILED' || (Array.isArray(message) && message[0] === 'AUTH_FAILED')) {
        console.log('❌ Authentication failed as expected:', message.error || (Array.isArray(message) ? message[1]?.error : null));
        
        // Close after failed authentication
        setTimeout(() => {
          console.log('🔌 Closing connection...');
          ws.close();
        }, 1000);
        
      } else if (message.type === 'AUTH_REQUIRED' || (Array.isArray(message) && message[0] === 'AUTH_REQUIRED')) {
        console.log('⚠️ Authentication required');
      }
    } catch (error) {
      console.error('❌ Error processing message:', error);
    }
  });
  
  ws.on('close', (code, reason) => {
    console.log('🔌 Connection closed:', code, reason.toString());
  });
  
  ws.on('error', (error) => {
    console.error('❌ Connection error:', error.message);
  });
}

testInvalidJWT().catch(console.error);
