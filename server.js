// Load environment variables
require('dotenv').config({ path: '.env' });

(async function() {

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const msgpack = require('msgpack-lite');
// Next.js removed - pure backend API and WebSocket server
const jwt = require('jsonwebtoken'); // Required for WebSocket JWT authentication
const { prisma } = require('./lib/prisma');
const redis = require('./lib/redis');
const performanceMonitor = require('./scripts/performance-monitor');
const crypto = require('crypto');
const debug = require('./lib/debug');
const notificationService = require('./lib/notificationService');
const jwtAuth = require('./lib/jwtAuth');
const websocketAuth = require('./lib/websocketAuth');
const { 
  handleFetchChannels, 
  handleFetchMessages,
  handleJoinChannel,
  handleLeaveChannel,
  handleStartTyping,
  handleStopTyping,
  handleAddReaction,
  handleRemoveReaction,
  handleStorageGet,
  handleStorageSet,
  handleStorageDelete,
  handleStorageList,
  handleStorageClear,
  handleAudioSettingsGet,
  handleAudioSettingsSet,
  handleCreateRoom,
  handleJoinRoom,
  handleLeaveRoom,
  handleCreateRoomInvite,
  handleUseRoomInvite,
  handleSearchRooms,
  handleCreateDM,
  handleGetUnreadCounts,
  handleGetNotificationPrefs,
  handleUpdateNotificationPrefs
} = require('./handlers/websocketHandlers');

// AGGRESSIVE CACHE CLEARING - Clear ALL channel caches
async function clearAllChannelCaches(reason = 'unknown') {
  try {
    console.log(`🗑️ [CACHE] AGGRESSIVE: Clearing ALL channel caches (reason: ${reason})`);
    const deletedCount = await redis.clearAllChannelCaches();
    console.log(`🗑️ [CACHE] AGGRESSIVE: Cleared ${deletedCount} cache keys`);
    return deletedCount;
  } catch (error) {
    console.error('❌ [CACHE] AGGRESSIVE: Failed to clear caches:', error);
    return 0;
  }
}

// CACHE VALIDATION - Compare cache vs database
async function validateCacheVsDatabase(userId) {
  try {
    console.log('🔍 [CACHE] Validating cache vs database for user:', userId);
    
    // Get data from database
    const dbChannels = await prisma.channel.findMany({
      where: {
        OR: [
          { members: { some: { userId } } },
          { type: 'text-group', isPrivate: false }
        ]
      },
      select: {
        id: true,
        name: true,
        type: true,
        isPrivate: true,
        roomId: true
      }
    });
    
    // Get data from cache
    const userCacheKey = redis.getUserChannelsKey(userId);
    const publicChannelsKey = 'channels:public';
    const [cachedUserChannels, cachedPublicChannels] = await Promise.all([
      redis.get(userCacheKey),
      redis.get(publicChannelsKey)
    ]);
    
    let cachedChannels = [];
    if (cachedUserChannels && cachedPublicChannels) {
      const userChannelIds = new Set(cachedUserChannels.map(c => c.id));
      const publicChannels = cachedPublicChannels.filter(c => !userChannelIds.has(c.id));
      cachedChannels = [...cachedUserChannels, ...publicChannels];
    } else if (cachedUserChannels) {
      cachedChannels = cachedUserChannels;
    }
    
    // Compare
    const dbChannelIds = new Set(dbChannels.map(c => c.id));
    const cacheChannelIds = new Set(cachedChannels.map(c => c.id));
    
    const missingFromCache = dbChannels.filter(c => !cacheChannelIds.has(c.id));
    const extraInCache = cachedChannels.filter(c => !dbChannelIds.has(c.id));
    
    console.log('🔍 [CACHE] Validation results:', {
      dbChannels: dbChannels.length,
      cacheChannels: cachedChannels.length,
      missingFromCache: missingFromCache.length,
      extraInCache: extraInCache.length,
      isValid: missingFromCache.length === 0 && extraInCache.length === 0
    });
    
    if (missingFromCache.length > 0 || extraInCache.length > 0) {
      console.log('❌ [CACHE] Cache is stale! Clearing cache...');
      await clearAllChannelCaches('cache validation failed');
      return false;
    }
    
    console.log('✅ [CACHE] Cache is valid');
    return true;
  } catch (error) {
    console.error('❌ [CACHE] Validation failed:', error);
    return false;
  }
}

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

// Import routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const stakingRoutes = require('./routes/staking');
const postsRoutes = require('./routes/posts');
const dextoolsRoutes = require('./routes/dextools');
// const storageRoutes = require('./routes/storage'); // Disabled - using WebSocket instead
const minioRoutes = require('./routes/minio');

// Backend API and WebSocket server setup
const dev = process.env.NODE_ENV !== 'production';
console.log('🔧 [SERVER] Backend mode:', dev ? 'development' : 'production');

// Simple in-memory storage for development (replace with Redis in production)
const memoryStore = {
  connections: new Map(),
  typingUsers: new Map(),
  userPresence: new Map()
};

// Use memory store for connections
const connections = memoryStore.connections;

// Event types
const CLIENT_EVENTS = {
  SEND_MESSAGE: 'SEND_MESSAGE',
  EDIT_MESSAGE: 'EDIT_MESSAGE',
  DELETE_MESSAGE: 'DELETE_MESSAGE',
  ADD_REACTION: 'ADD_REACTION',
  REMOVE_REACTION: 'REMOVE_REACTION',
  START_TYPING: 'START_TYPING',
  STOP_TYPING: 'STOP_TYPING',
  FETCH_MESSAGES: 'FETCH_MESSAGES',
  FETCH_CHANNELS: 'FETCH_CHANNELS',
  JOIN_CHANNEL: 'JOIN_CHANNEL',
  LEAVE_CHANNEL: 'LEAVE_CHANNEL',
  UPLOAD_MEDIA: 'UPLOAD_MEDIA',
  MARK_AS_READ: 'MARK_AS_READ',
  PING: 'PING',
  // Authentication operations
  AUTH_ME: 'AUTH_ME',
  AUTH_LOGIN: 'AUTH_LOGIN',
  // Storage operations
  STORAGE_GET: 'STORAGE_GET',
  STORAGE_SET: 'STORAGE_SET',
  STORAGE_DELETE: 'STORAGE_DELETE',
  STORAGE_LIST: 'STORAGE_LIST',
  STORAGE_CLEAR: 'STORAGE_CLEAR',
  // Audio settings
  AUDIO_SETTINGS_GET: 'AUDIO_SETTINGS_GET',
  AUDIO_SETTINGS_SET: 'AUDIO_SETTINGS_SET',
  // Social features
  FOLLOW_USER: 'FOLLOW_USER',
  UNFOLLOW_USER: 'UNFOLLOW_USER',
  SEND_POKE: 'SEND_POKE',
  GET_USER_STATUS: 'GET_USER_STATUS',
  CHECK_FOLLOW_STATUS: 'CHECK_FOLLOW_STATUS',
  GET_USER_STATS: 'GET_USER_STATS',
  // Room features
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  LEAVE_ROOM: 'LEAVE_ROOM',
  GET_ROOM_INFO: 'GET_ROOM_INFO',
  CREATE_ROOM_INVITE: 'CREATE_ROOM_INVITE',
  USE_ROOM_INVITE: 'USE_ROOM_INVITE',
  GET_USER_ROOMS: 'GET_USER_ROOMS',
  SEARCH_ROOMS: 'SEARCH_ROOMS',
  // Notification features
  GET_UNREAD_COUNTS: 'GET_UNREAD_COUNTS',
  GET_NOTIFICATION_PREFS: 'GET_NOTIFICATION_PREFS',
  UPDATE_NOTIFICATION_PREFS: 'UPDATE_NOTIFICATION_PREFS'
};

const SERVER_EVENTS = {
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  MESSAGE_EDITED: 'MESSAGE_EDITED',
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  REACTION_ADDED: 'REACTION_ADDED',
  REACTION_REMOVED: 'REACTION_REMOVED',
  TYPING_STARTED: 'TYPING_STARTED',
  TYPING_STOPPED: 'TYPING_STOPPED',
  USER_JOINED: 'USER_JOINED',
  USER_LEFT: 'USER_LEFT',
  USER_STATUS_CHANGED: 'USER_STATUS_CHANGED',
  READ_RECEIPT_UPDATED: 'READ_RECEIPT_UPDATED',
  MEDIA_UPLOADED: 'MEDIA_UPLOADED',
  MESSAGES_LOADED: 'MESSAGES_LOADED',
  CHANNELS_LOADED: 'CHANNELS_LOADED',
  CHANNEL_CREATED: 'CHANNEL_CREATED',
  NEW_DM_INVITE: 'NEW_DM_INVITE',
  PONG: 'PONG',
  ERROR: 'ERROR', // ← Added ERROR event type
  // Authentication responses
  AUTH_ME_RESPONSE: 'AUTH_ME_RESPONSE',
  AUTH_LOGIN_RESPONSE: 'AUTH_LOGIN_RESPONSE',
  // Storage operations
  STORAGE_GET_RESPONSE: 'STORAGE_GET_RESPONSE',
  STORAGE_SET_RESPONSE: 'STORAGE_SET_RESPONSE',
  STORAGE_DELETE_RESPONSE: 'STORAGE_DELETE_RESPONSE',
  STORAGE_LIST_RESPONSE: 'STORAGE_LIST_RESPONSE',
  STORAGE_CLEAR_RESPONSE: 'STORAGE_CLEAR_RESPONSE',
  // Audio settings
  AUDIO_SETTINGS_GET_RESPONSE: 'AUDIO_SETTINGS_GET_RESPONSE',
  AUDIO_SETTINGS_SET_RESPONSE: 'AUDIO_SETTINGS_SET_RESPONSE',
  // Social features
  FOLLOW_SUCCESS: 'FOLLOW_SUCCESS',
  UNFOLLOW_SUCCESS: 'UNFOLLOW_SUCCESS',
  POKE_SENT: 'POKE_SENT',
  POKE_RECEIVED: 'POKE_RECEIVED',
  USER_STATUS_RESPONSE: 'USER_STATUS_RESPONSE',
  NOTIFICATION_RECEIVED: 'NOTIFICATION_RECEIVED',
  FOLLOW_STATUS_RESPONSE: 'FOLLOW_STATUS_RESPONSE',
  USER_STATS_RESPONSE: 'USER_STATS_RESPONSE',
  // Room features
  ROOM_CREATED: 'ROOM_CREATED',
  ROOM_JOINED: 'ROOM_JOINED',
  ROOM_LEFT: 'ROOM_LEFT',
  ROOM_INFO_RESPONSE: 'ROOM_INFO_RESPONSE',
  ROOM_INVITE_CREATED: 'ROOM_INVITE_CREATED',
  ROOM_INVITE_USED: 'ROOM_INVITE_USED',
  USER_ROOMS_RESPONSE: 'USER_ROOMS_RESPONSE',
  ROOMS_SEARCH_RESPONSE: 'ROOMS_SEARCH_RESPONSE',
  ROOM_ERROR: 'ROOM_ERROR',
  // Notification features
  UNREAD_COUNT_UPDATE: 'UNREAD_COUNT_UPDATE',
  UNREAD_COUNTS_RESPONSE: 'UNREAD_COUNTS_RESPONSE',
  NOTIFICATION_PREFS_RESPONSE: 'NOTIFICATION_PREFS_RESPONSE',
  // Server heartbeat
  SERVER_HEARTBEAT: 'SERVER_HEARTBEAT'
};

// Helper functions
function determineMessageType(content, attachments = []) {
  // Check if there are any GIF attachments
  const hasGifAttachment = attachments.some(attachment => attachment.type === 'gif');
  if (hasGifAttachment) return 3; // GIF
  
  // Check if there are any image attachments
  const hasImageAttachment = attachments.some(attachment => 
    attachment.type === 'image' || 
    (attachment.filename && /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(attachment.filename))
  );
  if (hasImageAttachment) return 2; // Image
  
  // Check if there are any audio attachments (check before video to avoid webm conflict)
  const hasAudioAttachment = attachments.some(attachment => 
    attachment.type === 'audio' || 
    (attachment.filename && /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(attachment.filename))
  );
  if (hasAudioAttachment) return 4; // Audio
  
  // Check if there are any video attachments
  const hasVideoAttachment = attachments.some(attachment => 
    attachment.type === 'video' || 
    (attachment.filename && /\.(mp4|avi|mov|wmv|flv|webm)$/i.test(attachment.filename))
  );
  if (hasVideoAttachment) return 5; // Video
  
  // Default to text
  return 1; // Text
}

async function broadcastToChannel(channelId, event, payload, excludeUserId = null) {
  const message = msgpack.encode([event, payload, Date.now()]);
  
  try {
    // Only invalidate channel cache on user join/leave events
    // Messages are real-time and don't need cache invalidation
    // if (event === SERVER_EVENTS.USER_JOINED || 
    //     event === SERVER_EVENTS.USER_LEFT) {
    //   // Only invalidate cache for the specific user who joined/left
    //   if (payload && payload.userId) {
    //     console.log('🗑️ [CACHE] Invalidating user channels cache for:', payload.userId);
    //     await redis.invalidateUserChannels(payload.userId);
    //   }
    // }
    
    const members = await prisma.channelMember.findMany({
      where: { channelId },
      select: { userId: true }
    });
    
    let sentCount = 0;
    
    members.forEach(member => {
      if (member.userId !== excludeUserId) {
        const ws = connections.get(member.userId);
        if (ws && ws.readyState === 1) {
          try {
            ws.send(message);
            sentCount++;
          } catch (error) {
            console.log(`⚠️ [SERVER] Error sending to user ${member.userId}:`, error.message);
          }
        } else {
          console.log(`⚠️ [SERVER] User ${member.userId} not connected (readyState: ${ws?.readyState})`);
        }
      }
    });
    
    console.log(`✅ [SERVER] Broadcast complete:`, {
      sentTo: sentCount,
      totalMembers: members.length,
      channelId,
      event,
      successRate: `${Math.round((sentCount / members.length) * 100)}%`
    });
  } catch (error) {
    console.error('❌ Error broadcasting to channel:', error);
  }
}

async function updateUserPresence(userId, status) {
  try {
    if (!userId) {
      console.log('⚠️ [SERVER] Skipping user presence update - no userId provided');
      return;
    }
    
    await prisma.user.update({
      where: { id: userId },
      data: { 
        status,
        lastSeen: new Date()
      }
    });
  } catch (error) {
    console.error('Error updating user presence:', error);
  }
}

// Initialize server based on environment
// 🚀 START WEBSOCKET SERVER AFTER DATABASE CONNECTION
console.log('🚀 [SERVER] Starting server initialization...');

// Initialize database first, then start server
async function initializeServer() {
  const dbConnected = await initializeDatabase();
  
  if (!dbConnected) {
    console.error('❌ [SERVER] Failed to connect to database. Server will not start.');
    process.exit(1);
  }
  
  console.log('🚀 [SERVER] Starting WebSocket server...');
  startServer();
}

initializeServer();

// Backend server ready for API and WebSocket connections
function startServer() {
  // Express app setup
  const app = express();

  // Middleware
  const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://socket.lay4r.io",
    "https://lay4r.io",
    "https://www.lay4r.io",
    "https://demo.lay4r.io",
    "https://api.lay4r.io"
  ];
  
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With'],
    optionsSuccessStatus: 200
  }));
  
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  // Handle preflight requests explicitly
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      console.log('🔍 [CORS] Preflight request:', {
        origin: req.headers.origin,
        method: req.method,
        headers: req.headers,
        timestamp: new Date().toISOString()
      });
      
      res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Requested-With');
      res.header('Access-Control-Allow-Credentials', 'true');
      res.sendStatus(200);
    } else {
      next();
    }
  });

  // Serve static files
  app.use('/uploads', express.static('public/uploads'));
  app.use('/avatars', express.static('public/avatars'));

  // API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/staking', stakingRoutes);
  app.use('/api/posts', postsRoutes);
  app.use('/api/dextools', dextoolsRoutes);
  // app.use('/api/storage', storageRoutes); // Disabled - using WebSocket instead
  app.use('/api/minio', minioRoutes);

    // In your Express app setup (inside startServer())
  app.get('/api/ws-health', (req, res) => {
    res.json({
      status: 'ok',
      websocket: {
        connections: connections.size,
        timestamp: new Date().toISOString()
      }
    });
  });

  // Health check endpoint
  app.get('/api/health', async (req, res) => {
    const dbHealth = await checkDatabaseHealth();
    res.json({ 
      status: dbHealth.status === 'healthy' ? 'ok' : 'error',
      database: dbHealth,
      timestamp: new Date().toISOString() 
    });
  });

  // Database health check endpoint
  app.get('/api/health/database', async (req, res) => {
    const dbHealth = await checkDatabaseHealth();
    res.json(dbHealth);
  });

  // AGGRESSIVE cache clear endpoint for testing
  app.post('/api/admin/clear-cache', async (req, res) => {
    try {
      const deletedCount = await clearAllChannelCaches('admin manual clear');
      res.json({ 
        success: true, 
        message: 'All channel caches cleared aggressively', 
        deletedKeys: deletedCount 
      });
    } catch (error) {
      console.error('❌ [ADMIN] Failed to clear cache:', error);
      res.status(500).json({ success: false, error: 'Failed to clear cache' });
    }
  });

  // Clear specific user cache endpoint
  app.post('/api/admin/clear-user-cache/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const userCacheKey = redis.getUserChannelsKey(userId);
      
      await redis.del(userCacheKey);
      console.log('🗑️ [ADMIN] User cache cleared:', userCacheKey);
      
      res.json({ 
        success: true, 
        message: `User cache cleared for ${userId}`,
        cacheKey: userCacheKey
      });
    } catch (error) {
      console.error('Error clearing user cache:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // Cache validation endpoint
  app.post('/api/admin/validate-cache/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const isValid = await validateCacheVsDatabase(userId);
      
      res.json({ 
        success: true, 
        message: `Cache validation for user ${userId}`,
        isValid: isValid
      });
    } catch (error) {
      console.error('Error validating cache:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // Handle all other requests (non-API routes)
  app.use((req, res) => {
    res.status(404).json({ 
      error: 'Not found', 
      message: 'This is a backend API and WebSocket server. API routes are available at /api/*' 
    });
  });

  // WebSocket event handlers
  async function handleSendMessage(userId, payload) {
    try {
      const { channelId, content, attachments = [], repliedToMessageId } = payload;
      
      const existingMember = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: { channelId, userId }
        }
      });

      if (!existingMember) {
        await prisma.channelMember.create({
          data: { channelId, userId }
        });
      }
      
      const messageType = determineMessageType(content, attachments);
      console.log('🔍 [MESSAGE TYPE] Determining message type:', {
        content: content.substring(0, 50) + (content.length > 50 ? '...' : ''),
        attachments: attachments?.map(a => ({ type: a.type, filename: a.filename })),
        determinedType: messageType
      });
      
      // Add duration to audio attachments
      if (messageType === 4 && attachments) {
        for (const attachment of attachments) {
          if (attachment.type === 'audio' && !attachment.duration) {
            // Set a default duration for now - in production, you'd calculate this from the audio file
            attachment.duration = 0; // Will be updated by client when audio loads
          }
        }
      }
      
      // Debug: Log full attachment data
      console.log('🔍 [ATTACHMENTS DEBUG] Full attachments received:', JSON.stringify(attachments, null, 2));
      
      const message = await prisma.message.create({
        data: {
          channelId,
          authorId: userId,
          content,
          type: messageType,
          attachments: attachments || [],
          repliedToMessageId
        },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              walletAddress: true
            }
          },
          repliedToMessage: {
            include: {
              author: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  walletAddress: true
                }
              }
            }
          }
        }
      });

      console.log('📤 [SERVER] Broadcasting message:', {
        id: message.id,
        type: message.type,
        content: message.content.substring(0, 50) + '...',
        attachments: message.attachments,
        hasAttachments: message.attachments && message.attachments.length > 0,
        attachmentsType: typeof message.attachments,
        attachmentsLength: message.attachments ? message.attachments.length : 0
      });
      
      // Handle notification for new message
      await notificationService.handleNewMessage(message, connections);
      
      await broadcastToChannel(channelId, SERVER_EVENTS.MESSAGE_RECEIVED, message, null);
    } catch (error) {
      console.error('❌ Error sending message:', error);
      throw error; // Re-throw to be caught by caller
    }
  }

  async function handleJoinChannel(userId, payload) {
    try {
      const { channelId } = payload;
      
      const existingMember = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: { channelId, userId }
        }
      });

      if (!existingMember) {
        await prisma.channelMember.create({
          data: { channelId, userId }
        });
      }

      await broadcastToChannel(channelId, SERVER_EVENTS.USER_JOINED, { userId, channelId }, userId);
    } catch (error) {
      console.error('Error joining channel:', error);
      throw error;
    }
  }

  async function handleLeaveChannel(userId, payload) {
    try {
      const { channelId } = payload;
      
      await prisma.channelMember.deleteMany({
        where: {
            channelId,
            userId
          }
      });

      await broadcastToChannel(channelId, SERVER_EVENTS.USER_LEFT, { userId, channelId }, userId);
    } catch (error) {
      console.error('Error leaving channel:', error);
      throw error;
    }
  }

  async function handleMarkAsRead(userId, payload) {
    try {
      const { messageId } = payload;
      
      // Validate that the message exists before creating read receipt
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { id: true, channelId: true }
      });
      
      if (!message) {
        console.log('⚠️ [SERVER] Cannot mark message as read: message not found', {
          messageId,
          userId
        });
        return; // Silently return - don't throw error for non-existent messages
      }
      
      // Check if user has access to the channel containing this message
      const membership = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: {
            channelId: message.channelId,
            userId
          }
        }
      });
      
      if (!membership) {
        console.log('⚠️ [SERVER] Cannot mark message as read: user not member of channel', {
          messageId,
          userId,
          channelId: message.channelId
        });
        return; // Silently return - don't throw error for unauthorized access
      }
      
      await prisma.readReceipt.upsert({
        where: {
          messageId_userId: {
            messageId,
            userId
          }
        },
        update: {
          readAt: new Date()
        },
        create: {
          messageId,
          userId,
          readAt: new Date()
        }
      });
      
      // Handle notification for message read
      await notificationService.handleMessageRead(userId, message.channelId, connections);
      
      // Reduced logging to prevent spam - only log every 10th read receipt
      if (Math.random() < 0.1) {
        console.log('✅ [SERVER] Message marked as read (sample):', {
          messageId,
          userId,
          channelId: message.channelId
        });
      }
    } catch (error) {
      console.error('❌ [SERVER] Error marking message as read:', error);
      throw error;
    }
  }

  // Notification handlers
  async function handleGetUnreadCounts(userId, ws) {
    try {
      const unreadCounts = await notificationService.getAllChannelUnreadCounts(userId);
      const totalUnread = await notificationService.getTotalUnreadCount(userId);
      
      ws.send(msgpack.encode([SERVER_EVENTS.UNREAD_COUNTS_RESPONSE, {
        unreadCounts,
        totalUnread
      }, Date.now()]));
    } catch (error) {
      console.error('❌ [SERVER] Error getting unread counts:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { 
        error: 'Failed to get unread counts' 
      }, Date.now()]));
    }
  }

  async function handleGetNotificationPrefs(userId, ws) {
    try {
      const preferences = await notificationService.getNotificationPreferences(userId);
      
      ws.send(msgpack.encode([SERVER_EVENTS.NOTIFICATION_PREFS_RESPONSE, {
        preferences
      }, Date.now()]));
    } catch (error) {
      console.error('❌ [SERVER] Error getting notification preferences:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { 
        error: 'Failed to get notification preferences' 
      }, Date.now()]));
    }
  }

  async function handleUpdateNotificationPrefs(userId, payload, ws) {
    try {
      const { preferences } = payload;
      const updatedPrefs = await notificationService.updateNotificationPreferences(userId, preferences);
      
      ws.send(msgpack.encode([SERVER_EVENTS.NOTIFICATION_PREFS_RESPONSE, {
        preferences: updatedPrefs
      }, Date.now()]));
    } catch (error) {
      console.error('❌ [SERVER] Error updating notification preferences:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { 
        error: 'Failed to update notification preferences' 
      }, Date.now()]));
    }
  }

  // WebSocket server setup
  const server = createServer(app);
  
  // Start performance monitoring
  performanceMonitor.startMonitoring();
  
  const wss = new WebSocketServer({ server });

  wss.on('error', (error) => {
    console.error('❌ [SERVER] WebSocket server error:', error);
  });

  wss.on('connection', async (ws, req) => {
    try {
      let authResult;
      
      // Check if this is the auth endpoint
      if (req.url === '/auth' || req.url.startsWith('/auth?')) {
        // Use the new secure authentication system for /auth endpoint
        authResult = await websocketAuth.handleConnection(ws, req);
        
        // If authentication failed, the connection will be closed by websocketAuth
        if (!authResult) {
        return;
        }
      } else {
        // For main WebSocket endpoint, require authentication via JWT token in URL
        console.log('🔌 [SERVER] Main WebSocket connection attempt:', {
          url: req.url,
          userAgent: req.headers['user-agent'],
          timestamp: new Date().toISOString(),
          ip: req.socket.remoteAddress
        });
        
        // Extract JWT token from URL query parameter
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        
        if (!token) {
          console.log('❌ [SERVER] Main WebSocket connection rejected - no token provided');
          ws.close(1008, 'Authentication required');
          return;
        }
        
        // Validate JWT token
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          console.log('✅ [SERVER] Main WebSocket JWT validation successful:', {
            walletAddress: decoded.walletAddress,
            iat: new Date(decoded.iat * 1000).toISOString(),
            exp: new Date(decoded.exp * 1000).toISOString(),
            nonce: decoded.nonce,
            sessionId: decoded.sessionId
          });
          
          // Check if token has already been used (one-time use)
          // Use in-memory tracking instead of Redis for simplicity
          if (!global.usedTokens) {
            global.usedTokens = new Map();
          }
          
          const tokenKey = decoded.nonce;
          if (global.usedTokens.has(tokenKey)) {
            console.log('❌ [SERVER] Token already used - rejecting connection:', {
              nonce: decoded.nonce,
              walletAddress: decoded.walletAddress
            });
            ws.close(1008, 'Token already used');
            return;
          }
          
          // Mark token as used (one-time use)
          global.usedTokens.set(tokenKey, Date.now());
          
          // Clean up old tokens (older than 5 minutes)
          const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
          for (const [key, timestamp] of global.usedTokens.entries()) {
            if (timestamp < fiveMinutesAgo) {
              global.usedTokens.delete(key);
            }
          }
          
          // Find or create user in database
          console.log('🔍 [SERVER] Looking for user in database...');
          let user = await prisma.user.findFirst({
            where: { walletAddress: decoded.walletAddress }
          });
          
          if (!user) {
            console.log('🔍 [SERVER] User not found, creating new user for main WebSocket');
            try {
              user = await prisma.user.create({
                data: {
                  walletAddress: decoded.walletAddress,
                  username: `user_${decoded.walletAddress.slice(0, 8)}`,
                  isVerified: false,
                  isAdmin: false,
                  role: 0
                }
              });
              console.log('✅ [SERVER] User created successfully:', user.id);
            } catch (createError) {
              console.error('❌ [SERVER] Failed to create user:', createError);
              ws.close(1008, 'Database error');
              return;
            }
          } else {
            console.log('✅ [SERVER] User found:', user.id);
          }
          
          authResult = {
            connectionId: `main_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            userId: user.id,
            username: user.username,
            walletAddress: user.walletAddress
          };
          
          console.log('✅ [SERVER] Main WebSocket authentication successful:', {
            connectionId: authResult.connectionId,
            userId: authResult.userId,
            username: authResult.username,
            walletAddress: authResult.walletAddress
          });
          
        } catch (jwtError) {
          console.log('❌ [SERVER] Main WebSocket JWT validation failed:', jwtError.message);
          ws.close(1008, 'Invalid authentication token');
        return;
      }
      }

      // Extract authenticated connection data
      const { connectionId, userId, username, walletAddress } = authResult;
      let heartbeatInterval = null;
      let connectionTimeout = null;
      let isAuthenticated = true; // Already authenticated by websocketAuth
      
      console.log('✅ [SERVER] WebSocket connection authenticated and established:', {
        connectionId,
        userId,
        username,
        walletAddress,
        timestamp: new Date().toISOString()
      });
      
      // Set up user connection (already authenticated)
      await setupUserConnection(ws, userId, username);
      
      // Set up connection timeout function
      function resetConnectionTimeout() {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
        }
        connectionTimeout = setTimeout(() => {
          console.log('⏰ [SERVER] Connection timeout - closing WebSocket', { userId });
          ws.close(1000, 'Connection timeout');
        }, 300000); // 5 minute timeout
      }
      
      // Set up heartbeat
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(msgpack.encode([SERVER_EVENTS.SERVER_HEARTBEAT, {
            timestamp: new Date().toISOString(),
            connectionId: userId
          }, Date.now()]));
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 30000); // 30 second heartbeat
      
      // Remove any existing message handlers (from websocketAuth) before adding the main handler
      ws.removeAllListeners('message');
      
      // Handle messages from authenticated users
      ws.on('message', async (data) => {
        try {
          // Reset connection timeout on any activity
          resetConnectionTimeout();
          
          // Handle both JSON and MessagePack data
          let eventType, payload, timestamp;
          
          if (Buffer.isBuffer(data)) {
            // Try MessagePack first
            try {
              const decoded = msgpack.decode(data);
              if (Array.isArray(decoded) && decoded.length >= 2) {
                [eventType, payload, timestamp] = decoded;
              } else {
                throw new Error('Invalid MessagePack format');
              }
            } catch (msgpackError) {
              // Fall back to JSON
              try {
                const jsonData = JSON.parse(data.toString());
                eventType = jsonData.type;
                payload = jsonData.payload || jsonData;
                timestamp = Date.now();
              } catch (jsonError) {
                console.error('❌ [SERVER] Invalid data format:', { msgpackError: msgpackError.message, jsonError: jsonError.message });
                ws.send(msgpack.encode(['ERROR', { error: 'Invalid message format' }, Date.now()]));
                return;
              }
            }
          } else {
            console.error('❌ [SERVER] Received non-buffer data:', typeof data, data);
            ws.send(msgpack.encode(['ERROR', { error: 'Invalid message format' }, Date.now()]));
        return;
      }

          // Handle messages for authenticated users only
          await handleWebSocketMessage(ws, eventType, payload, timestamp, userId, connections);
          
    } catch (error) {
          console.error('❌ [SERVER] WebSocket message handling error:', error);
          ws.send(msgpack.encode(['ERROR', { 
            error: 'Message processing failed' 
          }, Date.now()]));
        }
      });
      
      // Handle connection close
      ws.on('close', async (code, reason) => {
        console.log('🔌 [SERVER] WebSocket connection closed:', {
          userId,
          username,
          code,
          reason: reason.toString(),
          timestamp: new Date().toISOString()
        });
        
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
        }
        
        if (userId) {
          connections.delete(userId);
          await updateUserPresence(userId, 'offline');
        }
      });
      
      // Handle connection errors
      ws.on('error', (error) => {
        console.error('❌ [SERVER] WebSocket connection error:', {
      userId,
      username,
          error: error.message,
      timestamp: new Date().toISOString()
        });
      });
      
      resetConnectionTimeout();
      
    } catch (error) {
      console.error('❌ [SERVER] WebSocket connection setup error:', error);
      if (ws.readyState === ws.OPEN) {
        ws.close(1011, 'Connection setup failed');
      }
    }
    
    // Helper function to set up user connection after authentication
    async function setupUserConnection(ws, userId, username) {
      // Check if user already has a connection
      const existingConnection = connections.get(userId);
      if (existingConnection) {
        if (existingConnection.readyState === 1) {
          console.log('⚠️ [SERVER] User already connected, closing existing connection', {
            userId,
            existingReadyState: existingConnection.readyState
          });
          existingConnection.close(1000, 'Replaced by new connection');
        } else {
          console.log('🧹 [SERVER] Cleaning up stale connection', {
            userId,
            existingReadyState: existingConnection.readyState
          });
        }
        connections.delete(userId);
      }

      connections.set(userId, ws);
      await updateUserPresence(userId, 'online');

    // Set connection start time for tracking
    ws.connectionStartTime = Date.now();

    console.log('✅ [SERVER] WebSocket connected for user:', {
      userId,
      username,
      totalConnections: connections.size,
      timestamp: new Date().toISOString()
    });
    
      // Send user status update
      ws.send(msgpack.encode([SERVER_EVENTS.USER_STATUS_CHANGED, { 
        userId, 
        status: 'online' 
      }, Date.now()]));
    }
  });

  // Helper function to handle WebSocket messages for authenticated users
  async function handleWebSocketMessage(ws, eventType, payload, timestamp, userId, connections) {
    try {
          console.log('🔵 [SERVER] WebSocket message received:', {
            eventType,
            payload: payload ? JSON.stringify(payload).substring(0, 100) + '...' : 'null',
            userId,
            timestamp: new Date().toISOString()
          });

          switch (eventType) {
            // WebSocket Authentication Handlers
            case CLIENT_EVENTS.AUTH_ME:
              try {
                // Get user data for authenticated user
                const user = await prisma.user.findUnique({
                  where: { id: userId },
                  include: {
                    sessions: {
                      where: { expiresAt: { gt: new Date() } },
                      orderBy: { createdAt: 'desc' },
                      take: 1
                    }
                  }
                });
                
                if (!user) {
                  ws.send(JSON.stringify({
                    type: 'AUTH_ME_RESPONSE',
                    success: false,
                    error: 'User not found'
                  }));
                  return;
                }
                
                // Get follower counts for the user
                const [followerCount, followingCount] = await Promise.all([
                  prisma.follow.count({ where: { followingId: user.id } }),
                  prisma.follow.count({ where: { followerId: user.id } })
                ]);

                // Prepare user data for response
                const userData = {
                  id: user.id,
                  walletAddress: user.walletAddress,
                  username: user.username,
                  displayName: user.displayName,
                  role: user.role,
                  isAdmin: user.role === 0,
                  isVerified: user.isVerified,
                  avatarUrl: user.avatarUrl,
                  avatarBlob: user.avatarBlob,
                  bio: user.bio,
                  followerCount,
                  followingCount,
                  email: user.email,
                  emailVerified: user.emailVerified,
                  twitterHandle: user.twitterHandle,
                  discordHandle: user.discordHandle,
                  twitchHandle: user.twitchHandle,
                  spotifyHandle: user.spotifyHandle,
                  status: user.status || 'online',
                  lastSeen: user.lastSeen
                };
                
                // Get the current session token
                const currentSession = user.sessions[0];
                const token = currentSession ? currentSession.token : null;
                
            // Send response
                  ws.send(JSON.stringify({
                    type: 'AUTH_ME_RESPONSE',
                    success: true,
              data: { user: userData, token }
            }));
            
          } catch (error) {
            console.error('❌ [SERVER] AUTH_ME error:', error);
                ws.send(JSON.stringify({
                  type: 'AUTH_ME_RESPONSE',
                  success: false,
              error: 'Failed to get user data'
                }));
              }
              break;
              
        // Chat Handlers
            case CLIENT_EVENTS.SEND_MESSAGE:
                await handleSendMessage(userId, payload);
              break;

            case CLIENT_EVENTS.MARK_AS_READ:
                await handleMarkAsRead(userId, payload);
              break;

        case CLIENT_EVENTS.JOIN_CHANNEL:
          await handleJoinChannel(userId, payload);
              break;

        case CLIENT_EVENTS.LEAVE_CHANNEL:
          await handleLeaveChannel(userId, payload);
              break;

        case CLIENT_EVENTS.FETCH_CHANNELS:
          await handleFetchChannels(userId, payload, ws, connections);
              break;

        case CLIENT_EVENTS.FETCH_MESSAGES:
          await handleFetchMessages(userId, payload, ws, connections);
              break;

        case CLIENT_EVENTS.START_TYPING:
          await handleStartTyping(userId, payload, ws, connections);
              break;

        case CLIENT_EVENTS.STOP_TYPING:
          await handleStopTyping(userId, payload, ws, connections);
              break;

        case CLIENT_EVENTS.ADD_REACTION:
          await handleAddReaction(userId, payload, ws, connections);
              break;

        case CLIENT_EVENTS.REMOVE_REACTION:
          await handleRemoveReaction(userId, payload, ws, connections);
              break;

        // Storage Handlers
            case CLIENT_EVENTS.STORAGE_GET:
                await handleStorageGet(userId, payload, ws);
              break;

            case CLIENT_EVENTS.STORAGE_SET:
                await handleStorageSet(userId, payload, ws);
              break;

            case CLIENT_EVENTS.STORAGE_DELETE:
                await handleStorageDelete(userId, payload, ws);
              break;

            case CLIENT_EVENTS.STORAGE_LIST:
                await handleStorageList(userId, payload, ws);
              break;

            case CLIENT_EVENTS.STORAGE_CLEAR:
                await handleStorageClear(userId, payload, ws);
              break;

        // Audio Settings Handlers
            case CLIENT_EVENTS.AUDIO_SETTINGS_GET:
                await handleAudioSettingsGet(userId, payload, ws);
              break;

            case CLIENT_EVENTS.AUDIO_SETTINGS_SET:
                await handleAudioSettingsSet(userId, payload, ws);
              break;

        // Room Handlers
            case CLIENT_EVENTS.CREATE_ROOM:
          await handleCreateRoom(userId, payload, ws, connections);
              break;

            case CLIENT_EVENTS.JOIN_ROOM:
          await handleJoinRoom(userId, payload, ws, connections);
              break;

            case CLIENT_EVENTS.LEAVE_ROOM:
          await handleLeaveRoom(userId, payload, ws, connections);
              break;

            case CLIENT_EVENTS.CREATE_ROOM_INVITE:
          await handleCreateRoomInvite(userId, payload, ws, connections);
              break;

            case CLIENT_EVENTS.USE_ROOM_INVITE:
          await handleUseRoomInvite(userId, payload, ws, connections);
              break;

            case CLIENT_EVENTS.SEARCH_ROOMS:
          await handleSearchRooms(userId, payload, ws, connections);
              break;

            case CLIENT_EVENTS.CREATE_DM:
          await handleCreateDM(userId, payload, ws, connections);
              break;

        // Notification Handlers
        case CLIENT_EVENTS.GET_UNREAD_COUNTS:
          await handleGetUnreadCounts(userId, ws);
                break;

        case CLIENT_EVENTS.GET_NOTIFICATION_PREFS:
          await handleGetNotificationPrefs(userId, ws);
              break;

        case CLIENT_EVENTS.UPDATE_NOTIFICATION_PREFS:
          await handleUpdateNotificationPrefs(userId, payload, ws);
              break;

        // Heartbeat
        case CLIENT_EVENTS.PING:
          ws.send(msgpack.encode([SERVER_EVENTS.PONG, { timestamp: new Date().toISOString() }, Date.now()]));
              break;

            default:
          console.log('❓ [SERVER] Unknown WebSocket event type:', eventType);
          ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { 
            error: 'Unknown event type' 
        }, Date.now()]));
      }
    } catch (error) {
      console.error('❌ [SERVER] WebSocket message handling error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { 
        error: 'Message processing failed' 
      }, Date.now()]));
    }
  }

  // Start the server
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`🚀 [SERVER] Server running on port ${PORT}`);
    console.log(`🔌 [SERVER] WebSocket server ready for connections`);
    console.log(`🔐 [SERVER] WebSocket authentication required for all connections`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('🛑 [SERVER] SIGTERM received, shutting down gracefully...');
    
    // Close all WebSocket connections
    connections.forEach((ws, userId) => {
      console.log(`🔌 [SERVER] Closing connection for user ${userId}`);
      ws.close(1000, 'Server shutting down');
    });
    
    // Close the server
    server.close(() => {
      console.log('✅ [SERVER] Server closed successfully');
      process.exit(0);
    });
  });

  process.on('SIGINT', async () => {
    console.log('🛑 [SERVER] SIGINT received, shutting down gracefully...');
    
    // Close all WebSocket connections
    connections.forEach((ws, userId) => {
      console.log(`🔌 [SERVER] Closing connection for user ${userId}`);
      ws.close(1000, 'Server shutting down');
    });
    
    // Close the server
      server.close(() => {
      console.log('✅ [SERVER] Server closed successfully');
      process.exit(0);
    });
  });

} // Close startServer function

})(); // Close IIFE