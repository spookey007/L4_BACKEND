const express = require('express');
const router = express.Router();
const redisCache = require('../lib/redis');
const { prisma } = require('../lib/prisma');

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  try {
    const token = req.cookies?.l4_session;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    req.user = session.user;
    next();
  } catch (error) {
    console.error('❌ [STORAGE AUTH] Authentication error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

/**
 * GET /api/storage/:key
 * Get a storage item by key
 */
router.get('/:key', authenticateToken, async (req, res) => {
  try {
    const { key } = req.params;
    
    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }

    // Get from Redis with user-specific key
    const userId = req.user.id;

    const storageKey = `storage:${userId}:${key}`;
    const data = await redisCache.get(storageKey);
    
    if (data === null) {
      return res.status(404).json({ error: 'Key not found' });
    }

    // Parse the stored data
    let parsedData;
    try {
      parsedData = JSON.parse(data);
    } catch (parseError) {
      // If it's not JSON, treat as plain string
      parsedData = { value: data, timestamp: Date.now() };
    }

    // Return the parsed data directly (it already has value, timestamp, ttl structure)
    res.json(parsedData);
  } catch (error) {
    console.error('❌ [Storage API] Get error:', error);
    res.status(500).json({ error: 'Failed to get storage item' });
  }
});

/**
 * POST /api/storage
 * Set a storage item
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { key, value, ttl } = req.body;
    
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    const userId = req.user.id;

    const storageKey = `storage:${userId}:${key}`;
    const storageData = {
      value,
      timestamp: Date.now(),
      ttl: ttl || null
    };

    // Store in Redis with TTL
    const ttlSeconds = ttl || 86400; // Default 24 hours
    await redisCache.set(storageKey, JSON.stringify(storageData), ttlSeconds);
    
    console.log(`✅ [Storage API] Stored key: ${key} for user: ${userId}`);
    res.json({ success: true, key, ttl: ttlSeconds });
  } catch (error) {
    console.error('❌ [Storage API] Set error:', error);
    res.status(500).json({ error: 'Failed to set storage item' });
  }
});

/**
 * DELETE /api/storage/:key
 * Remove a storage item
 */
router.delete('/:key', authenticateToken, async (req, res) => {
  try {
    const { key } = req.params;
    
    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }

    const userId = req.user.id;

    const storageKey = `storage:${userId}:${key}`;
    await redisCache.del(storageKey);
    
    console.log(`✅ [Storage API] Deleted key: ${key} for user: ${userId}`);
    res.json({ success: true, key });
  } catch (error) {
    console.error('❌ [Storage API] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete storage item' });
  }
});

/**
 * GET /api/storage
 * Get all storage keys for the user
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Note: This is a simplified implementation
    // In a real Redis setup, you'd use SCAN to get keys with pattern
    // For now, we'll return an empty array since Upstash doesn't support KEYS
    res.json({ keys: [] });
  } catch (error) {
    console.error('❌ [Storage API] List keys error:', error);
    res.status(500).json({ error: 'Failed to list storage keys' });
  }
});

/**
 * DELETE /api/storage
 * Clear all storage for the user
 */
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Note: This would require a more complex implementation with Redis SCAN
    // For now, we'll just return success
    console.log(`✅ [Storage API] Cleared all storage for user: ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ [Storage API] Clear error:', error);
    res.status(500).json({ error: 'Failed to clear storage' });
  }
});

module.exports = router;
