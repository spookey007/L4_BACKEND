#!/usr/bin/env node

/**
 * Clear Redis cache with proper connection waiting
 * Usage: node clear-cache-better.js
 */

const redis = require('./lib/redis');

async function clearCache() {
  try {
    console.log('🔍 Waiting for Redis connection...');
    
    // Wait a bit for Redis to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('🔍 Testing Redis connection...');
    const stats = await redis.getStats();
    console.log('📊 Redis stats:', stats);

    if (!stats.connected) {
      console.log('⚠️ Redis not connected, clearing memory cache only');
    } else {
      console.log('✅ Redis connected successfully!');
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
