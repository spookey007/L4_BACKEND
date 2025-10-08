/**
 * Debug WebSocket Authentication Test
 */

const WebSocket = require('ws');
const msgpack = require('msgpack-lite');
const jwt = require('jsonwebtoken');

async function debugTest() {
  console.log('🔍 DEBUG: WebSocket Authentication Test');
  
  const ws = new WebSocket('ws://localhost:3001/auth');
  
  ws.on('open', () => {
    console.log('✅ Connected to WebSocket server');
  });
  
  ws.on('message', (data) => {
    try {
      const [eventType, payload] = msgpack.decode(data);
      console.log('📨 Received:', eventType, JSON.stringify(payload, null, 2));
      
      if (eventType === 'AUTH_CHALLENGE') {
        console.log('🔐 Sending authentication...');
        
        // Create valid JWT token
        const testWalletAddress = '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA';
        const testJwtToken = jwt.sign(
          { walletAddress: testWalletAddress },
          process.env.JWT_SECRET || 'your-secret-key',
          { expiresIn: '1h' }
        );
        
        const authPayload = {
          walletAddress: testWalletAddress,
          jwtToken: testJwtToken
        };
        
        console.log('📤 Sending AUTH_LOGIN:', authPayload);
        ws.send(msgpack.encode(['AUTH_LOGIN', authPayload, Date.now()]));
        
      } else if (eventType === 'AUTH_SUCCESS') {
        console.log('✅ Authentication successful!');
        console.log('👤 User:', payload.user);
        
        // Wait a bit before sending ping
        setTimeout(() => {
          console.log('📤 Sending PING after 2 seconds...');
          ws.send(msgpack.encode(['PING', {}, Date.now()]));
        }, 2000);
        
      } else if (eventType === 'AUTH_FAILED') {
        console.log('❌ Authentication failed:', payload.error);
        
      } else if (eventType === 'AUTH_REQUIRED') {
        console.log('⚠️ Authentication required - this should not happen after AUTH_SUCCESS');
        
      } else if (eventType === 'PONG') {
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

debugTest().catch(console.error);
