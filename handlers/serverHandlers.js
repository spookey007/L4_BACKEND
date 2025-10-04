const { prisma } = require('../lib/prisma');

// Database connection initialization
async function initializeDatabase() {
  try {
    console.log('🔌 [DATABASE] Initializing database connection...');
    
    // Test database connection
    await prisma.$connect();
    console.log('✅ [DATABASE] Database connected successfully');
    
    // Test a simple query to ensure database is working
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ [DATABASE] Database query test successful');
    
    return true;
  } catch (error) {
    console.error('❌ [DATABASE] Failed to connect to database:', error);
    console.error('❌ [DATABASE] Error details:', {
      message: error.message,
      code: error.code,
      meta: error.meta
    });
    return false;
  }
}

// Database health check
async function checkDatabaseHealth() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'healthy', timestamp: new Date().toISOString() };
  } catch (error) {
    console.error('❌ [DATABASE] Health check failed:', error);
    return { 
      status: 'unhealthy', 
      error: error.message, 
      timestamp: new Date().toISOString() 
    };
  }
}

// Initialize server based on environment
async function initializeServer() {
  const dbConnected = await initializeDatabase();
  
  if (!dbConnected) {
    console.error('❌ [SERVER] Failed to connect to database. Server will not start.');
    process.exit(1);
  }
  
  console.log('🚀 [SERVER] Starting WebSocket server...');
  return true;
}

module.exports = {
  initializeDatabase,
  checkDatabaseHealth,
  initializeServer
};
