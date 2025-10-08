/**
 * WebSocket Authentication Middleware
 * Handles JWT authentication for WebSocket connections
 */

const jwt = require('jsonwebtoken');
const msgpack = require('msgpack-lite');
const { prisma } = require('./prisma');
const encryptionService = require('./encryption');

class WebSocketAuth {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || 'K9x2pLmclear!nR6fWbY7jDcH4sTqZ5eNwVrA1uFgB9oIzX0MlPdS';
    this.authTimeout = 10000; // 10 seconds
    this.pendingConnections = new Map(); // Store pending connections
    console.log('🔐 [AUTH] WebSocketAuth initialized with JWT secret:', this.jwtSecret?.substring(0, 10) + '...');
  }

  /**
   * Validate JWT token and extract wallet address
   */
  validateJWTToken(token) {
    try {
      // Clean up the token - remove extra padding and whitespace
      const cleanToken = token?.trim().replace(/=+$/, '');
      
      console.log('🔐 [AUTH] Validating JWT token:', {
        originalLength: token?.length,
        cleanedLength: cleanToken?.length,
        tokenStart: cleanToken?.substring(0, 20) + '...',
        jwtSecret: this.jwtSecret?.substring(0, 10) + '...',
        fullJwtSecret: this.jwtSecret
      });
      
      const decoded = jwt.verify(cleanToken, this.jwtSecret);
      console.log('✅ [AUTH] JWT validation successful:', {
        walletAddress: decoded.walletAddress,
        iat: new Date(decoded.iat * 1000).toISOString(),
        exp: new Date(decoded.exp * 1000).toISOString(),
        nonce: decoded.nonce,
        sessionId: decoded.sessionId
      });
      
      // Check if token has already been used (one-time use)
      // Use in-memory tracking instead of Redis for simplicity
      if (!this.usedTokens) {
        this.usedTokens = new Map();
      }
      
      const tokenKey = decoded.nonce;
      if (this.usedTokens.has(tokenKey)) {
        console.log('❌ [AUTH] Token already used - rejecting authentication:', {
          nonce: decoded.nonce,
          walletAddress: decoded.walletAddress
        });
        return {
          isValid: false,
          error: 'Token already used'
        };
      }
      
      // Mark token as used (one-time use)
      this.usedTokens.set(tokenKey, Date.now());
      
      // Clean up old tokens (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      for (const [key, timestamp] of this.usedTokens.entries()) {
        if (timestamp < fiveMinutesAgo) {
          this.usedTokens.delete(key);
        }
      }
      
      return {
        isValid: true,
        walletAddress: decoded.walletAddress,
        iat: decoded.iat,
        exp: decoded.exp
      };
    } catch (error) {
      console.log('❌ [AUTH] JWT validation failed:', {
        error: error.message,
        originalLength: token?.length,
        cleanedLength: token?.trim().replace(/=+$/, '')?.length,
        tokenStart: token?.substring(0, 20) + '...',
        jwtSecret: this.jwtSecret?.substring(0, 10) + '...'
      });
      return {
        isValid: false,
        error: error.message
      };
    }
  }

  /**
   * Validate authentication payload
   */
  validateAuthPayload(payload) {
    if (!payload || !payload.walletAddress || !payload.jwtToken) {
      return {
        isValid: false,
        error: 'Missing required authentication fields'
      };
    }

    const jwtResult = this.validateJWTToken(payload.jwtToken);
    if (!jwtResult.isValid) {
      return {
        isValid: false,
        error: 'Invalid JWT token'
      };
    }

    // Verify wallet address matches JWT
    if (jwtResult.walletAddress !== payload.walletAddress) {
      return {
        isValid: false,
        error: 'Wallet address mismatch'
      };
    }

    return {
      isValid: true,
      walletAddress: payload.walletAddress,
      jwtData: jwtResult
    };
  }

  /**
   * Handle WebSocket connection with authentication
   */
  async handleConnection(ws, req) {
    const connectionId = this.generateConnectionId();
    
    console.log('🔌 [AUTH] New WebSocket connection attempt:', {
      connectionId,
      url: req.url,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
      ip: req.socket.remoteAddress
    });

    // Store pending connection
    this.pendingConnections.set(connectionId, {
      ws,
      req,
      startTime: Date.now(),
      authenticated: false
    });

    // Set up authentication timeout
    const authTimeout = setTimeout(() => {
      this.handleAuthTimeout(connectionId);
    }, this.authTimeout);

    // Return a Promise that resolves when authentication is complete
    return new Promise((resolve, reject) => {
      // Handle authentication message
      ws.on('message', async (data) => {
        try {
          // Get current connection from pendingConnections
          const currentConnection = this.pendingConnections.get(connectionId);
          
          // Handle both JSON and MessagePack data
          let eventType, payload, timestamp;
          
          if (Buffer.isBuffer(data)) {
            // Try MessagePack first
            try {
              const decoded = msgpack.decode(data);
              if (Array.isArray(decoded) && decoded.length >= 2) {
                [eventType, payload, timestamp] = decoded;
              } else {
                throw new Error('Invalid MessagePack format');
              }
            } catch (msgpackError) {
              // Fall back to JSON
              try {
                const jsonData = JSON.parse(data.toString());
                eventType = jsonData.type;
                payload = jsonData.payload || jsonData;
                timestamp = Date.now();
              } catch (jsonError) {
                console.log('❌ [AUTH] Invalid data format:', { msgpackError: msgpackError.message, jsonError: jsonError.message });
                this.rejectUnauthenticated(connectionId, 'Invalid message format');
                return;
              }
            }
          } else {
            // Handle non-buffer data (shouldn't happen with WebSocket)
            console.log('❌ [AUTH] Received non-buffer data:', typeof data, data);
            this.rejectUnauthenticated(connectionId, 'Invalid message format - expected binary data');
            return;
          }
          
          console.log('🔐 [AUTH] Processing message:', {
            connectionId,
            eventType,
            hasConnection: !!currentConnection,
            isAuthenticated: currentConnection?.authenticated,
            pendingConnectionsCount: this.pendingConnections.size
          });
          
          // If connection is not found in pendingConnections, it's authenticated
          if (!currentConnection) {
            // Connection is authenticated, ignore this message (main server will handle it)
            return;
          }
          
          // Check if connection is already authenticated
          if (currentConnection.authenticated) {
            // Connection is authenticated, ignore this message (main server will handle it)
            return;
          }
          
          if (eventType === 'AUTH_LOGIN') {
            const authResult = await this.handleAuthLogin(connectionId, payload, authTimeout);
            if (authResult) {
              resolve(authResult);
            }
          } else {
            // Reject any non-auth messages before authentication
            this.rejectUnauthenticated(connectionId, 'Authentication required');
          }
        } catch (error) {
          console.error('❌ [AUTH] Error processing message:', error);
          this.rejectUnauthenticated(connectionId, 'Invalid message format');
        }
      });

      ws.on('close', (code, reason) => {
        console.log('🔌 [AUTH] Connection closed before authentication:', {
          connectionId,
          code,
          reason: reason?.toString()
        });
        this.cleanupConnection(connectionId);
        reject(new Error(`Connection closed before authentication (code: ${code})`));
      });

      ws.on('error', (error) => {
        console.error('❌ [AUTH] WebSocket error:', error);
        this.cleanupConnection(connectionId);
        reject(error);
      });

      // Send authentication challenge
      this.sendAuthChallenge(connectionId);
    });
  }

  /**
   * Send authentication challenge to client
   */
  sendAuthChallenge(connectionId) {
    const connection = this.pendingConnections.get(connectionId);
    if (!connection) return;

    const challenge = {
      type: 'AUTH_CHALLENGE',
      message: 'Please authenticate to continue',
      timeout: this.authTimeout,
      timestamp: Date.now()
    };

    try {
      connection.ws.send(msgpack.encode(['AUTH_CHALLENGE', challenge, Date.now()]));
      console.log('🔐 [AUTH] Sent authentication challenge to connection:', connectionId);
    } catch (error) {
      console.error('❌ [AUTH] Error sending auth challenge:', error);
      this.cleanupConnection(connectionId);
    }
  }

  /**
   * Handle authentication login attempt
   */
  async handleAuthLogin(connectionId, payload, authTimeout) {
    const connection = this.pendingConnections.get(connectionId);
    if (!connection) return;

    console.log('🔐 [AUTH] Processing authentication request:', {
      connectionId,
      walletAddress: payload?.walletAddress,
      hasJwtToken: !!payload?.jwtToken,
      timestamp: new Date().toISOString()
    });

    // Validate authentication payload
    const authResult = this.validateAuthPayload(payload);
    
    if (!authResult.isValid) {
      console.log('❌ [AUTH] Authentication failed:', {
        connectionId,
        walletAddress: payload?.walletAddress,
        reason: authResult.error
      });
      
      this.rejectAuthentication(connectionId, authResult.error);
      return;
    }

    try {
      // Find or create user
      let user = await prisma.user.findUnique({
        where: { walletAddress: authResult.walletAddress }
      });
      
      if (!user) {
        console.log('👤 [AUTH] Creating new user for wallet:', authResult.walletAddress);
        user = await prisma.user.create({
          data: {
            walletAddress: authResult.walletAddress,
            username: `User_${authResult.walletAddress.substring(0, 8)}`
          }
        });
      }

      // Clear authentication timeout
      clearTimeout(authTimeout);

      // Mark as authenticated
      connection.authenticated = true;
      connection.userId = user.id;
      connection.username = user.username || user.walletAddress;

      console.log('✅ [AUTH] Authentication successful:', {
        connectionId,
        userId: user.id,
        username: user.username,
        walletAddress: authResult.walletAddress
      });

      // Send success response
      this.sendAuthSuccess(connectionId, user);

      // Mark connection as authenticated to prevent further auth processing
      connection.authenticated = true;
      
      // Don't remove message listeners - let the main server add its own
      // The websocketAuth handler will ignore all messages after authentication
      
      // Remove from pending connections since it's now authenticated
      this.pendingConnections.delete(connectionId);

      // Return connection data for further processing
      return {
        connectionId,
        userId: user.id,
        username: user.username,
        walletAddress: authResult.walletAddress,
        ws: connection.ws,
        req: connection.req
      };

    } catch (error) {
      console.error('❌ [AUTH] Database error during authentication:', error);
      this.rejectAuthentication(connectionId, 'Database error during authentication');
    }
  }

  /**
   * Send authentication success response
   */
  sendAuthSuccess(connectionId, user) {
    const connection = this.pendingConnections.get(connectionId);
    if (!connection) return;

    console.log('✅ [AUTH] Sending encrypted authentication success to connection:', connectionId);

    try {
      // Create encrypted response in the old format
      const userData = {
        id: user.id,
        username: user.username,
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        role: user.role,
        isAdmin: user.role === 0,
        isVerified: user.isVerified,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        email: user.email,
        emailVerified: user.emailVerified,
        twitterHandle: user.twitterHandle,
        discordHandle: user.discordHandle,
        twitchHandle: user.twitchHandle,
        spotifyHandle: user.spotifyHandle,
        status: user.status || 'online',
        lastSeen: user.lastSeen,
        followerCount: user.followerCount || 0,
        followingCount: user.followingCount || 0
      };

      console.log('🔐 [AUTH] About to call encryption service...');
      console.log('🔐 [AUTH] User data:', JSON.stringify(userData, null, 2));
      
      const encryptedResponse = encryptionService.createEncryptedResponse(
        userData,
        'AUTH_LOGIN_RESPONSE',
        true
      );
      
      console.log('🔐 [AUTH] Encryption service call successful');

      console.log('🔐 [AUTH] Created encrypted response for user:', user.id);
      console.log('🔐 [AUTH] Encrypted response structure:', {
        type: encryptedResponse.type,
        success: encryptedResponse.success,
        encrypted: encryptedResponse.encrypted,
        hasData: !!encryptedResponse.data,
        hasEncrypted: !!encryptedResponse.data?.encrypted,
        hasIv: !!encryptedResponse.data?.iv,
        hasTag: !!encryptedResponse.data?.tag
      });

      // Send as JSON (not MessagePack for auth responses)
      connection.ws.send(JSON.stringify(encryptedResponse));
      console.log('✅ [AUTH] Encrypted authentication success sent successfully');
      console.log('🔐 [AUTH] Sent encrypted response:', JSON.stringify(encryptedResponse, null, 2));
    } catch (error) {
      console.error('❌ [AUTH] Failed to send encrypted authentication success:', error);
      
      // Fallback to unencrypted response
      const response = {
        type: 'AUTH_SUCCESS',
        user: {
          id: user.id,
          username: user.username,
          walletAddress: user.walletAddress
        },
        timestamp: Date.now()
      };
      connection.ws.send(msgpack.encode(['AUTH_SUCCESS', response, Date.now()]));
    }
  }

  /**
   * Reject authentication attempt
   */
  rejectAuthentication(connectionId, reason) {
    const connection = this.pendingConnections.get(connectionId);
    if (!connection) return;

    const response = {
      type: 'AUTH_FAILED',
      error: reason,
      timestamp: Date.now()
    };

    try {
      connection.ws.send(msgpack.encode(['AUTH_FAILED', response, Date.now()]));
      console.log('❌ [AUTH] Sent authentication failure to connection:', connectionId);
    } catch (error) {
      console.error('❌ [AUTH] Error sending auth failure:', error);
    }

    // Close connection after a short delay
    setTimeout(() => {
      this.cleanupConnection(connectionId);
      if (connection.ws.readyState === connection.ws.OPEN) {
        connection.ws.close(1008, 'Authentication failed');
      }
    }, 1000);
  }

  /**
   * Reject unauthenticated message
   */
  rejectUnauthenticated(connectionId, reason) {
    const connection = this.pendingConnections.get(connectionId);
    if (!connection) return;

    const response = {
      type: 'AUTH_REQUIRED',
      error: reason,
      timestamp: Date.now()
    };

    try {
      connection.ws.send(msgpack.encode(['AUTH_REQUIRED', response, Date.now()]));
    } catch (error) {
      console.error('❌ [AUTH] Error sending auth required:', error);
    }
  }

  /**
   * Handle authentication timeout
   */
  handleAuthTimeout(connectionId) {
    const connection = this.pendingConnections.get(connectionId);
    if (!connection || connection.authenticated) return;

    console.log('⏰ [AUTH] Authentication timeout for connection:', connectionId);
    
    this.rejectAuthentication(connectionId, 'Authentication timeout');
  }

  /**
   * Clean up connection
   */
  cleanupConnection(connectionId) {
    const connection = this.pendingConnections.get(connectionId);
    if (connection) {
      console.log('🧹 [AUTH] Cleaning up connection:', connectionId);
      this.pendingConnections.delete(connectionId);
    }
  }

  /**
   * Generate unique connection ID
   */
  generateConnectionId() {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get connection by ID
   */
  getConnection(connectionId) {
    return this.pendingConnections.get(connectionId);
  }

  /**
   * Check if connection is authenticated
   */
  isAuthenticated(connectionId) {
    const connection = this.pendingConnections.get(connectionId);
    return connection ? connection.authenticated : false;
  }

  /**
   * Get all pending connections (for monitoring)
   */
  getPendingConnections() {
    return Array.from(this.pendingConnections.entries()).map(([id, conn]) => ({
      id,
      startTime: conn.startTime,
      authenticated: conn.authenticated,
      duration: Date.now() - conn.startTime
    }));
  }
}

module.exports = new WebSocketAuth();
