const { prisma } = require('./prisma');
const redis = require('./redis');

/**
 * Notification Service for Layer4 Chat System
 * Handles real-time message counting and notification management
 * 
 * Redis Strategy:
 * - Messages are NEVER cached (always real-time)
 * - Only unread counts are cached for performance
 * - Counts are invalidated on message changes
 * - Real-time updates via WebSocket events
 */

class NotificationService {
  constructor() {
    this.redis = redis;
    this.countCachePrefix = 'notification:count:';
    this.userPrefsPrefix = 'notification:prefs:';
    this.cacheTTL = 300; // 5 minutes for counts
  }

  /**
   * Get unread message count for a specific channel
   * @param {string} userId - User ID
   * @param {string} channelId - Channel ID
   * @returns {Promise<number>} Unread message count
   */
  async getChannelUnreadCount(userId, channelId) {
    try {
      const cacheKey = `${this.countCachePrefix}channel:${userId}:${channelId}`;
      
      // Try cache first
      const cachedCount = await this.redis.get(cacheKey);
      if (cachedCount !== null) {
        return parseInt(cachedCount, 10);
      }

      // Calculate from database
      const count = await this.calculateChannelUnreadCount(userId, channelId);
      
      // Cache the result
      await this.redis.set(cacheKey, count.toString(), this.cacheTTL);
      
      return count;
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error getting channel unread count:', error);
      return 0;
    }
  }

  /**
   * Get total unread message count for a user across all channels
   * @param {string} userId - User ID
   * @returns {Promise<number>} Total unread count
   */
  async getTotalUnreadCount(userId) {
    try {
      const cacheKey = `${this.countCachePrefix}total:${userId}`;
      
      // Try cache first
      const cachedCount = await this.redis.get(cacheKey);
      if (cachedCount !== null) {
        return parseInt(cachedCount, 10);
      }

      // Calculate from database
      const count = await this.calculateTotalUnreadCount(userId);
      
      // Cache the result
      await this.redis.set(cacheKey, count.toString(), this.cacheTTL);
      
      return count;
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error getting total unread count:', error);
      return 0;
    }
  }

  /**
   * Get unread counts for all channels for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Channel unread counts
   */
  async getAllChannelUnreadCounts(userId) {
    try {
      const cacheKey = `${this.countCachePrefix}all:${userId}`;
      
      // Try cache first
      const cachedCounts = await this.redis.get(cacheKey);
      if (cachedCounts) {
        return JSON.parse(cachedCounts);
      }

      // Calculate from database
      const counts = await this.calculateAllChannelUnreadCounts(userId);
      
      // Cache the result
      await this.redis.set(cacheKey, JSON.stringify(counts), this.cacheTTL);
      
      return counts;
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error getting all channel unread counts:', error);
      return {};
    }
  }

