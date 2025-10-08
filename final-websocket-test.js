/**
 * Final WebSocket Authentication Test
 * Comprehensive test of the secure WebSocket authentication system
 */

const WebSocket = require('ws');
const msgpack = require('msgpack-lite');
const jwt = require('jsonwebtoken');

async function runComprehensiveTest() {
  console.log('🧪 COMPREHENSIVE WEBSOCKET AUTHENTICATION TEST');
  console.log('=' .repeat(60));
  
  // Test 1: Unauthenticated connection should be challenged
  console.log('\n🔍 Test 1: Unauthenticated Connection');
  await testUnauthenticatedConnection();
  
  // Test 2: Invalid authentication should be rejected
  console.log('\n🔍 Test 2: Invalid Authentication');
  await testInvalidAuthentication();
  
  // Test 3: Valid authentication should succeed
  console.log('\n🔍 Test 3: Valid Authentication');
  await testValidAuthentication();
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ ALL TESTS COMPLETED!');
}

async function testUnauthenticatedConnection() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3001/auth');
    let challengeReceived = false;
    
    ws.on('open', () => {
      console.log('  ✅ Connection opened');
    });
    
    ws.on('message', (data) => {
      const [eventType, payload] = msgpack.decode(data);
      console.log('  📨 Received:', eventType);
      
      if (eventType === 'AUTH_CHALLENGE') {
        console.log('  ✅ PASS: Received authentication challenge');
        challengeReceived = true;
        ws.close();
      }
    });
    
    ws.on('close', () => {
      if (challengeReceived) {
        console.log('  ✅ PASS: Connection properly closed after challenge');
      } else {
        console.log('  ❌ FAIL: No challenge received');
      }
      resolve();
    });
    
    ws.on('error', (error) => {
      console.log('  ❌ ERROR:', error.message);
      resolve();
    });
    
    // Timeout after 3 seconds
    setTimeout(() => {
      if (!challengeReceived) {
        console.log('  ❌ FAIL: Timeout waiting for challenge');
        ws.close();
      }
    }, 3000);
  });
}

async function testInvalidAuthentication() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3001/auth');
    let authFailed = false;
    
    ws.on('open', () => {
      console.log('  ✅ Connection opened');
      
      // Send invalid authentication
      const invalidAuth = {
        walletAddress: 'invalid-wallet',
        jwtToken: 'invalid-token'
      };
      
      ws.send(msgpack.encode(['AUTH_LOGIN', invalidAuth, Date.now()]));
    });
    
    ws.on('message', (data) => {
      const [eventType, payload] = msgpack.decode(data);
      console.log('  📨 Received:', eventType);
      
      if (eventType === 'AUTH_FAILED') {
        console.log('  ✅ PASS: Invalid authentication was rejected');
        authFailed = true;
        ws.close();
      }
    });
    
    ws.on('close', () => {
      if (authFailed) {
        console.log('  ✅ PASS: Connection closed after auth failure');
      } else {
        console.log('  ❌ FAIL: No auth failure received');
      }
      resolve();
    });
    
    ws.on('error', (error) => {
      console.log('  ❌ ERROR:', error.message);
      resolve();
    });
    
    // Timeout after 3 seconds
    setTimeout(() => {
      if (!authFailed) {
        console.log('  ❌ FAIL: Timeout waiting for auth failure');
        ws.close();
      }
    }, 3000);
  });
}

async function testValidAuthentication() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3001/auth');
    let authSuccess = false;
    let pingPong = false;
    
    ws.on('open', () => {
      console.log('  ✅ Connection opened');
    });
    
    ws.on('message', (data) => {
      const [eventType, payload] = msgpack.decode(data);
      console.log('  📨 Received:', eventType);
      
      if (eventType === 'AUTH_CHALLENGE') {
        console.log('  🔐 Sending valid authentication...');
        
        // Create valid JWT token
        const testWalletAddress = '6B1S6TrQwm1Wrt2MdcreqWDrmJ6tCKcZSUiu8GZjCFdA';
        const testJwtToken = jwt.sign(
          { walletAddress: testWalletAddress },
          process.env.JWT_SECRET || 'your-secret-key',
          { expiresIn: '1h' }
        );
        
        const validAuth = {
          walletAddress: testWalletAddress,
          jwtToken: testJwtToken
        };
        
        ws.send(msgpack.encode(['AUTH_LOGIN', validAuth, Date.now()]));
        
      } else if (eventType === 'AUTH_SUCCESS') {
        console.log('  ✅ PASS: Authentication successful');
        console.log('  👤 User:', payload.user.username);
        authSuccess = true;
        
        // Test ping/pong
        console.log('  📤 Testing ping/pong...');
        ws.send(msgpack.encode(['PING', {}, Date.now()]));
        
      } else if (eventType === 'PONG') {
        console.log('  ✅ PASS: Ping/pong working correctly');
        pingPong = true;
        
        // Close connection
        setTimeout(() => {
          ws.close();
        }, 500);
        
      } else if (eventType === 'AUTH_FAILED') {
        console.log('  ❌ FAIL: Valid authentication was rejected');
        ws.close();
      }
    });
    
    ws.on('close', () => {
      if (authSuccess && pingPong) {
        console.log('  ✅ PASS: Full authentication and messaging flow working');
      } else if (authSuccess) {
        console.log('  ⚠️  PARTIAL: Auth worked but ping/pong failed');
      } else {
        console.log('  ❌ FAIL: Authentication failed');
      }
      resolve();
    });
    
    ws.on('error', (error) => {
      console.log('  ❌ ERROR:', error.message);
      resolve();
    });
    
    // Timeout after 5 seconds
    setTimeout(() => {
      if (!authSuccess) {
        console.log('  ❌ FAIL: Timeout waiting for authentication');
        ws.close();
      }
    }, 5000);
  });
}

// Run the comprehensive test
runComprehensiveTest().catch(console.error);
