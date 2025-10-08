#!/usr/bin/env node

/**
 * Clear Redis cache using existing backend Redis connection
 * Usage: node clear-cache.js
 */

const redis = require('./lib/redis');

async function clearCache() {
  try {
    console.log('🔍 Testing Redis connection...');
    const stats = await redis.getStats();
    console.log('📊 Redis stats:', stats);

    if (!stats.connected) {
      console.log('⚠️ Redis not connected, clearing memory cache only');
    }

    console.log('🗑️ Clearing all channel caches...');
    const deletedCount = await redis.clearAllChannelCaches();
    console.log(`✅ Cleared ${deletedCount} cache entries`);

    console.log('📊 Final stats:', await redis.getStats());
    console.log('✅ Cache clearing completed!');
    
  } catch (error) {
    console.error('❌ Error clearing cache:', error);
  }
}

// Run the script
clearCache();