  /**
   * Calculate unread count for a specific channel from database
   * @param {string} userId - User ID
   * @param {string} channelId - Channel ID
   * @returns {Promise<number>} Unread count
   */
  async calculateChannelUnreadCount(userId, channelId) {
    try {
      // Check if user is member of channel
      const membership = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: { channelId, userId }
        }
      });

      if (!membership) {
        return 0;
      }

      // Get the last time user was active in this channel
      const lastReadTime = await this.getLastReadTime(userId, channelId);

      // Count unread messages
      const unreadCount = await prisma.message.count({
        where: {
          channelId,
          deletedAt: null,
          authorId: { not: userId }, // Don't count own messages
          sentAt: { gt: lastReadTime }
        }
      });

      return unreadCount;
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error calculating channel unread count:', error);
      return 0;
    }
  }

  /**
   * Calculate total unread count for a user across all channels
   * @param {string} userId - User ID
   * @returns {Promise<number>} Total unread count
   */
  async calculateTotalUnreadCount(userId) {
    try {
      // Get all channels user is member of
      const userChannels = await prisma.channelMember.findMany({
        where: { userId },
        select: { channelId: true }
      });

      let totalCount = 0;

      // Calculate unread count for each channel
      for (const { channelId } of userChannels) {
        const count = await this.calculateChannelUnreadCount(userId, channelId);
        totalCount += count;
      }

      return totalCount;
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error calculating total unread count:', error);
      return 0;
    }
  }

  /**
   * Calculate unread counts for all channels for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Channel unread counts
   */
  async calculateAllChannelUnreadCounts(userId) {
    try {
      // Get all channels user is member of
      const userChannels = await prisma.channelMember.findMany({
        where: { userId },
        select: { channelId: true }
      });

      const counts = {};

      // Calculate unread count for each channel
      for (const { channelId } of userChannels) {
        const count = await this.calculateChannelUnreadCount(userId, channelId);
        counts[channelId] = count;
      }

      return counts;
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error calculating all channel unread counts:', error);
      return {};
    }
  }

  /**
   * Get the last time user was active in a channel
   * @param {string} userId - User ID
   * @param {string} channelId - Channel ID
   * @returns {Promise<Date>} Last read time
   */
  async getLastReadTime(userId, channelId) {
    try {
      // Get the most recent read receipt for this channel
      const lastReadReceipt = await prisma.readReceipt.findFirst({
        where: {
          userId,
          message: {
            channelId
          }
        },
        orderBy: {
          readAt: 'desc'
        },
        select: {
          readAt: true
        }
      });

      if (lastReadReceipt) {
        return lastReadReceipt.readAt;
      }

      // If no read receipts, use user's last seen time
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { lastSeen: true }
      });

      return user?.lastSeen || new Date(0); // Use epoch if no last seen
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error getting last read time:', error);
      return new Date(0); // Use epoch as fallback
    }
  }

  /**
   * Invalidate count caches for a user
   * @param {string} userId - User ID
   * @param {string} channelId - Optional specific channel ID
   */
  async invalidateCountCaches(userId, channelId = null) {
    try {
      const patterns = [
        `${this.countCachePrefix}total:${userId}`,
        `${this.countCachePrefix}all:${userId}`,
        ...(channelId ? [`${this.countCachePrefix}channel:${userId}:${channelId}`] : [])
      ];

      // If no specific channel, invalidate all channel counts for user
      if (!channelId) {
        const allChannelPattern = `${this.countCachePrefix}channel:${userId}:*`;
        const channelKeys = await this.redis.keys(allChannelPattern);
        patterns.push(...channelKeys);
      }

      // Delete all matching keys
      if (patterns.length > 0) {
        await this.redis.del(...patterns);
        console.log(`✅ [NOTIFICATION] Invalidated ${patterns.length} count caches for user ${userId}`);
      }
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error invalidating count caches:', error);
    }
  }

  /**
   * Handle new message - update counts and send notifications
   * @param {Object} message - Message object
   * @param {Array} connections - WebSocket connections map
   */
  async handleNewMessage(message, connections) {
    try {
      const { channelId, authorId } = message;

      // Get all members of the channel except the author
      const members = await prisma.channelMember.findMany({
        where: {
          channelId,
          userId: { not: authorId }
        },
        select: { userId: true }
      });

      // Invalidate caches for all members
      for (const { userId } of members) {
        await this.invalidateCountCaches(userId, channelId);
      }

      // Send real-time count updates to all members
      for (const { userId } of members) {
        const ws = connections.get(userId);
        if (ws && ws.readyState === 1) {
          try {
            // Get updated counts
            const channelCount = await this.getChannelUnreadCount(userId, channelId);
            const totalCount = await this.getTotalUnreadCount(userId);

            // Send count update via WebSocket
            const msgpack = require('msgpack-lite');
            ws.send(msgpack.encode(['UNREAD_COUNT_UPDATE', {
              channelId,
              channelUnreadCount: channelCount,
              totalUnreadCount: totalCount,
              timestamp: Date.now()
            }, Date.now()]));

            console.log(`📊 [NOTIFICATION] Sent count update to user ${userId}:`, {
              channelId,
              channelCount,
              totalCount
            });
          } catch (error) {
            console.error(`❌ [NOTIFICATION] Error sending count update to user ${userId}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error handling new message:', error);
    }
  }

  /**
   * Handle message read - update counts
   * @param {string} userId - User ID
   * @param {string} channelId - Channel ID
   * @param {Array} connections - WebSocket connections map
   */
  async handleMessageRead(userId, channelId, connections) {
    try {
      // Invalidate caches for this user
      await this.invalidateCountCaches(userId, channelId);

      // Get updated counts
      const channelCount = await this.getChannelUnreadCount(userId, channelId);
      const totalCount = await this.getTotalUnreadCount(userId);

      // Send count update to user
      const ws = connections.get(userId);
      if (ws && ws.readyState === 1) {
        try {
          const msgpack = require('msgpack-lite');
          ws.send(msgpack.encode(['UNREAD_COUNT_UPDATE', {
            channelId,
            channelUnreadCount: channelCount,
            totalUnreadCount: totalCount,
            timestamp: Date.now()
          }, Date.now()]));

          console.log(`📊 [NOTIFICATION] Sent read update to user ${userId}:`, {
            channelId,
            channelCount,
            totalCount
          });
        } catch (error) {
          console.error(`❌ [NOTIFICATION] Error sending read update to user ${userId}:`, error);
        }
      }
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error handling message read:', error);
    }
  }

  /**
   * Get notification preferences for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Notification preferences
   */
  async getNotificationPreferences(userId) {
    try {
      const cacheKey = `${this.userPrefsPrefix}${userId}`;
      
      // Try cache first
      const cachedPrefs = await this.redis.get(cacheKey);
      if (cachedPrefs) {
        return JSON.parse(cachedPrefs);
      }

      // Get from database or use defaults
      const prefs = await prisma.notificationPreferences.findUnique({
        where: { userId }
      });

      const defaultPrefs = {
        soundEnabled: true,
        browserNotifications: true,
        inAppNotifications: true,
        channelMentions: true,
        dmNotifications: true,
        groupNotifications: true
      };

      const userPrefs = prefs ? {
        ...defaultPrefs,
        ...prefs
      } : defaultPrefs;

      // Cache the preferences
      await this.redis.set(cacheKey, JSON.stringify(userPrefs), 3600); // 1 hour

      return userPrefs;
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error getting notification preferences:', error);
      return {
        soundEnabled: true,
        browserNotifications: true,
        inAppNotifications: true,
        channelMentions: true,
        dmNotifications: true,
        groupNotifications: true
      };
    }
  }

  /**
   * Update notification preferences for a user
   * @param {string} userId - User ID
   * @param {Object} preferences - New preferences
   */
  async updateNotificationPreferences(userId, preferences) {
    try {
      // Update in database
      await prisma.notificationPreferences.upsert({
        where: { userId },
        create: {
          userId,
          ...preferences
        },
        update: preferences
      });

      // Invalidate cache
      const cacheKey = `${this.userPrefsPrefix}${userId}`;
      await this.redis.del(cacheKey);

      console.log(`✅ [NOTIFICATION] Updated preferences for user ${userId}`);
    } catch (error) {
      console.error('❌ [NOTIFICATION] Error updating notification preferences:', error);
    }
  }
}

module.exports = new NotificationService();
