const { prisma } = require('../lib/prisma');
const redis = require('../lib/redis');

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      queries: [],
      cacheHits: 0,
      cacheMisses: 0,
      avgResponseTime: 0,
      totalRequests: 0
    };
  }

  async startMonitoring() {
    console.log('🔍 [PERFORMANCE] Starting performance monitoring...');
    
    // Monitor every 30 seconds
    setInterval(async () => {
      await this.collectMetrics();
      this.logMetrics();
    }, 30000);
  }

  async collectMetrics() {
    try {
      // Get database connection pool stats
      const dbStats = await prisma.$queryRaw`
        SELECT 
          count(*) as total_connections,
          count(*) FILTER (WHERE state = 'active') as active_connections,
          count(*) FILTER (WHERE state = 'idle') as idle_connections
        FROM pg_stat_activity 
        WHERE datname = current_database()
      `;

      // Get Redis stats
      const redisStats = await redis.getStats();
      
      // Get slow query log (if available)
      let slowQueries = [];
      try {
        slowQueries = await prisma.$queryRaw`
          SELECT 
            query,
            mean_exec_time,
            calls,
            total_exec_time
          FROM pg_stat_statements 
          WHERE mean_exec_time > 100 
          ORDER BY mean_exec_time DESC 
          LIMIT 10
        `;
      } catch (error) {
        // pg_stat_statements extension not available
        console.log('ℹ️ [PERFORMANCE] pg_stat_statements not available, skipping slow query analysis');
      }

      this.metrics.dbStats = dbStats[0];
      this.metrics.redisStats = redisStats;
      this.metrics.slowQueries = slowQueries;
      
    } catch (error) {
      console.error('❌ [PERFORMANCE] Error collecting metrics:', error);
    }
  }

  logMetrics() {
    console.log('📊 [PERFORMANCE] Metrics Report:');
    console.log('  Database:', {
      totalConnections: this.metrics.dbStats?.total_connections || 'N/A',
      activeConnections: this.metrics.dbStats?.active_connections || 'N/A',
      idleConnections: this.metrics.dbStats?.idle_connections || 'N/A'
    });
    
    console.log('  Cache:', {
      hits: this.metrics.cacheHits,
      misses: this.metrics.cacheMisses,
      hitRate: this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100 || 0
    });

    if (this.metrics.slowQueries && this.metrics.slowQueries.length > 0) {
      console.log('  🐌 Slow Queries:');
      this.metrics.slowQueries.forEach((query, index) => {
        console.log(`    ${index + 1}. ${query.query.substring(0, 100)}... (${query.mean_exec_time}ms, ${query.calls} calls)`);
      });
    }
  }

  recordQuery(query, duration) {
    this.metrics.queries.push({ query, duration, timestamp: Date.now() });
    this.metrics.totalRequests++;
    
    // Keep only last 1000 queries
    if (this.metrics.queries.length > 1000) {
      this.metrics.queries = this.metrics.queries.slice(-1000);
    }
    
    // Update average response time
    const totalTime = this.metrics.queries.reduce((sum, q) => sum + q.duration, 0);
    this.metrics.avgResponseTime = totalTime / this.metrics.queries.length;
  }

  recordCacheHit() {
    this.metrics.cacheHits++;
  }

  recordCacheMiss() {
    this.metrics.cacheMisses++;
  }

  getMetrics() {
    return {
      ...this.metrics,
      cacheHitRate: this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100 || 0
    };
  }
}

module.exports = new PerformanceMonitor();
