/**
 * Test WebSocket with JSON format (like browser)
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

async function testJsonWebSocket() {
  console.log('🔍 Testing WebSocket with JSON format...');
  
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
        console.log('📨 Received JSON:', message);
      } catch (jsonError) {
        // Try MessagePack
        const msgpack = require('msgpack-lite');
        try {
          const decoded = msgpack.decode(data);
          console.log('📨 Received MessagePack:', decoded);
          message = decoded;
        } catch (msgpackError) {
          console.log('📨 Received raw data:', data.toString());
          return;
        }
      }
      
      if (message.type === 'AUTH_CHALLENGE') {
        console.log('🔐 Received authentication challenge, sending JSON auth...');
        
        // Create valid JWT token
        const testWalletAddress = '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA';
        const testJwtToken = jwt.sign(
          { walletAddress: testWalletAddress },
          process.env.JWT_SECRET || 'your-secret-key',
          { expiresIn: '1h' }
        );
        
        // Send JSON format authentication (like browser)
        const authMessage = {
          type: 'AUTH_LOGIN',
          payload: {
            walletAddress: testWalletAddress,
            jwtToken: testJwtToken
          }
        };
        
        console.log('📤 Sending JSON AUTH_LOGIN:', authMessage);
        ws.send(JSON.stringify(authMessage));
        
      } else if (message.type === 'AUTH_SUCCESS') {
        console.log('✅ Authentication successful!');
        console.log('👤 User:', message.user);
        
        // Test sending a ping in JSON format
        setTimeout(() => {
          console.log('📤 Sending JSON PING...');
          ws.send(JSON.stringify({ type: 'PING', payload: {} }));
        }, 2000);
        
      } else if (message.type === 'AUTH_FAILED') {
        console.log('❌ Authentication failed:', message.error);
        
      } else if (message.type === 'AUTH_REQUIRED') {
        console.log('⚠️ Authentication required - this should not happen after AUTH_SUCCESS');
        
      } else if (message.type === 'PONG') {
        console.log('✅ Received PONG - authentication flow working correctly!');
        
        // Close after successful test
        setTimeout(() => {
          console.log('🔌 Closing connection...');
          ws.close();
        }, 1000);
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

testJsonWebSocket().catch(console.error);
