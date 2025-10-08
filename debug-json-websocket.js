/**
 * Debug WebSocket with JSON format
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

async function debugJsonWebSocket() {
  console.log('🔍 Debug WebSocket with JSON format...');
  
  const ws = new WebSocket('ws://localhost:3001/auth');
  
  ws.on('open', () => {
    console.log('✅ Connected to WebSocket server');
  });
  
  ws.on('message', (data) => {
    console.log('📨 Raw message received:', data.toString());
    
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
        
      } else if (message.type === 'AUTH_SUCCESS' || (Array.isArray(message) && message[0] === 'AUTH_SUCCESS')) {
        console.log('✅ Authentication successful!');
        if (message.user) {
          console.log('👤 User:', message.user);
        } else if (Array.isArray(message) && message[1] && message[1].user) {
          console.log('👤 User:', message[1].user);
        }
        
        // Test sending a ping in JSON format
        setTimeout(() => {
          console.log('📤 Sending JSON PING...');
          ws.send(JSON.stringify({ type: 'PING', payload: {} }));
        }, 2000);
        
      } else if (message.type === 'AUTH_FAILED' || (Array.isArray(message) && message[0] === 'AUTH_FAILED')) {
        console.log('❌ Authentication failed:', message.error || (Array.isArray(message) ? message[1]?.error : null));
        
      } else if (message.type === 'AUTH_REQUIRED' || (Array.isArray(message) && message[0] === 'AUTH_REQUIRED')) {
        console.log('⚠️ Authentication required - this should not happen after AUTH_SUCCESS');
        
      } else if (message.type === 'PONG' || (Array.isArray(message) && message[0] === 'PONG')) {
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

debugJsonWebSocket().catch(console.error);
