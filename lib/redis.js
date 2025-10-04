const { Redis } = require('@upstash/redis');

class RedisCache {
  constructor() {
    this.redis = null;
    this.isConnected = false;
    this.memoryCache = new Map(); // Fallback in-memory cache
    this.memoryCacheExpiry = new Map(); // TTL for memory cache
    this.init();
  }

  async init() {
    try {
      // Wait a bit for environment variables to be fully loaded
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check for different Redis configuration formats
      const redisUrl = process.env.REDIS_URL;
      const restUrl = process.env.UPSTASH_REDIS_REST_URL;
      const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      
      if (redisUrl) {
        // Parse Redis URL format: rediss://default:password@endpoint:port
        const url = new URL(redisUrl);
        const host = url.hostname;
        const password = url.password;
        
        // For Upstash, use the REST API format
        const upstashUrl = `https://${host}`;
        
        this.redis = new Redis({
          url: upstashUrl,
          token: password
        });
        
        console.log('✅ [REDIS] Using Redis URL format');
        console.log('🔍 [REDIS] URL:', upstashUrl);
        console.log('🔍 [REDIS] Token:', password ? '***' : 'none');
      } else if (restUrl && restToken) {
        // Use individual credentials
        this.redis = new Redis({
          url: restUrl,
          token: restToken
        });
        
        console.log('✅ [REDIS] Using individual credentials');
      } else {
        // Try fromEnv as fallback
        this.redis = Redis.fromEnv();
        console.log('✅ [REDIS] Using fromEnv()');
      }
      
      // Test connection with a simple ping and retry logic
      console.log('🔍 [REDIS] Testing connection...');
      let retries = 3;
      let lastError = null;
      
      while (retries > 0) {
        try {
          const pingResult = await this.redis.ping();
          this.isConnected = true;
          console.log('✅ [REDIS] Connected to Upstash Redis, ping result:', pingResult);
          break;
        } catch (error) {
          lastError = error;
          retries--;
          console.log(`⚠️ [REDIS] Connection attempt failed, retries left: ${retries}`);
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      
      if (!this.isConnected) {
        throw lastError;
      }
      
    } catch (error) {
      console.error('❌ [REDIS] Failed to initialize Upstash Redis:', error);
      console.log('⚠️ [REDIS] Falling back to memory cache');
      this.isConnected = false;
    }
  }

  async get(key) {
    if (!this.isConnected) {
      // Fallback to memory cache
      return this.getFromMemoryCache(key);
    }
    try {
      console.log('🔍 [REDIS] Getting key:', key);
      const data = await this.redis.get(key);
      console.log('🔍 [REDIS] Retrieved data:', {
        exists: !!data,
        type: typeof data,
        isArray: Array.isArray(data),
        length: data?.length
      });
      return data;
    } catch (error) {
      console.error('❌ [REDIS] Get error, falling back to memory cache:', error);
      return this.getFromMemoryCache(key);
    }
  }

  getFromMemoryCache(key) {
    const expiry = this.memoryCacheExpiry.get(key);
    if (expiry && Date.now() > expiry) {
      this.memoryCache.delete(key);
      this.memoryCacheExpiry.delete(key);
      return null;
    }
    return this.memoryCache.get(key) || null;
  }

  async set(key, value, ttlSeconds = 300) {
    if (!this.isConnected) {
      // Fallback to memory cache
      this.setInMemoryCache(key, value, ttlSeconds);
      return true;
    }
    try {
      console.log('🔍 [REDIS] Setting key:', key, 'with TTL:', ttlSeconds);
      console.log('🔍 [REDIS] Value type:', typeof value, 'isArray:', Array.isArray(value), 'length:', value?.length);
      await this.redis.set(key, value, { ex: ttlSeconds });
      console.log('✅ [REDIS] Successfully set key:', key);
      
      // Track keys for invalidation (for channel messages)
      if (key.includes(':messages:')) {
        const channelId = key.split(':')[1];
        const setKey = `channel:${channelId}:message_keys`;
        await this.redis.sadd(setKey, key);
        await this.redis.expire(setKey, ttlSeconds);
      }
      
      return true;
    } catch (error) {
      console.error('❌ [REDIS] Set error, falling back to memory cache:', error);
      this.setInMemoryCache(key, value, ttlSeconds);
      return true;
    }
  }

  setInMemoryCache(key, value, ttlSeconds) {
    this.memoryCache.set(key, value);
    this.memoryCacheExpiry.set(key, Date.now() + (ttlSeconds * 1000));
  }

  async del(key) {
    if (!this.isConnected) {
      // Remove from memory cache
      this.memoryCache.delete(key);
      this.memoryCacheExpiry.delete(key);
      return true;
    }
    try {
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error('❌ [REDIS] Delete error:', error);
      return false;
    }
  }

  async mget(keys) {
    if (!this.isConnected) {
      // Fallback to memory cache
      return keys.map(key => this.getFromMemoryCache(key));
    }
    try {
      const data = await this.redis.mget(...keys);
      return data;
    } catch (error) {
      console.error('❌ [REDIS] MGet error:', error);
      return keys.map(key => this.getFromMemoryCache(key));
    }
  }

  async mset(keyValuePairs, ttlSeconds = 300) {
    if (!this.isConnected) {
      // Fallback to memory cache
      for (const [key, value] of keyValuePairs) {
        this.setInMemoryCache(key, value, ttlSeconds);
      }
      return true;
    }
    try {
      // Upstash Redis doesn't have pipeline, so we'll use individual sets
      for (const [key, value] of keyValuePairs) {
        await this.redis.set(key, value, { ex: ttlSeconds });
      }
      return true;
    } catch (error) {
      console.error('❌ [REDIS] MSet error:', error);
      return false;
    }
  }

  // Cache key generators
  getUserChannelsKey(userId) {
    return `user:${userId}:channels`;
  }

  getChannelMessagesKey(channelId, limit = 50, before = null) {
    const beforeStr = before ? `:${before}` : '';
    return `channel:${channelId}:messages:${limit}${beforeStr}`;
  }

  getChannelKey(channelId) {
    return `channel:${channelId}`;
  }

  getUserKey(userId) {
    return `user:${userId}`;
  }

  // Invalidate cache patterns
  async invalidateUserChannels(userId) {
    if (!this.isConnected) return;
    try {
      await this.del(this.getUserChannelsKey(userId));
    } catch (error) {
      console.error('❌ [REDIS] Invalidate user channels error:', error);
    }
  }

  async invalidateChannelMessages(channelId) {
    if (!this.isConnected) {
      // Remove from memory cache
      const pattern = `channel:${channelId}:messages:`;
      for (const [key] of this.memoryCache) {
        if (key.startsWith(pattern)) {
          this.memoryCache.delete(key);
          this.memoryCacheExpiry.delete(key);
        }
      }
      return;
    }
    try {
      // Upstash Redis doesn't support KEYS command, so we'll use a different approach
      // We'll track keys in a set for each channel
      const setKey = `channel:${channelId}:message_keys`;
      const keys = await this.redis.smembers(setKey);
      if (keys.length > 0) {
        await this.redis.del(...keys);
        await this.redis.del(setKey);
      }
    } catch (error) {
      console.error('❌ [REDIS] Invalidate channel messages error:', error);
    }
  }

  async invalidateChannel(channelId) {
    if (!this.isConnected) return;
    try {
      await this.del(this.getChannelKey(channelId));
      await this.invalidateChannelMessages(channelId);
    } catch (error) {
      console.error('❌ [REDIS] Invalidate channel error:', error);
    }
  }

  // Health check
  async ping() {
    if (!this.isConnected) return false;
    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('❌ [REDIS] Ping error:', error);
      return false;
    }
  }

  // Get cache statistics
  async getStats() {
    if (!this.isConnected) {
      return {
        connected: false,
        memoryCacheSize: this.memoryCache.size,
        memoryCacheKeys: Array.from(this.memoryCache.keys())
      };
    }
    
    try {
      // Upstash Redis doesn't support INFO command, so we'll use basic stats
      const stats = {
        connected: true,
        memoryCacheSize: this.memoryCache.size,
        memoryCacheKeys: Array.from(this.memoryCache.keys()),
        // Basic connection test
        pingResult: await this.redis.ping()
      };
      
      return stats;
    } catch (error) {
      console.error('❌ [REDIS] Stats error:', error);
      return {
        connected: false,
        error: error.message,
        memoryCacheSize: this.memoryCache.size,
        memoryCacheKeys: Array.from(this.memoryCache.keys())
      };
    }
  }

  // Clear all channel-related caches
  async clearAllChannelCaches() {
    if (!this.isConnected) {
      // Clear memory cache
      const keysToDelete = [];
      for (const key of this.memoryCache.keys()) {
        if (key.startsWith('channels:')) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => {
        this.memoryCache.delete(key);
        this.memoryCacheExpiry.delete(key);
      });
      console.log('🗑️ [REDIS] Cleared memory cache keys:', keysToDelete.length);
      return keysToDelete.length;
    }
    
    try {
      // For Upstash Redis, we need to use a different approach
      // Since there's no KEYS command, we'll track keys manually
      console.log('🗑️ [REDIS] Upstash Redis doesn\'t support KEYS command');
      console.log('🗑️ [REDIS] Cache will expire naturally with TTL');
      return 0;
    } catch (error) {
      console.error('❌ [REDIS] Failed to clear channel caches:', error);
      return 0;
    }
  }

  // Clear specific cache keys
  async clearCacheKeys(keys) {
    if (!this.isConnected) {
      // Clear from memory cache
      keys.forEach(key => {
        this.memoryCache.delete(key);
        this.memoryCacheExpiry.delete(key);
      });
      console.log('🗑️ [REDIS] Cleared memory cache keys:', keys.length);
      return keys.length;
    }
    
    try {
      if (keys.length > 0) {
        await this.redis.del(...keys);
        console.log('🗑️ [REDIS] Cleared keys:', keys.length);
      }
      return keys.length;
    } catch (error) {
      console.error('❌ [REDIS] Failed to clear keys:', error);
      return 0;
    }
  }
}

module.exports = new RedisCache();
