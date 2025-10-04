// Discord-inspired Gateway implementation
const EventEmitter = require('events');
const { WebSocketServer } = require('ws');
const msgpack = require('msgpack-lite');
const redis = require('./redis');
const { prisma } = require('./prisma');

class Gateway extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxConnections: options.maxConnections || 2500, // Discord's shard limit
      heartbeatInterval: options.heartbeatInterval || 30000,
      connectionTimeout: options.connectionTimeout || 60000,
      messageBatchSize: options.messageBatchSize || 100,
      messageBatchDelay: options.messageBatchDelay || 100,
      ...options
    };
    
    this.connections = new Map();
    this.messageQueue = [];
    this.batchProcessor = null;
    this.heartbeatInterval = null;
    this.connectionMetrics = {
      totalConnections: 0,
      activeConnections: 0,
      messagesProcessed: 0,
      lastReset: Date.now()
    };
    
    this.startBatchProcessor();
    this.startHeartbeat();
    this.startMetricsCollection();
  }

  // Discord-style connection management
  async handleConnection(ws, req) {
    const connectionId = this.generateConnectionId();
    const userId = await this.authenticateConnection(req);
    
    if (!userId) {
      ws.close(1008, 'Authentication failed');
      return;
    }

    // Check shard capacity
    if (this.connections.size >= this.options.maxConnections) {
      ws.close(1013, 'Server overloaded');
      return;
    }

    const connection = {
      id: connectionId,
      ws,
      userId,
      lastHeartbeat: Date.now(),
      lastActivity: Date.now(),
      messageQueue: [],
      isAlive: true,
      shardId: this.calculateShardId(userId),
      metadata: {
        userAgent: req.headers['user-agent'],
        ip: req.connection.remoteAddress,
        connectedAt: Date.now()
      }
    };

    this.connections.set(connectionId, connection);
    this.connectionMetrics.activeConnections++;
    this.connectionMetrics.totalConnections++;

    // Set up connection handlers
    this.setupConnectionHandlers(connection);
    
    // Send initial connection confirmation
    this.sendToConnection(connection, 'CONNECTION_ESTABLISHED', {
      connectionId,
      shardId: connection.shardId,
      heartbeatInterval: this.options.heartbeatInterval
    });

    console.log(`🔌 [GATEWAY] Connection established:`, {
      connectionId,
      userId,
      shardId: connection.shardId,
      totalConnections: this.connections.size
    });

    this.emit('connection', connection);
  }

  // Discord-style sharding
  calculateShardId(userId) {
    // Simple consistent hashing - in production, use a proper hash ring
    const hash = this.simpleHash(userId);
    return hash % 4; // 4 shards for example
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  // Discord-style message batching
  startBatchProcessor() {
    this.batchProcessor = setInterval(() => {
      if (this.messageQueue.length > 0) {
        this.processMessageBatch();
      }
    }, this.options.messageBatchDelay);
  }

  async processMessageBatch() {
    if (this.messageQueue.length === 0) return;

    const batch = this.messageQueue.splice(0, this.options.messageBatchSize);
    
    try {
      // Process messages in parallel
      const promises = batch.map(message => this.processMessage(message));
      await Promise.allSettled(promises);
      
      this.connectionMetrics.messagesProcessed += batch.length;
    } catch (error) {
      console.error('❌ [GATEWAY] Batch processing error:', error);
    }
  }

  // Discord-style message processing
  async processMessage(message) {
    const { connectionId, eventType, payload, timestamp } = message;
    const connection = this.connections.get(connectionId);
    
    if (!connection || !connection.isAlive) {
      return;
    }

    try {
      // Update activity
      connection.lastActivity = Date.now();
      
      // Route message based on type
      switch (eventType) {
        case 'PING':
          await this.handlePing(connection, payload);
          break;
        case 'SEND_MESSAGE':
          await this.handleSendMessage(connection, payload);
          break;
        case 'FETCH_MESSAGES':
          await this.handleFetchMessages(connection, payload);
          break;
        default:
          console.log(`⚠️ [GATEWAY] Unknown event type: ${eventType}`);
      }
    } catch (error) {
      console.error(`❌ [GATEWAY] Message processing error:`, error);
      this.sendToConnection(connection, 'ERROR', { message: 'Message processing failed' });
    }
  }

  // Discord-style heartbeat management
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.performHeartbeat();
    }, this.options.heartbeatInterval);
  }

  async performHeartbeat() {
    const now = Date.now();
    const deadConnections = [];

    for (const [connectionId, connection] of this.connections) {
      const timeSinceLastHeartbeat = now - connection.lastHeartbeat;
      const timeSinceLastActivity = now - connection.lastActivity;

      // Check if connection is dead
      if (timeSinceLastHeartbeat > this.options.connectionTimeout || 
          timeSinceLastActivity > this.options.connectionTimeout) {
        deadConnections.push(connectionId);
        continue;
      }

      // Send heartbeat to alive connections
      if (connection.isAlive && connection.ws.readyState === 1) {
        try {
          this.sendToConnection(connection, 'HEARTBEAT', {
            timestamp: now,
            serverTime: now
          });
        } catch (error) {
          console.error(`❌ [GATEWAY] Heartbeat send error:`, error);
          deadConnections.push(connectionId);
        }
      }
    }

    // Clean up dead connections
    deadConnections.forEach(connectionId => {
      this.closeConnection(connectionId, 'Heartbeat timeout');
    });
  }

  // Discord-style connection cleanup
  closeConnection(connectionId, reason = 'Unknown') {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.isAlive = false;
    this.connections.delete(connectionId);
    this.connectionMetrics.activeConnections--;

    if (connection.ws.readyState === 1) {
      connection.ws.close(1000, reason);
    }

    console.log(`🔌 [GATEWAY] Connection closed:`, {
      connectionId,
      userId: connection.userId,
      reason,
      totalConnections: this.connections.size
    });

    this.emit('disconnection', connection, reason);
  }

  // Discord-style message queuing
  queueMessage(connectionId, eventType, payload) {
    const message = {
      connectionId,
      eventType,
      payload,
      timestamp: Date.now()
    };

    this.messageQueue.push(message);

    // Prevent queue from growing too large
    if (this.messageQueue.length > 10000) {
      console.warn('⚠️ [GATEWAY] Message queue too large, dropping old messages');
      this.messageQueue = this.messageQueue.slice(-5000);
    }
  }

  // Discord-style message broadcasting
  async broadcastToChannel(channelId, eventType, payload, excludeUserId = null) {
    try {
      // Get channel members from database
      const members = await prisma.channelMember.findMany({
        where: { channelId },
        select: { userId: true }
      });

      const message = msgpack.encode([eventType, payload, Date.now()]);
      let sentCount = 0;

      // Send to all connected members
      for (const [connectionId, connection] of this.connections) {
        if (connection.userId === excludeUserId) continue;
        if (!members.some(m => m.userId === connection.userId)) continue;
        if (!connection.isAlive) continue;

        try {
          connection.ws.send(message);
          sentCount++;
        } catch (error) {
          console.error(`❌ [GATEWAY] Broadcast error:`, error);
          this.closeConnection(connectionId, 'Send error');
        }
      }

      console.log(`📢 [GATEWAY] Broadcast complete:`, {
        channelId,
        eventType,
        sentTo: sentCount,
        totalMembers: members.length
      });
    } catch (error) {
      console.error('❌ [GATEWAY] Broadcast error:', error);
    }
  }

  // Discord-style metrics collection
  startMetricsCollection() {
    setInterval(() => {
      const now = Date.now();
      const uptime = now - this.connectionMetrics.lastReset;
      
      console.log(`📊 [GATEWAY] Metrics:`, {
        activeConnections: this.connectionMetrics.activeConnections,
        totalConnections: this.connectionMetrics.totalConnections,
        messagesProcessed: this.connectionMetrics.messagesProcessed,
        queueSize: this.messageQueue.length,
        uptime: Math.round(uptime / 1000) + 's'
      });

      // Reset counters
      this.connectionMetrics.messagesProcessed = 0;
      this.connectionMetrics.lastReset = now;
    }, 30000); // Every 30 seconds
  }

  // Utility methods
  generateConnectionId() {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async authenticateConnection(req) {
    // Your existing authentication logic
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (!token) return null;
    
    // Validate token and return userId
    // This should match your existing auth logic
    try {
      const user = await this.validateToken(token);
      return user?.id || null;
    } catch (error) {
      console.error('❌ [GATEWAY] Auth error:', error);
      return null;
    }
  }

  async validateToken(token) {
    // Your existing token validation logic
    // This should match what you have in server.js
    return null; // Placeholder
  }

  sendToConnection(connection, eventType, payload) {
    if (!connection.isAlive || connection.ws.readyState !== 1) return;
    
    try {
      const message = msgpack.encode([eventType, payload, Date.now()]);
      connection.ws.send(message);
    } catch (error) {
      console.error(`❌ [GATEWAY] Send error:`, error);
      this.closeConnection(connection.id, 'Send error');
    }
  }

  setupConnectionHandlers(connection) {
    connection.ws.on('message', (data) => {
      try {
        const [eventType, payload] = msgpack.decode(new Uint8Array(data));
        this.queueMessage(connection.id, eventType, payload);
      } catch (error) {
        console.error('❌ [GATEWAY] Message decode error:', error);
      }
    });

    connection.ws.on('close', (code, reason) => {
      this.closeConnection(connection.id, reason.toString());
    });

    connection.ws.on('error', (error) => {
      console.error(`❌ [GATEWAY] Connection error:`, error);
      this.closeConnection(connection.id, 'WebSocket error');
    });
  }

  // Discord-style graceful shutdown
  async shutdown() {
    console.log('🛑 [GATEWAY] Starting graceful shutdown...');
    
    // Stop accepting new connections
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.batchProcessor) {
      clearInterval(this.batchProcessor);
    }

    // Close all connections gracefully
    const closePromises = Array.from(this.connections.values()).map(connection => {
      return new Promise(resolve => {
        if (connection.ws.readyState === 1) {
          connection.ws.close(1000, 'Server shutdown');
        }
        resolve();
      });
    });

    await Promise.all(closePromises);
    console.log('✅ [GATEWAY] Shutdown complete');
  }
}

module.exports = Gateway;
