// WebSocket Configuration
module.exports = {
  // Connection settings
  connection: {
    maxConnections: 10000,
    connectionTimeout: 60000, // 60 seconds
    heartbeatInterval: 25000, // 25 seconds
    maxReconnectAttempts: 15,
    reconnectBaseDelay: 1000,
    reconnectMaxDelay: 30000,
  },
  
  // Message settings
  message: {
    maxPayloadSize: 16 * 1024 * 1024, // 16MB
    maxQueueSize: 1000,
    queueTimeout: 300000, // 5 minutes
  },
  
  // Heartbeat settings
  heartbeat: {
    clientInterval: 45000, // 45 seconds
    clientTimeout: 15000,  // 15 seconds
    serverInterval: 25000, // 25 seconds
    serverTimeout: 60000,  // 60 seconds
  },
  
  // Error handling
  error: {
    maxRetries: 3,
    retryDelay: 1000,
    logLevel: 'info', // 'debug', 'info', 'warn', 'error'
  },
  
  // Performance monitoring
  performance: {
    enableMetrics: true,
    metricsInterval: 30000, // 30 seconds
    maxConnectionsPerUser: 3,
  }
};
