/**
 * Simple WebSocket Authentication Test
 */

const WebSocket = require('ws');
const msgpack = require('msgpack-lite');
const jwt = require('jsonwebtoken');

async function testConnection() {
  console.log('🔌 Testing WebSocket connection...');
  
  const ws = new WebSocket('ws://localhost:3001/auth');
  
  ws.on('open', () => {
    console.log('✅ Connected to WebSocket server');
  });
  
  ws.on('message', (data) => {
    try {
      const [eventType, payload] = msgpack.decode(data);
      console.log('📨 Received:', eventType, payload);
      
      if (eventType === 'AUTH_CHALLENGE') {
        console.log('🔐 Received authentication challenge, sending auth...');
        
        // Create a valid JWT token
        const testWalletAddress = '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA';
        const testJwtToken = jwt.sign(
          { walletAddress: testWalletAddress },
          process.env.JWT_SECRET || 'your-secret-key',
          { expiresIn: '1h' }
        );
        
        // Send authentication
        const authPayload = {
          walletAddress: testWalletAddress,
          jwtToken: testJwtToken
        };
        
        ws.send(msgpack.encode(['AUTH_LOGIN', authPayload, Date.now()]));
      } else if (eventType === 'AUTH_SUCCESS') {
        console.log('✅ Authentication successful!');
        console.log('👤 User:', payload.user);
        
        // Test sending a ping
        console.log('📤 Sending ping...');
        ws.send(msgpack.encode(['PING', {}, Date.now()]));
        
        // Close after a short delay
        setTimeout(() => {
          console.log('🔌 Closing connection...');
          ws.close();
        }, 2000);
      } else if (eventType === 'AUTH_FAILED') {
        console.log('❌ Authentication failed:', payload.error);
        ws.close();
      } else if (eventType === 'PONG') {
        console.log('✅ Received pong - message handling works!');
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

testConnection().catch(console.error);
