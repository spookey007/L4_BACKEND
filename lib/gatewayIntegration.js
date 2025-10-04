// Gateway integration for existing server.js
const Gateway = require('./gateway');
const { prisma } = require('./prisma');
const redis = require('./redis');

// Create a wrapper that integrates with your existing server
class ServerGateway {
  constructor(server, options = {}) {
    this.server = server;
    this.gateway = new Gateway({
      maxConnections: options.maxConnections || 2500,
      heartbeatInterval: options.heartbeatInterval || 30000,
      messageBatchSize: options.messageBatchSize || 100,
      ...options
    });
    
    this.setupGatewayHandlers();
  }

  setupGatewayHandlers() {
    // Handle new connections
    this.gateway.on('connection', (connection) => {
      console.log('🔌 [GATEWAY] New connection:', {
        connectionId: connection.id,
        userId: connection.userId,
        shardId: connection.shardId
      });
    });

    // Handle disconnections
    this.gateway.on('disconnection', (connection, reason) => {
      console.log('🔌 [GATEWAY] Connection closed:', {
        connectionId: connection.id,
        userId: connection.userId,
        reason
      });
    });
  }

  // Handle WebSocket connections through gateway
  handleConnection(ws, req) {
    this.gateway.handleConnection(ws, req);
  }

  // Broadcast to channel using gateway
  async broadcastToChannel(channelId, eventType, payload, excludeUserId = null) {
    return this.gateway.broadcastToChannel(channelId, eventType, payload, excludeUserId);
  }

  // Get connection metrics
  getMetrics() {
    return {
      totalConnections: this.gateway.connections.size,
      activeConnections: this.gateway.connections.size,
      messageQueueSize: this.gateway.messageQueue.length,
      uptime: process.uptime()
    };
  }

  // Graceful shutdown
  async shutdown() {
    console.log('🛑 [GATEWAY] Starting graceful shutdown...');
    await this.gateway.shutdown();
    console.log('✅ [GATEWAY] Shutdown complete');
  }
}

module.exports = ServerGateway;
