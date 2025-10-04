// Load environment variables
require('dotenv').config({ path: '.env.local' });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const msgpack = require('msgpack-lite');
// Next.js removed - pure backend API and WebSocket server
// const jwt = require('jsonwebtoken'); // Not needed for session-based auth
const { prisma } = require('./lib/prisma');
const redis = require('./lib/redis');
const performanceMonitor = require('./scripts/performance-monitor');
const crypto = require('crypto');
const debug = require('./lib/debug');

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
  SEARCH_ROOMS: 'SEARCH_ROOMS'
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
  ROOM_ERROR: 'ROOM_ERROR'
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

  async function handleStartTyping(userId, payload) {
    try {
      const { channelId } = payload;
      await broadcastToChannel(channelId, SERVER_EVENTS.TYPING_STARTED, { userId, channelId }, userId);
    } catch (error) {
      console.error('Error handling typing start:', error);
      throw error;
    }
  }

  async function handleStopTyping(userId, payload) {
    try {
      const { channelId } = payload;
      await broadcastToChannel(channelId, SERVER_EVENTS.TYPING_STOPPED, { userId, channelId }, userId);
    } catch (error) {
      console.error('Error handling typing stop:', error);
      throw error;
    }
  }

  async function handleFetchMessages(userId, payload, ws) {
    try {
      const { channelId, limit = 50, before } = payload;
      
      // No caching for messages - they are real-time
      console.log('🔍 [MESSAGES] Fetching real-time messages for channel:', channelId);

      // Check membership with optimized query
      const membership = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: {
            channelId,
            userId
          }
        },
        select: { id: true } // Only select what we need
      });

      if (!membership) {
        const channel = await prisma.channel.findUnique({
          where: { id: channelId },
          select: {
            type: true,
            _count: {
              select: { members: true }
            }
          }
        });
        
        if (channel?.type === 'dm' && channel._count.members >= 2) {
          console.error('❌ [DM VALIDATION] Cannot add member to DM channel via WebSocket: already has 2 members', {
            channelId,
            currentMemberCount: channel._count.members,
            userId
          });
          return;
        }
        
        await prisma.channelMember.create({
          data: { channelId, userId }
        });
      }

      // Optimized message query with selective fields and better indexing
      const messages = await prisma.message.findMany({
        where: {
          channelId,
          deletedAt: null,
          ...(before && { sentAt: { lt: new Date(before) } })
        },
        select: {
          id: true,
          content: true,
          type: true,
          sentAt: true,
          editedAt: true,
          deletedAt: true,
          authorId: true,
          channelId: true,
          repliedToMessageId: true,
          attachments: true,
          isSystem: true,
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              walletAddress: true,
              role: true,
              isVerified: true,
              bio: true,
              twitterHandle: true,
              discordHandle: true,
              twitchHandle: true,
              spotifyHandle: true,
              status: true
            }
          },
          reactions: {
            select: {
              id: true,
              emoji: true,
              userId: true,
              user: {
                select: {
                  id: true,
                  username: true,
                  role: true
                }
              }
            }
          },
          repliedToMessage: {
            select: {
              id: true,
              content: true,
              authorId: true,
              author: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  walletAddress: true,
                  role: true,
                  isVerified: true,
                  bio: true,
                  twitterHandle: true,
                  discordHandle: true,
                  twitchHandle: true,
                  spotifyHandle: true,
                  status: true
                }
              }
            }
          }
        },
        orderBy: { sentAt: 'desc' },
        take: parseInt(limit)
      });

      const reversedMessages = messages.reverse();

      // Send messages directly without caching (real-time)
      ws.send(msgpack.encode([SERVER_EVENTS.MESSAGES_LOADED, {
        channelId,
        messages: reversedMessages
      }, Date.now()]));

    } catch (error) {
      console.error('❌ [SERVER] Error fetching messages:', error);
      throw error;
    }
  }

  async function handleFetchChannels(userId, payload, ws) {
    try {
      console.log('🔍 [SERVER] Fetching channels for user:', userId);
      console.log('🔍 [DEBUG] User ID type:', typeof userId, 'Value:', userId);
      
      const startTime = Date.now();
      const userCacheKey = redis.getUserChannelsKey(userId);
      const publicChannelsKey = 'channels:public';
      
      // Check both user-specific cache and public channels cache
      const [cachedUserChannels, cachedPublicChannels] = await Promise.all([
        redis.get(userCacheKey),
        redis.get(publicChannelsKey)
      ]);
      
      // If we have both caches, merge them
      let cachedChannels = null;
      if (cachedUserChannels && cachedPublicChannels) {
        // Merge user channels with public channels, avoiding duplicates
        const userChannelIds = new Set(cachedUserChannels.map(c => c.id));
        const publicChannels = cachedPublicChannels.filter(c => !userChannelIds.has(c.id));
        cachedChannels = [...cachedUserChannels, ...publicChannels];
        console.log('🔍 [CACHE] Merged user cache with public cache:', {
          userChannels: cachedUserChannels.length,
          publicChannels: publicChannels.length,
          total: cachedChannels.length
        });
      } else if (cachedUserChannels) {
        cachedChannels = cachedUserChannels;
        console.log('🔍 [CACHE] Using user cache only:', cachedChannels.length);
      }
      
      // Check cache and start community channel upsert in parallel
      const [] = await Promise.all([
        // Ensure user is added to the L4 Community Chat channel (non-blocking)
        (async () => {
          try {
            const communityChannel = await prisma.channel.findFirst({
              where: {
                name: 'L4 Community Group',
                type: 'text-group'
              }
            });

            if (communityChannel) {
              await prisma.channelMember.upsert({
                where: {
                  channelId_userId: {
                    channelId: communityChannel.id,
                    userId: userId
                  }
                },
                create: {
                  channelId: communityChannel.id,
                  userId: userId
                },
                update: {}
              });
              console.log('✅ User added to L4 Community Chat channel via WebSocket');
            }
          } catch (error) {
            console.error('Error ensuring user membership in community channel:', error);
          }
        })()
      ]);
      
      // CACHE VALIDATION - Check if cache is valid before using
      if (cachedChannels) {
        const isCacheValid = await validateCacheVsDatabase(userId);
        if (isCacheValid) {
          performanceMonitor.recordCacheHit();
          console.log('⚡ [CACHE] Channels served from validated cache for user:', userId);
          console.log('🔍 [DEBUG] Cached channels count:', cachedChannels.length);
          ws.send(msgpack.encode([SERVER_EVENTS.CHANNELS_LOADED, {
            channels: cachedChannels
          }, Date.now()]));
          return;
        } else {
          console.log('❌ [CACHE] Cache validation failed, fetching from database...');
        }
      }
      
      console.log('❌ [CACHE] No cached channels found, querying database...');
      performanceMonitor.recordCacheMiss();
      
      console.log('🔍 [DEBUG] Fetching channels for user:', userId, 'with privacy restrictions');

      // Optimized query with better indexing and selective fields
      const queryStartTime = Date.now();
      const channels = await prisma.channel.findMany({
        where: {
          OR: [
            // User is a member of the channel
            {
              members: {
                some: {
                  userId: userId
                }
              }
            },
            // Public channels (rooms) - visible to everyone
            {
              type: 'text-group',
              isPrivate: false
            }
          ]
        },
        select: {
          id: true,
          name: true,
          type: true,
          createdBy: true,
          uid: true,
          roomId: true,
          createdAt: true,
          updatedAt: true,
          isPrivate: true,
          lastMessageId: true,
          topic: true,
                members: {
                  select: {
                    id: true,
                    userId: true,
                    user: {
                      select: {
                        id: true,
                        username: true,
                        displayName: true,
                        avatarUrl: true,
                        role: true,
                        isVerified: true,
                        bio: true,
                        twitterHandle: true,
                        discordHandle: true,
                        twitchHandle: true,
                        spotifyHandle: true,
                        status: true
                      }
                    }
                  }
                },
          uidUser: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              role: true,
              isVerified: true,
              bio: true,
              twitterHandle: true,
              discordHandle: true,
              twitchHandle: true,
              spotifyHandle: true,
              status: true
            }
          },
          createdByUser: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              role: true
            }
          },
          room: {
            select: {
              id: true,
              members: {
                select: {
                  userId: true,
                  role: true
                }
              }
            }
          },
          _count: {
            select: {
              messages: true
            }
          }
        },
        orderBy: {
          updatedAt: 'desc' // Use updatedAt for better performance
        }
      });

      // Send response immediately, cache in background
      console.log('📤 [SERVER] Sending channels response immediately');
      console.log('🔍 [DEBUG] Channels being sent to frontend:', channels.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        isPrivate: c.isPrivate,
        createdBy: c.createdBy,
        roomId: c.roomId
      })));
      ws.send(msgpack.encode([SERVER_EVENTS.CHANNELS_LOADED, {
        channels: channels
      }, Date.now()]));
      
      // Cache the result in background (non-blocking) with longer TTL
      const userChannels = channels.filter(c => 
        c.members?.some(m => m.userId === userId)
      );
      const publicChannels = channels.filter(c => 
        c.type === 'text-group' && !c.isPrivate
      );
      
      // Cache user-specific channels with short TTL (2 minutes)
      redis.set(userCacheKey, userChannels, 120).then(() => {
        console.log('💾 [CACHE] User channels cached (TTL: 2min):', userChannels.length);
      }).catch(error => {
        console.error('❌ [CACHE] Failed to cache user channels:', error);
      });
      
      // Cache public channels globally with short TTL (2 minutes)
      redis.set(publicChannelsKey, publicChannels, 120).then(() => {
        console.log('💾 [CACHE] Public channels cached (TTL: 2min):', publicChannels.length);
      }).catch(error => {
        console.error('❌ [CACHE] Failed to cache public channels:', error);
      });

      // Record performance metrics
      const queryDuration = Date.now() - queryStartTime;
      const totalDuration = Date.now() - startTime;
      performanceMonitor.recordQuery('fetchChannels', queryDuration);

      console.log('✅ [SERVER] Channels fetched successfully:', {
        userId,
        channelCount: channels.length,
        channelIds: channels.map(c => c.id),
        queryDuration: `${queryDuration}ms`,
        totalDuration: `${totalDuration}ms`
      });

    } catch (error) {
      console.error('❌ [SERVER] Error fetching channels:', error);
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

  async function handleAddReaction(userId, payload) {
    try {
      const { messageId, emoji } = payload;
      
      if (!messageId || !emoji) {
        throw new Error('Message ID and emoji are required');
      }

      // Check if user has access to this message (via channel membership)
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        include: {
          channel: {
            include: {
              members: {
                where: { userId }
              }
            }
          }
        }
      });

      if (!message) {
        throw new Error('Message not found');
      }

      if (message.channel.members.length === 0) {
        throw new Error('Access denied: You do not have access to this message');
      }

      // Validate emoji - only allow the 6 Messenger emojis
      const allowedEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
      if (!allowedEmojis.includes(emoji)) {
        throw new Error('Invalid emoji. Only 👍, ❤️, 😂, 😮, 😢, 🙏 are allowed');
      }

      // Check if user already has ANY reaction on this message (Messenger: one reaction per user)
      const existingReaction = await prisma.messageReaction.findFirst({
        where: {
          messageId,
          userId
        }
      });

      if (existingReaction) {
        if (existingReaction.emoji === emoji) {
          // Same emoji - remove it (toggle off)
          await prisma.messageReaction.delete({
            where: {
              messageId_userId_emoji: {
                messageId,
                userId,
                emoji: existingReaction.emoji
              }
            }
          });
          
          console.log('✅ [SERVER] Reaction removed (toggle off):', {
            messageId,
            userId,
            emoji
          });

          // Broadcast reaction removal to all channel members
          await broadcastToChannel(message.channelId, SERVER_EVENTS.REACTION_REMOVED, {
            messageId,
            userId,
            emoji: existingReaction.emoji,
            reactionId: existingReaction.id
          }, userId);
        } else {
          // Different emoji - replace the existing one
          await prisma.messageReaction.delete({
            where: {
              messageId_userId_emoji: {
                messageId,
                userId,
                emoji: existingReaction.emoji
              }
            }
          });
          
          const newReaction = await prisma.messageReaction.create({
            data: {
              messageId,
              userId,
              emoji
            },
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  displayName: true
                }
              }
            }
          });
          
          console.log('✅ [SERVER] Reaction replaced:', {
            messageId,
            userId,
            oldEmoji: existingReaction.emoji,
            newEmoji: emoji,
            reactionId: newReaction.id
          });

          // Broadcast reaction addition to all channel members
          await broadcastToChannel(message.channelId, SERVER_EVENTS.REACTION_ADDED, newReaction, userId);
        }
      } else {
        // No existing reaction - add new one
        const reaction = await prisma.messageReaction.create({
          data: {
            messageId,
            userId,
            emoji
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true
              }
            }
          }
        });

        console.log('✅ [SERVER] Reaction added:', {
          messageId,
          userId,
          emoji,
          reactionId: reaction.id
        });

        // Broadcast reaction to all channel members
        await broadcastToChannel(message.channelId, SERVER_EVENTS.REACTION_ADDED, reaction, userId);
      }
    } catch (error) {
      console.error('❌ [SERVER] Error adding reaction:', error);
      throw error;
    }
  }

  async function handleRemoveReaction(userId, payload) {
    try {
      const { messageId, emoji } = payload;
      
      if (!messageId || !emoji) {
        throw new Error('Message ID and emoji are required');
      }

      // Check if user has access to this message (via channel membership)
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        include: {
          channel: {
            include: {
              members: {
                where: { userId }
              }
            }
          }
        }
      });

      if (!message) {
        throw new Error('Message not found');
      }

      if (message.channel.members.length === 0) {
        throw new Error('Access denied: You do not have access to this message');
      }

      // Find and delete the reaction
      const reaction = await prisma.messageReaction.findUnique({
        where: {
          messageId_userId_emoji: {
            messageId,
            userId,
            emoji
          }
        }
      });

      if (!reaction) {
        console.log('⚠️ [SERVER] Reaction not found:', {
          messageId,
          userId,
          emoji
        });
        return; // Silently return - don't throw error for non-existent reactions
      }

      await prisma.messageReaction.delete({
        where: {
          messageId_userId_emoji: {
            messageId,
            userId,
            emoji
          }
        }
      });

      console.log('✅ [SERVER] Reaction removed:', {
        messageId,
        userId,
        emoji,
        reactionId: reaction.id
      });

      // Broadcast reaction removal to all channel members
      await broadcastToChannel(message.channelId, SERVER_EVENTS.REACTION_REMOVED, {
        messageId,
        userId,
        emoji,
        reactionId: reaction.id
      }, userId);
    } catch (error) {
      console.error('❌ [SERVER] Error removing reaction:', error);
      throw error;
    }
  }

  // WebSocket server setup
  const server = createServer(app);
  
  // Start performance monitoring
  performanceMonitor.startMonitoring();
  
  const wss = new WebSocketServer({ server });

  // Remove separate authWss - handle all connections in main wss

  // Storage WebSocket handlers
  async function handleStorageGet(userId, payload, ws) {
    try {
      const { key } = payload;
      if (!key) {
        ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_GET_RESPONSE, { error: 'Key is required' }, Date.now()]));
        return;
      }

      const storageKey = `storage:${userId}:${key}`;
      const data = await redis.get(storageKey);
      
      if (data === null) {
        ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_GET_RESPONSE, { error: 'Key not found' }, Date.now()]));
        return;
      }

      // Parse the stored data
      let parsedData;
      try {
        parsedData = JSON.parse(data);
      } catch (parseError) {
        parsedData = { value: data, timestamp: Date.now() };
      }

      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_GET_RESPONSE, parsedData, Date.now()]));
    } catch (error) {
      console.error('❌ [STORAGE WS] Get error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_GET_RESPONSE, { error: 'Failed to get storage item' }, Date.now()]));
    }
  }

  async function handleStorageSet(userId, payload, ws) {
    try {
      const { key, value, ttl } = payload;
      if (!key || value === undefined) {
        ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_SET_RESPONSE, { error: 'Key and value are required' }, Date.now()]));
        return;
      }

      const storageKey = `storage:${userId}:${key}`;
      const storageData = {
        value,
        timestamp: Date.now(),
        ttl: ttl || null
      };

      const ttlSeconds = ttl || 86400; // Default 24 hours
      await redis.set(storageKey, JSON.stringify(storageData), ttlSeconds);
      
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_SET_RESPONSE, { success: true, key, ttl: ttlSeconds }, Date.now()]));
    } catch (error) {
      console.error('❌ [STORAGE WS] Set error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_SET_RESPONSE, { error: 'Failed to set storage item' }, Date.now()]));
    }
  }

  async function handleStorageDelete(userId, payload, ws) {
    try {
      const { key } = payload;
      if (!key) {
        ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_DELETE_RESPONSE, { error: 'Key is required' }, Date.now()]));
        return;
      }

      const storageKey = `storage:${userId}:${key}`;
      await redis.del(storageKey);
      
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_DELETE_RESPONSE, { success: true, key }, Date.now()]));
    } catch (error) {
      console.error('❌ [STORAGE WS] Delete error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_DELETE_RESPONSE, { error: 'Failed to delete storage item' }, Date.now()]));
    }
  }

  async function handleStorageList(userId, payload, ws) {
    try {
      const pattern = `storage:${userId}:*`;
      const keys = await redis.keys(pattern);
      
      // Extract just the key names (remove the storage:userId: prefix)
      const keyNames = keys.map(key => key.replace(`storage:${userId}:`, ''));
      
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_LIST_RESPONSE, { keys: keyNames, count: keyNames.length }, Date.now()]));
    } catch (error) {
      console.error('❌ [STORAGE WS] List error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_LIST_RESPONSE, { error: 'Failed to list storage keys' }, Date.now()]));
    }
  }

  async function handleStorageClear(userId, payload, ws) {
    try {
      const pattern = `storage:${userId}:*`;
      const keys = await redis.keys(pattern);
      
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_CLEAR_RESPONSE, { success: true, clearedCount: keys.length }, Date.now()]));
    } catch (error) {
      console.error('❌ [STORAGE WS] Clear error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.STORAGE_CLEAR_RESPONSE, { error: 'Failed to clear storage' }, Date.now()]));
    }
  }

  async function handleAudioSettingsGet(userId, payload, ws) {
    try {
      const audioKeys = ['audioEnabled', 'audioVolume', 'audioMuted'];
      const settings = {};
      
      for (const key of audioKeys) {
        const storageKey = `storage:${userId}:${key}`;
        const data = await redis.get(storageKey);
        if (data) {
          try {
            const parsed = JSON.parse(data);
            settings[key] = parsed.value;
          } catch {
            settings[key] = data;
          }
        }
      }
      
      ws.send(msgpack.encode([SERVER_EVENTS.AUDIO_SETTINGS_GET_RESPONSE, { settings }, Date.now()]));
    } catch (error) {
      console.error('❌ [AUDIO WS] Get error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.AUDIO_SETTINGS_GET_RESPONSE, { error: 'Failed to get audio settings' }, Date.now()]));
    }
  }

  async function handleAudioSettingsSet(userId, payload, ws) {
    try {
      const { settings } = payload;
      if (!settings || typeof settings !== 'object') {
        ws.send(msgpack.encode([SERVER_EVENTS.AUDIO_SETTINGS_SET_RESPONSE, { error: 'Settings object is required' }, Date.now()]));
        return;
      }

      const results = {};
      for (const [key, value] of Object.entries(settings)) {
        const storageKey = `storage:${userId}:${key}`;
        const storageData = {
          value,
          timestamp: Date.now(),
          ttl: 86400 * 30 // 30 days for audio settings
        };
        
        await redis.set(storageKey, JSON.stringify(storageData), 86400 * 30);
        results[key] = value;
      }
      
      ws.send(msgpack.encode([SERVER_EVENTS.AUDIO_SETTINGS_SET_RESPONSE, { success: true, settings: results }, Date.now()]));
    } catch (error) {
      console.error('❌ [AUDIO WS] Set error:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.AUDIO_SETTINGS_SET_RESPONSE, { error: 'Failed to set audio settings' }, Date.now()]));
    }
  }

  wss.on('error', (error) => {
    console.error('❌ [SERVER] WebSocket server error:', error);
  });

  wss.on('connection', async (ws, req) => {
    let userId = null;
    let username = null;
    let heartbeatInterval = null;
    let connectionTimeout = null;
    
    try {
      
      console.log('🔌 [SERVER] New WebSocket connection attempt:', {
        url: req.url,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString(),
        headers: req.headers
      });
      
      const url = new URL(req.url, `http://${req.headers.host}`);
      
      const token = url.searchParams.get('token');
      
      let userId = null;
      let username = 'Anonymous';
      
      // Check if this is an authentication connection (no token) or authenticated connection (with token)
      if (token) {
        // Authenticated connection - verify token
        const session = await prisma.session.findUnique({ 
          where: { token }, 
          include: { user: true } 
        });
        
        if (!session || session.expiresAt < new Date()) {
          console.log('❌ [SERVER] WebSocket connection rejected: Invalid or expired token', {
            hasSession: !!session,
            expiresAt: session?.expiresAt,
            currentTime: new Date(),
            token: token.substring(0, 10) + '...'
          });
          ws.close(1008, 'Invalid or expired token');
          return;
        }

        userId = session.userId;
        username = session.user.username || session.user.walletAddress;
      } else {
        // Unauthenticated connection - allow for authentication purposes
        console.log('🔐 [SERVER] WebSocket connection for authentication (no token provided)');
      }

    console.log('🔐 [SERVER] WebSocket authentication successful:', {
      userId,
      username,
      token: token ? token.substring(0, 10) + '...' : 'none',
      timestamp: new Date().toISOString()
    });

    // Check if user already has a connection (only for authenticated users)
    if (userId) {
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
    }

    // Set connection start time for tracking
    ws.connectionStartTime = Date.now();

    console.log('✅ [SERVER] WebSocket connected for user:', {
      userId,
      username,
      totalConnections: connections.size,
      timestamp: new Date().toISOString()
    });
    
    if (userId) {
      ws.send(msgpack.encode([SERVER_EVENTS.USER_STATUS_CHANGED, { 
        userId, 
        status: 'online' 
      }, Date.now()]));
    }

      ws.on('message', async (data) => {
        try {
          // Reset connection timeout on any activity
          resetConnectionTimeout();
          
          let eventType, payload;
          
          // Try to parse as msgpack first, then fall back to JSON
          try {
            const dataArray = new Uint8Array(data);
            [eventType, payload] = msgpack.decode(dataArray);
          } catch (msgpackError) {
            // Fall back to JSON parsing for authentication messages
            const jsonData = JSON.parse(data.toString());
            eventType = jsonData.type;
            payload = jsonData.payload;
          }
          
          console.log('🔵 [SERVER] WebSocket message received:', {
            eventType,
            payload: payload ? JSON.stringify(payload).substring(0, 100) + '...' : 'null',
            userId,
            timestamp: new Date().toISOString()
          });

          // Check authentication for most operations (except auth operations)
          if (!userId && !['AUTH_ME', 'AUTH_LOGIN', 'PING'].includes(eventType)) {
            console.log('❌ [SERVER] Unauthenticated user attempted operation:', eventType);
            ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Authentication required' }, Date.now()]));
            return;
          }

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
                
                // Encrypt user data
                try {
                  console.log('🔐 [SERVER] Starting AUTH_ME encryption process...');
                  const { encryptData } = require('./lib/encryption');
                  const dataToEncrypt = { user: userData, token };
                  console.log('🔐 [SERVER] AUTH_ME data to encrypt:', JSON.stringify(dataToEncrypt).substring(0, 100) + '...');
                  
                  const encryptedData = await encryptData(dataToEncrypt);
                  console.log('🔐 [SERVER] AUTH_ME encryption successful:', {
                    hasEncrypted: !!encryptedData.encrypted,
                    hasIv: !!encryptedData.iv,
                    hasTag: !!encryptedData.tag,
                    encryptedLength: encryptedData.encrypted?.length || 0
                  });
                  
                  ws.send(JSON.stringify({
                    type: 'AUTH_ME_RESPONSE',
                    success: true,
                    data: encryptedData,
                    encrypted: true
                  }));
                  
                  console.log('✅ [SERVER] AUTH_ME successful for user (encrypted):', user.username);
                } catch (encryptError) {
                  console.error('❌ [SERVER] AUTH_ME encryption failed:', encryptError);
                  console.warn('⚠️ [SERVER] Sending unencrypted AUTH_ME data as fallback');
                  
                  ws.send(JSON.stringify({
                    type: 'AUTH_ME_RESPONSE',
                    success: true,
                    data: { user: userData, token },
                    encrypted: false
                  }));
                }
              } catch (err) {
                console.error('❌ [SERVER] Error in AUTH_ME:', err);
                ws.send(JSON.stringify({
                  type: 'AUTH_ME_RESPONSE',
                  success: false,
                  error: 'Internal server error'
                }));
              }
              break;
              
            case CLIENT_EVENTS.AUTH_LOGIN:
              try {
                console.log('🔐 [SERVER] AUTH_LOGIN received, payload type:', typeof payload);
                console.log('🔐 [SERVER] AUTH_LOGIN payload:', payload);
                
                // Payload is already parsed from the WebSocket message
                const { walletAddress, jwtToken } = payload;
                
                console.log('🔐 [SERVER] Extracted values:', { 
                  walletAddress: walletAddress ? 'present' : 'missing', 
                  jwtToken: jwtToken ? 'present' : 'missing' 
                });
                
                if (!walletAddress || !jwtToken) {
                  ws.send(JSON.stringify({
                    type: 'AUTH_LOGIN_RESPONSE',
                    success: false,
                    error: 'Missing required fields'
                  }));
                  return;
                }
                
                // Verify JWT token (simplified for now)
                // In production, you'd properly verify the JWT signature
                try {
                  console.log('🔐 [SERVER] Verifying JWT token:', jwtToken.substring(0, 50) + '...');
                  
                  const tokenParts = jwtToken.split('.');
                  if (tokenParts.length !== 3) {
                    throw new Error('Invalid JWT format');
                  }
                  
                  const tokenPayload = JSON.parse(atob(tokenParts[1]));
                  const now = Math.floor(Date.now() / 1000);
                  
                  console.log('🔐 [SERVER] JWT payload:', tokenPayload);
                  console.log('🔐 [SERVER] Current time:', now, 'Token exp:', tokenPayload.exp);
                  
                  if (tokenPayload.exp < now) {
                    throw new Error('JWT token expired');
                  }
                  
                  if (tokenPayload.walletAddress !== walletAddress) {
                    throw new Error('JWT wallet address mismatch');
                  }
                  
                  console.log('🔐 [SERVER] JWT token verified for wallet:', walletAddress);
                } catch (jwtError) {
                  console.error('❌ [SERVER] JWT verification failed:', jwtError);
                  ws.send(JSON.stringify({
                    type: 'AUTH_LOGIN_RESPONSE',
                    success: false,
                    error: 'Invalid JWT token'
                  }));
                  return;
                }
                
                // Find or create user
                let user = await prisma.user.findUnique({
                  where: { walletAddress }
                });
                
                if (!user) {
                  // Create new user
                  user = await prisma.user.create({
                    data: {
                      walletAddress,
                      username: `user_${Date.now()}`,
                      displayName: `User ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
                      role: 1,
                      isVerified: false,
                      status: 'online'
                    }
                  });
                }
                
                // Create session
                const token = require('crypto').randomBytes(32).toString('hex');
                const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
                
                await prisma.session.create({
                  data: { token, userId: user.id, expiresAt }
                });
                
                // Get follower counts for the user
                const [followerCount, followingCount] = await Promise.all([
                  prisma.follow.count({ where: { followingId: user.id } }),
                  prisma.follow.count({ where: { followerId: user.id } })
                ]);

                // Prepare user data
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
                
                // Encrypt user data
                try {
                  console.log('🔐 [SERVER] Starting encryption process...');
                  const { encryptData } = require('./lib/encryption');
                  const dataToEncrypt = { user: userData, token };
                  console.log('🔐 [SERVER] Data to encrypt:', JSON.stringify(dataToEncrypt).substring(0, 100) + '...');
                  
                  const encryptedData = await encryptData(dataToEncrypt);
                  console.log('🔐 [SERVER] Encryption successful:', {
                    hasEncrypted: !!encryptedData.encrypted,
                    hasIv: !!encryptedData.iv,
                    hasTag: !!encryptedData.tag,
                    encryptedLength: encryptedData.encrypted?.length || 0
                  });
                  
                  ws.send(JSON.stringify({
                    type: 'AUTH_LOGIN_RESPONSE',
                    success: true,
                    data: encryptedData,
                    encrypted: true
                  }));
                  
                  console.log('✅ [SERVER] AUTH_LOGIN successful for user (encrypted):', user.username);
                } catch (encryptError) {
                  console.error('❌ [SERVER] Encryption failed:', encryptError);
                  console.warn('⚠️ [SERVER] Sending unencrypted data as fallback');
                  
                  ws.send(JSON.stringify({
                    type: 'AUTH_LOGIN_RESPONSE',
                    success: true,
                    data: { user: userData, token },
                    encrypted: false
                  }));
                }
              } catch (err) {
                console.error('❌ [SERVER] Error in AUTH_LOGIN:', err);
                ws.send(JSON.stringify({
                  type: 'AUTH_LOGIN_RESPONSE',
                  success: false,
                  error: 'Internal server error'
                }));
              }
              break;

            // Storage operations
            case CLIENT_EVENTS.STORAGE_GET:
              try {
                await handleStorageGet(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleStorageGet:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to get storage item' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.STORAGE_SET:
              try {
                await handleStorageSet(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleStorageSet:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to set storage item' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.STORAGE_DELETE:
              try {
                await handleStorageDelete(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleStorageDelete:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to delete storage item' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.STORAGE_LIST:
              try {
                await handleStorageList(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleStorageList:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to list storage items' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.STORAGE_CLEAR:
              try {
                await handleStorageClear(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleStorageClear:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to clear storage' }, Date.now()]));
              }
              break;

            // Audio settings
            case CLIENT_EVENTS.AUDIO_SETTINGS_GET:
              try {
                await handleAudioSettingsGet(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleAudioSettingsGet:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to get audio settings' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.AUDIO_SETTINGS_SET:
              try {
                await handleAudioSettingsSet(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleAudioSettingsSet:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to set audio settings' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.SEND_MESSAGE:
              try {
                await handleSendMessage(userId, payload);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleSendMessage:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to send message' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.JOIN_CHANNEL:
              try {
                await handleJoinChannel(userId, payload);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleJoinChannel:', err);
              }
              break;

            case CLIENT_EVENTS.START_TYPING:
              try {
                await handleStartTyping(userId, payload);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleStartTyping:', err);
              }
              break;

            case CLIENT_EVENTS.STOP_TYPING:
              try {
                await handleStopTyping(userId, payload);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleStopTyping:', err);
              }
              break;

            case CLIENT_EVENTS.FETCH_MESSAGES:
              try {
                await handleFetchMessages(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleFetchMessages:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to fetch messages' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.FETCH_CHANNELS:
              try {
                console.log('🔍 [SERVER] Fetching channels:', payload);
                await handleFetchChannels(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleFetchChannels:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to fetch channels' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.MARK_AS_READ:
              try {
                await handleMarkAsRead(userId, payload);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleMarkAsRead:', err);
              }
              break;

            case CLIENT_EVENTS.ADD_REACTION:
              try {
                await handleAddReaction(userId, payload);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleAddReaction:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to add reaction' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.REMOVE_REACTION:
              try {
                await handleRemoveReaction(userId, payload);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleRemoveReaction:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to remove reaction' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.PING:
                try {
                  // Echo back with Layer4 Tek acknowledgment
                  const responsePayload = payload?.protocol === 'LAYER4_TEK' 
                    ? { ...payload, acknowledged: true, serverTime: Date.now() }
                    : payload || {};
              
                  ws.send(msgpack.encode([SERVER_EVENTS.PONG, responsePayload, Date.now()]));
                  console.log('❤️ [SERVER] Layer4 Tek heartbeat acknowledged');
                } catch (err) {
                  console.error('❌ [SERVER] Error sending PONG:', err);
                }
                break;

            // Social features
            case CLIENT_EVENTS.FOLLOW_USER:
              try {
                await handleFollowUser(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleFollowUser:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to follow user' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.UNFOLLOW_USER:
              try {
                await handleUnfollowUser(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleUnfollowUser:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to unfollow user' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.SEND_POKE:
              try {
                await handleSendPoke(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleSendPoke:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to send poke' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.GET_USER_STATUS:
              try {
                await handleGetUserStatus(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleGetUserStatus:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to get user status' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.CHECK_FOLLOW_STATUS:
              try {
                await handleCheckFollowStatus(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleCheckFollowStatus:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to check follow status' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.GET_USER_STATS:
              try {
                await handleGetUserStats(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleGetUserStats:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to get user stats' }, Date.now()]));
              }
              break;

            // Room features
            case CLIENT_EVENTS.CREATE_ROOM:
              try {
                await handleCreateRoom(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleCreateRoom:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to create room' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.JOIN_ROOM:
              try {
                await handleJoinRoom(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleJoinRoom:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to join room' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.LEAVE_ROOM:
              try {
                await handleLeaveRoom(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleLeaveRoom:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to leave room' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.GET_ROOM_INFO:
              try {
                await handleGetRoomInfo(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleGetRoomInfo:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to get room info' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.CREATE_ROOM_INVITE:
              try {
                await handleCreateRoomInvite(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleCreateRoomInvite:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to create room invite' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.USE_ROOM_INVITE:
              try {
                await handleUseRoomInvite(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleUseRoomInvite:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to use room invite' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.GET_USER_ROOMS:
              try {
                await handleGetUserRooms(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleGetUserRooms:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to get user rooms' }, Date.now()]));
              }
              break;

            case CLIENT_EVENTS.SEARCH_ROOMS:
              try {
                await handleSearchRooms(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleSearchRooms:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to search rooms' }, Date.now()]));
              }
              break;
            case CLIENT_EVENTS.CREATE_ROOM_INVITE:
              try {
                await handleCreateRoomInvite(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleCreateRoomInvite:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Failed to create room invite' }, Date.now()]));
              }
              break;
            // DM features
            case CLIENT_EVENTS.CREATE_DM:
              try {
                await handleCreateDM(userId, payload, ws);
              } catch (err) {
                console.error('❌ [SERVER] Error in handleCreateDM:', err);
                ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to create DM' }, Date.now()]));
              }
              break;

            default:
              console.log('Unknown event type:', eventType);
          }
        } catch (error) {
          console.error('💥 [SERVER] UNCAUGHT ERROR in ws.on("message"):', error);
          try {
            ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Internal server error' }, Date.now()]));
          } catch (e) {
            console.error('Failed to send error to client:', e.message);
          }
        }
      });

      // Server-side heartbeat to prevent disconnections - More aggressive
      const startHeartbeat = () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(msgpack.encode([SERVER_EVENTS.PONG, { 
                serverHeartbeat: true, 
                timestamp: Date.now(),
                serverTime: new Date().toISOString(),
                connectionId: userId,
                serverLoad: connections.size
              }, Date.now()]));
            } catch (error) {
              console.error('❌ [SERVER] Heartbeat send error:', error);
              cleanup();
            }
          }
        }, 15000); // Send heartbeat every 15 seconds - more frequent
      };

      // Connection timeout to detect stale connections - More lenient
      const resetConnectionTimeout = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        
        // Only set timeout if connection is still open
        if (ws && ws.readyState === WebSocket.OPEN) {
          connectionTimeout = setTimeout(() => {
            console.log('⏰ [SERVER] Connection timeout - closing stale connection:', { 
              userId, 
              username,
              connectionAge: Date.now() - (ws.connectionStartTime || Date.now())
            });
            ws.close(1000, 'Connection timeout');
          }, 120000); // 2 minute timeout - more lenient
          
          console.log('🔄 [SERVER] Connection timeout reset for user:', { userId, username });
        }
      };

      // Cleanup function
      const cleanup = () => {
        console.log('🧹 [SERVER] Cleaning up connection for user:', { userId, username });
        
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        if (userId) {
          connections.delete(userId);
          updateUserPresence(userId, 'offline');
        }
      };

      // Start heartbeat immediately
      startHeartbeat();
      
      // Set initial timeout after a grace period to allow client to connect
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          resetConnectionTimeout();
          console.log('🔧 [SERVER] Connection setup complete for user:', {
            userId,
            username,
            readyState: ws.readyState,
            hasTimeout: !!connectionTimeout,
            hasHeartbeat: !!heartbeatInterval
          });
        }
      }, 5000); // 5 second grace period

      ws.on('close', (code, reason) => {
        console.log('🔌 [SERVER] WebSocket disconnected:', {
          userId,
          username,
          code,
          reason: reason.toString(),
          wasClean: code === 1000,
          totalConnections: connections.size - 1,
          timestamp: new Date().toISOString()
        });
        cleanup();
      });

      ws.on('error', (error) => {
        console.error('❌ [SERVER] WebSocket error:', {
          userId,
          username,
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
        cleanup();
      });

    } catch (error) {
      console.error('💥 [SERVER] Connection error:', error);
      try {
        ws.close(1008, 'Authentication failed');
      } catch (e) {
        console.error('Failed to close WebSocket after auth error:', e.message);
      }
    }
  });

  // Social features handlers
  async function handleFollowUser(userId, payload, ws) {
    try {
      const { targetUserId } = payload;
      
      if (!targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user ID is required' }, Date.now()]));
        return;
      }

      if (userId === targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Cannot follow yourself' }, Date.now()]));
        return;
      }

      // Check if follow relationship already exists
      const existingFollow = await prisma.follow.findFirst({
        where: {
          followerId: userId,
          followingId: targetUserId
        }
      });

      if (existingFollow) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Already following this user' }, Date.now()]));
        return;
      }

      // Create follow relationship
      await prisma.follow.create({
        data: {
          followerId: userId,
          followingId: targetUserId
        }
      });

      // Get follower's display name for notification
      const follower = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, username: true }
      });

      const followerName = follower?.displayName || follower?.username || 'Someone';

      // Create notification for the target user
      await prisma.notification.create({
        data: {
          userId: targetUserId,
          type: 'follow',
          title: 'New Follower',
          message: `${followerName} started following you!`,
          data: { fromUserId: userId, fromUserName: followerName }
        }
      });

      // Get updated follower counts for both users
      const [followerCount, followingCount] = await Promise.all([
        prisma.follow.count({ where: { followingId: targetUserId } }),
        prisma.follow.count({ where: { followerId: targetUserId } })
      ]);

      // Send success response with updated counts
      ws.send(msgpack.encode([SERVER_EVENTS.FOLLOW_SUCCESS, { 
        targetUserId,
        followerCount,
        followingCount 
      }, Date.now()]));

      // Notify target user if they're online
      const targetConnection = connections.get(targetUserId);
      if (targetConnection) {
        targetConnection.send(msgpack.encode([SERVER_EVENTS.NOTIFICATION_RECEIVED, {
          type: 'follow',
          title: 'New Follower',
          message: `${followerName} started following you!`,
          fromUserId: userId,
          fromUserName: followerName,
          followerCount,
          followingCount
        }, Date.now()]));
      }

      console.log('✅ [SOCIAL] User followed:', { fromUserId: userId, toUserId: targetUserId, followerCount, followingCount });
    } catch (error) {
      console.error('❌ [SOCIAL] Error in handleFollowUser:', error);
      throw error;
    }
  }

  async function handleUnfollowUser(userId, payload, ws) {
    try {
      const { targetUserId } = payload;
      
      if (!targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user ID is required' }, Date.now()]));
        return;
      }

      // Delete follow relationship
      const deletedFollow = await prisma.follow.deleteMany({
        where: {
          followerId: userId,
          followingId: targetUserId
        }
      });

      if (deletedFollow.count === 0) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Not following this user' }, Date.now()]));
        return;
      }

      // Get updated follower counts for the target user
      const [followerCount, followingCount] = await Promise.all([
        prisma.follow.count({ where: { followingId: targetUserId } }),
        prisma.follow.count({ where: { followerId: targetUserId } })
      ]);

      // Send success response with updated counts
      ws.send(msgpack.encode([SERVER_EVENTS.UNFOLLOW_SUCCESS, { 
        targetUserId,
        followerCount,
        followingCount 
      }, Date.now()]));

      console.log('✅ [SOCIAL] User unfollowed:', { fromUserId: userId, toUserId: targetUserId, followerCount, followingCount });
    } catch (error) {
      console.error('❌ [SOCIAL] Error in handleUnfollowUser:', error);
      throw error;
    }
  }

  async function handleSendPoke(userId, payload, ws) {
    try {
      const { targetUserId, message } = payload;
      
      if (!targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user ID is required' }, Date.now()]));
        return;
      }

      if (userId === targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Cannot poke yourself' }, Date.now()]));
        return;
      }

      // Create poke
      const poke = await prisma.poke.create({
        data: {
          fromUserId: userId,
          toUserId: targetUserId,
          message: message || null
        }
      });

      // Create notification for the target user
      await prisma.notification.create({
        data: {
          userId: targetUserId,
          type: 'poke',
          title: 'You got poked!',
          message: message || 'Someone poked you!',
          data: { fromUserId: userId, pokeId: poke.id }
        }
      });

      // Send success response
      ws.send(msgpack.encode([SERVER_EVENTS.POKE_SENT, { targetUserId, pokeId: poke.id }, Date.now()]));

      // Notify target user if they're online
      const targetConnection = connections.get(targetUserId);
      if (targetConnection) {
        targetConnection.send(msgpack.encode([SERVER_EVENTS.POKE_RECEIVED, {
          fromUserId: userId,
          message: message || 'Someone poked you!',
          pokeId: poke.id
        }, Date.now()]));
      }

      console.log('✅ [SOCIAL] Poke sent:', { fromUserId: userId, toUserId: targetUserId, message });
    } catch (error) {
      console.error('❌ [SOCIAL] Error in handleSendPoke:', error);
      throw error;
    }
  }

  async function handleGetUserStatus(userId, payload, ws) {
    try {
      const { targetUserId } = payload;
      
      if (!targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user ID is required' }, Date.now()]));
        return;
      }

      // Check if target user is connected to any channel
      const isOnline = connections.has(targetUserId);
      
      // Get user's last seen time
      const user = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { lastSeen: true, status: true }
      });

      ws.send(msgpack.encode([SERVER_EVENTS.USER_STATUS_RESPONSE, {
        targetUserId,
        isOnline,
        lastSeen: user?.lastSeen,
        status: user?.status || 'offline'
      }, Date.now()]));

      console.log('✅ [SOCIAL] User status retrieved:', { targetUserId, isOnline });
    } catch (error) {
      console.error('❌ [SOCIAL] Error in handleGetUserStatus:', error);
      throw error;
    }
  }

  // Handle check follow status
  async function handleCheckFollowStatus(userId, payload, ws) {
    try {
      const { targetUserId } = payload;
      
      if (!targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user ID is required' }, Date.now()]));
        return;
      }

      // Check if current user follows target user
      const isFollowing = await prisma.follow.findFirst({
        where: {
          followerId: userId,
          followingId: targetUserId
        }
      });

      // Check if target user follows current user
      const isFollowedBy = await prisma.follow.findFirst({
        where: {
          followerId: targetUserId,
          followingId: userId
        }
      });

      // Get follower counts for the target user
      const [followerCount, followingCount] = await Promise.all([
        prisma.follow.count({ where: { followingId: targetUserId } }),
        prisma.follow.count({ where: { followerId: targetUserId } })
      ]);

      ws.send(msgpack.encode([SERVER_EVENTS.FOLLOW_STATUS_RESPONSE, {
        targetUserId,
        isFollowing: !!isFollowing,
        isFollowedBy: !!isFollowedBy,
        followerCount,
        followingCount
      }, Date.now()]));

      console.log('✅ [SOCIAL] Follow status checked:', { targetUserId, isFollowing: !!isFollowing, isFollowedBy: !!isFollowedBy, followerCount, followingCount });
    } catch (error) {
      console.error('❌ [SOCIAL] Error in handleCheckFollowStatus:', error);
      throw error;
    }
  }

  // Handle get user stats
  async function handleGetUserStats(userId, payload, ws) {
    try {
      const { targetUserId } = payload;
      
      if (!targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user ID is required' }, Date.now()]));
        return;
      }

      // Get follower counts for the target user
      const [followerCount, followingCount] = await Promise.all([
        prisma.follow.count({ where: { followingId: targetUserId } }),
        prisma.follow.count({ where: { followerId: targetUserId } })
      ]);

      ws.send(msgpack.encode([SERVER_EVENTS.USER_STATS_RESPONSE, {
        targetUserId,
        followerCount,
        followingCount
      }, Date.now()]));

      console.log('✅ [SOCIAL] User stats retrieved:', { targetUserId, followerCount, followingCount });
    } catch (error) {
      console.error('❌ [SOCIAL] Error in handleGetUserStats:', error);
      throw error;
    }
  }

  // Room handlers
  async function handleCreateRoom(userId, payload, ws) {
    try {
      const { name, description, privacy = 1 } = payload;
      
      if (!name) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room name is required' }, Date.now()]));
        return;
      }

      // Check user's role and room creation limits
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true }
      });

      if (!user) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'User not found' }, Date.now()]));
        return;
      }

      // Check room creation limits based on role
      const userRoomCount = await prisma.room.count({
        where: { createdBy: userId }
      });

      const maxRooms = user.role === 0 || user.role === 3 ? Infinity : 2; // Admin/Dev: unlimited, Member/Moderator: 2
      
      if (userRoomCount >= maxRooms) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { 
          message: `You can only create ${maxRooms} rooms. Upgrade your role for more rooms.` 
        }, Date.now()]));
        return;
      }

      // Generate unique ID for all rooms
      const uniqueId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

      // Create room
      const room = await prisma.room.create({
        data: {
          name,
          description,
          privacy,
          uniqueId,
          createdByUser: {
            connect: { id: userId }
          }
        },
        include: {
          createdByUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          }
        }
      });

      // Create associated channel
      const channel = await prisma.channel.create({
        data: {
          name: name,
          type: 'text-group',
          createdBy: userId,
          roomId: room.id,
          isPrivate: privacy === 0
        }
      });

      // Add creator as room member with OWNER role
      await prisma.roomMember.create({
        data: {
          roomId: room.id,
          userId: userId,
          role: 'OWNER'
        }
      });

      // Add creator as channel member
      await prisma.channelMember.create({
        data: {
          channelId: channel.id,
          userId: userId
        }
      });

      // Get the room with member data for the response
      const roomWithMembers = await prisma.room.findUnique({
        where: { id: room.id },
        include: {
          members: {
            select: {
              userId: true,
              role: true
            }
          }
        }
      });

      ws.send(msgpack.encode([SERVER_EVENTS.ROOM_CREATED, {
        room: {
          ...room,
          channelId: channel.id,
          room: roomWithMembers
        }
      }, Date.now()]));

      console.log('✅ [ROOM] Room created:', { roomId: room.id, name, privacy });
      
      // AGGRESSIVE CACHE INVALIDATION - Clear ALL channel caches
      clearAllChannelCaches('room creation');

      // Invalidate public channels cache if this is a public room
      if (privacy === 1) {
        redis.del('channels:public').then(() => {
          console.log('🗑️ [CACHE] Invalidated public channels cache for new public room');
        }).catch(error => {
          console.error('❌ [CACHE] Failed to invalidate public channels cache:', error);
        });
        
        // Also invalidate all user caches since they need to see the new public room
        redis.keys('channels:user:*').then(keys => {
          if (keys.length > 0) {
            redis.del(...keys).then(() => {
              console.log('🗑️ [CACHE] Invalidated all user caches for new public room');
            }).catch(error => {
              console.error('❌ [CACHE] Failed to invalidate user caches:', error);
            });
          }
        }).catch(error => {
          console.error('❌ [CACHE] Failed to get user cache keys:', error);
        });
      }
    } catch (error) {
      console.error('❌ [ROOM] Error in handleCreateRoom:', error);
      throw error;
    }
  }

  async function handleJoinRoom(userId, payload, ws) {
    try {
      const { roomId, inviteCode } = payload;
      
      if (!roomId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room ID is required' }, Date.now()]));
        return;
      }

      // Get room details
      const room = await prisma.room.findUnique({
        where: { id: roomId },
        include: {
          createdByUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          },
          channel: true
        }
      });

      if (!room) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room not found' }, Date.now()]));
        return;
      }

      if (!room.isActive) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room is not active' }, Date.now()]));
        return;
      }

      // Check if user is already a member
      const existingMember = await prisma.roomMember.findFirst({
        where: { roomId, userId }
      });

      if (existingMember) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'You are already a member of this room' }, Date.now()]));
        return;
      }

      // Check privacy and invite code
      if (room.privacy === 0) {
        if (!inviteCode) {
          ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Invite code is required for private rooms' }, Date.now()]));
          return;
        }
        
        // Validate invite code
        const validInvite = await prisma.roomInvite.findFirst({
          where: {
            roomId,
            inviteCode,
            isUsed: false,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } }
            ]
          }
        });

        if (!validInvite) {
          ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Invalid or expired invite code' }, Date.now()]));
          return;
        }
      }

      // Check room capacity
      const memberCount = await prisma.roomMember.count({
        where: { roomId }
      });

      if (memberCount >= room.maxMembers) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room is full' }, Date.now()]));
        return;
      }

      // Add user as room member
      await prisma.roomMember.create({
        data: {
          roomId: room.id,
          userId: userId,
          role: 'MEMBER'
        }
      });

      // Add user as channel member
      await prisma.channelMember.create({
        data: {
          channelId: room.channel.id,
          userId: userId
        }
      });

      ws.send(msgpack.encode([SERVER_EVENTS.ROOM_JOINED, {
        room: {
          ...room,
          channelId: room.channel.id
        }
      }, Date.now()]));

      console.log('✅ [ROOM] User joined room:', { roomId, userId });
      
      // Clear caches after joining room
      clearAllChannelCaches('user joined room');
    } catch (error) {
      console.error('❌ [ROOM] Error in handleJoinRoom:', error);
      throw error;
    }
  }

  async function handleLeaveRoom(userId, payload, ws) {
    try {
      const { roomId } = payload;
      
      if (!roomId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room ID is required' }, Date.now()]));
        return;
      }

      // Check if user is a member
      const roomMember = await prisma.roomMember.findFirst({
        where: { roomId, userId },
        include: { room: true }
      });

      if (!roomMember) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'You are not a member of this room' }, Date.now()]));
        return;
      }

      // Remove from room
      await prisma.roomMember.delete({
        where: { id: roomMember.id }
      });

      // Remove from channel
      const channelMember = await prisma.channelMember.findFirst({
        where: { 
          channelId: roomMember.room.channel?.id,
          userId 
        }
      });

      if (channelMember) {
        await prisma.channelMember.delete({
          where: { id: channelMember.id }
        });
      }

      ws.send(msgpack.encode([SERVER_EVENTS.ROOM_LEFT, { roomId }, Date.now()]));

      console.log('✅ [ROOM] User left room:', { roomId, userId });
      
      // Clear caches after leaving room
      clearAllChannelCaches('user left room');
    } catch (error) {
      console.error('❌ [ROOM] Error in handleLeaveRoom:', error);
      throw error;
    }
  }

  async function handleGetRoomInfo(userId, payload, ws) {
    try {
      const { roomId } = payload;
      
      if (!roomId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room ID is required' }, Date.now()]));
        return;
      }

      const room = await prisma.room.findUnique({
        where: { id: roomId },
        include: {
          createdByUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          },
          channel: true,
          members: {
            include: {
              user: {
                select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
              }
            }
          }
        }
      });

      if (!room) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room not found' }, Date.now()]));
        return;
      }

      ws.send(msgpack.encode([SERVER_EVENTS.ROOM_INFO_RESPONSE, { room }, Date.now()]));

      console.log('✅ [ROOM] Room info retrieved:', { roomId });
    } catch (error) {
      console.error('❌ [ROOM] Error in handleGetRoomInfo:', error);
      throw error;
    }
  }

  async function handleGetUserRooms(userId, payload, ws) {
    try {
      const rooms = await prisma.room.findMany({
        where: {
          members: {
            some: { userId }
          }
        },
        include: {
          createdByUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          },
          channel: true,
          _count: {
            select: { members: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      ws.send(msgpack.encode([SERVER_EVENTS.USER_ROOMS_RESPONSE, { rooms }, Date.now()]));

      console.log('✅ [ROOM] User rooms retrieved:', { userId, count: rooms.length });
    } catch (error) {
      console.error('❌ [ROOM] Error in handleGetUserRooms:', error);
      throw error;
    }
  }

  async function handleSearchRooms(userId, payload, ws) {
    try {
      const { query } = payload;
      
      console.log('🔍 [SEARCH] Search request:', { userId, query, queryLength: query?.length });
      console.log('🔍 [SEARCH] Full payload:', payload);
      
      // Check if query looks like an invite code (alphanumeric, 20+ chars)
      const isInviteCode = /^[a-zA-Z0-9]{20,}$/.test(query);
      
      let rooms = [];
      let users = [];
      
      if (isInviteCode) {
        // Search for room by invite code
        const invite = await prisma.roomInvite.findFirst({
          where: {
            inviteCode: query,
            isUsed: false,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } }
            ]
          },
          include: {
            room: {
              include: {
                createdByUser: {
                  select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
                },
                _count: {
                  select: { members: true }
                }
              }
            }
          }
        });
        
        if (invite) {
          rooms = [invite.room];
        }
      } else {
        // Search for both public and private rooms
        // Public rooms: show all
        // Private rooms: show all in search results
        console.log('🔍 [SEARCH] Searching with query:', query || 'EMPTY_QUERY');
        
        // Check total counts
        const totalPublicRooms = await prisma.room.count({
          where: { privacy: 1, isActive: true }
        });
        console.log('🔍 [SEARCH] Total public rooms in database:', totalPublicRooms);
        
        const publicRooms = await prisma.room.findMany({
          where: {
            AND: [
              { privacy: 1 }, // Public rooms
              { isActive: true },
              ...(query && query.trim() ? [{
                OR: [
                  { name: { contains: query, mode: 'insensitive' } },
                  { description: { contains: query, mode: 'insensitive' } }
                ]
              }] : [])
            ]
          },
          include: {
            createdByUser: {
              select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
            },
            _count: {
              select: { members: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 10
        });

        // Private rooms: show all private rooms in search results
        console.log('🔍 [SEARCH] Searching private rooms with query:', query);
        
        // First, let's check if there are any private rooms at all
        const totalPrivateRooms = await prisma.room.count({
          where: { privacy: 0, isActive: true }
        });
        console.log('🔍 [SEARCH] Total private rooms in database:', totalPrivateRooms);
        
        const privateRooms = await prisma.room.findMany({
          where: {
            AND: [
              { privacy: 0 }, // Private rooms
              { isActive: true },
              ...(query && query.trim() ? [{
                OR: [
                  { name: { contains: query, mode: 'insensitive' } },
                  { description: { contains: query, mode: 'insensitive' } }
                ]
              }] : [])
            ]
          },
          include: {
            createdByUser: {
              select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
            },
            _count: {
              select: { members: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 10
        });
        
        console.log('🔍 [SEARCH] Private rooms found:', privateRooms.length, privateRooms.map(r => ({ id: r.id, name: r.name, privacy: r.privacy })));

        // Search for users
        if (query && query.trim().length > 0) {
          users = await prisma.user.findMany({
            where: {
              AND: [
                { id: { not: userId } }, // Don't include current user
                {
                  OR: [
                    { username: { contains: query, mode: 'insensitive' } },
                    { displayName: { contains: query, mode: 'insensitive' } }
                  ]
                }
              ]
            },
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              role: true,
              status: true,
              lastSeen: true
            },
            orderBy: { lastSeen: 'desc' },
            take: 10
          });
        }

        rooms = [...publicRooms, ...privateRooms];
        console.log('🔍 [SEARCH] Final results:', { 
          publicRooms: publicRooms.length, 
          privateRooms: privateRooms.length, 
          totalRooms: rooms.length,
          users: users.length 
        });
      }

      ws.send(msgpack.encode([SERVER_EVENTS.ROOMS_SEARCH_RESPONSE, { rooms, users }, Date.now()]));

      console.log('✅ [ROOM] Search completed:', { query, isInviteCode, roomsCount: rooms.length, usersCount: users.length });
    } catch (error) {
      console.error('❌ [ROOM] Error in handleSearchRooms:', error);
      throw error;
    }
  }

  async function handleCreateRoomInvite(userId, payload, ws) {
    try {
      const { roomId, message, expiresInHours = 24 } = payload;
      
      if (!roomId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room ID is required' }, Date.now()]));
        return;
      }

      console.log('🔍 [INVITE] Creating invite for room:', roomId, 'by user:', userId);
      
      // Check if user is a member of the room
      const roomMember = await prisma.roomMember.findFirst({
        where: { roomId, userId },
        include: { room: true }
      });

      console.log('🔍 [INVITE] Room member found:', roomMember ? {
        userId: roomMember.userId,
        role: roomMember.role,
        roomId: roomMember.roomId
      } : 'null');

      if (!roomMember) {
        console.log('❌ [INVITE] User is not a member of the room');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'You are not a member of this room' }, Date.now()]));
        return;
      }

      // Check if user has permission to create invites (ONLY OWNER)
      console.log('🔍 [INVITE] Checking role:', roomMember.role, 'isOwner:', roomMember.role === 'OWNER');
      if (roomMember.role !== 'OWNER') {
        console.log('❌ [INVITE] User is not the room owner');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Only room owners can create invite links' }, Date.now()]));
        return;
      }

      // Generate unique invite code
      const inviteCode = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      
      // Set expiration date
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + expiresInHours);

      // Create invite
      const invite = await prisma.roomInvite.create({
        data: {
          roomId,
          invitedBy: userId,
          message: message || null,
          expiresAt,
          inviteCode
        },
        include: {
          room: {
            select: {
              id: true,
              name: true,
              description: true,
              privacy: true,
              createdByUser: {
                select: { id: true, username: true, displayName: true, avatarUrl: true }
              }
            }
          },
          invitedByUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true }
          }
        }
      });

      ws.send(msgpack.encode([SERVER_EVENTS.ROOM_INVITE_CREATED, { invite }, Date.now()]));

      console.log('✅ [ROOM] Invite created:', { roomId, inviteCode, expiresAt });
    } catch (error) {
      console.error('❌ [ROOM] Error in handleCreateRoomInvite:', error);
      throw error;
    }
  }

  async function handleUseRoomInvite(userId, payload, ws) {
    try {
      const { inviteCode } = payload;
      
      console.log('🔍 [USE_INVITE] Processing invite code:', { userId, inviteCode, payload });
      
      if (!inviteCode) {
        console.log('❌ [USE_INVITE] No invite code provided');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Invite code is required' }, Date.now()]));
        return;
      }

      // Find the invite
      console.log('🔍 [USE_INVITE] Searching for invite with code:', inviteCode);
      const invite = await prisma.roomInvite.findFirst({
        where: {
          inviteCode,
          isUsed: false,
          expiresAt: { gt: new Date() }
        },
        include: {
          room: {
            include: {
              channel: true,
              createdByUser: {
                select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
              }
            }
          }
        }
      });

      console.log('🔍 [USE_INVITE] Invite found:', invite ? { 
        id: invite.id, 
        roomId: invite.roomId, 
        isUsed: invite.isUsed,
        expiresAt: invite.expiresAt,
        inviteCode: invite.inviteCode
      } : 'null');

      if (!invite) {
        console.log('❌ [USE_INVITE] Invalid or expired invite code - no invite found');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { 
          message: 'Invalid or expired invite code',
          type: 'INVALID_INVITE_CODE'
        }, Date.now()]));
        return;
      }

      // Double-check invite is not used
      if (invite.isUsed) {
        console.log('❌ [USE_INVITE] Invite code already used');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { 
          message: 'Invite code has already been used',
          type: 'INVALID_INVITE_CODE'
        }, Date.now()]));
        return;
      }

      // Double-check invite is not expired
      if (invite.expiresAt && new Date() > invite.expiresAt) {
        console.log('❌ [USE_INVITE] Invite code has expired');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { 
          message: 'Invite code has expired',
          type: 'INVALID_INVITE_CODE'
        }, Date.now()]));
        return;
      }

      // Validate room and channel exist
      if (!invite.room) {
        console.log('❌ [USE_INVITE] Room not found for invite');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { 
          message: 'Room not found',
          type: 'INVALID_INVITE_CODE'
        }, Date.now()]));
        return;
      }

      if (!invite.room.channel) {
        console.log('❌ [USE_INVITE] Channel not found for room');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { 
          message: 'Channel not found',
          type: 'INVALID_INVITE_CODE'
        }, Date.now()]));
        return;
      }

      // Check if user is already a member
      const existingMember = await prisma.roomMember.findFirst({
        where: { roomId: invite.roomId, userId }
      });

      if (existingMember) {
        console.log('❌ [USE_INVITE] User already a member of this room');
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { 
          message: 'You are already a member of this room',
          type: 'ALREADY_MEMBER'
        }, Date.now()]));
        return;
      }

      // Check room capacity
      const memberCount = await prisma.roomMember.count({
        where: { roomId: invite.roomId }
      });

      if (memberCount >= invite.room.maxMembers) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room is full' }, Date.now()]));
        return;
      }

      // Add user as room member
      console.log('🔍 [USE_INVITE] Adding user as room member:', { roomId: invite.roomId, userId });
      await prisma.roomMember.create({
        data: {
          roomId: invite.roomId,
          userId: userId,
          role: 'MEMBER'
        }
      });

      // Add user as channel member
      console.log('🔍 [USE_INVITE] Adding user as channel member:', { channelId: invite.room.channel.id, userId });
      await prisma.channelMember.create({
        data: {
          channelId: invite.room.channel.id,
          userId: userId
        }
      });

      // Mark invite as used
      await prisma.roomInvite.update({
        where: { id: invite.id },
        data: {
          isUsed: true,
          usedAt: new Date(),
          usedBy: userId
        }
      });

      // Get the complete channel data with room members for the response
      const channelWithRoomData = await prisma.channel.findUnique({
        where: { id: invite.room.channel.id },
        include: {
          room: {
            select: {
              id: true,
              members: {
                select: {
                  userId: true,
                  role: true
                }
              }
            }
          },
          createdByUser: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              role: true
            }
          }
        }
      });

      console.log('🔍 [USE_INVITE] Sending success response');
      const responseData = {
        room: {
          ...invite.room,
          channelId: invite.room.channel.id
        },
        channel: channelWithRoomData
      };
      console.log('🔍 [USE_INVITE] Response data:', responseData);
      ws.send(msgpack.encode([SERVER_EVENTS.ROOM_INVITE_USED, responseData, Date.now()]));

      console.log('✅ [ROOM] User joined via invite:', { roomId: invite.roomId, userId, inviteCode });
      
      // Clear caches after joining via invite
      clearAllChannelCaches('user joined via invite');
    } catch (error) {
      console.error('❌ [ROOM] Error in handleUseRoomInvite:', error);
      throw error;
    }
  }

  async function handleCreateRoomInvite(userId, payload, ws) {
    try {
      const { roomId, message, expiresInHours = 24 } = payload;
      
      if (!roomId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Room ID is required' }, Date.now()]));
        return;
      }

      // Check if user is room member with appropriate permissions
      const roomMember = await prisma.roomMember.findFirst({
        where: { roomId, userId },
        include: { room: true }
      });

      if (!roomMember || !['OWNER', 'ADMIN', 'MODERATOR'].includes(roomMember.role)) {
        ws.send(msgpack.encode([SERVER_EVENTS.ROOM_ERROR, { message: 'Insufficient permissions to create invites' }, Date.now()]));
        return;
      }

      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + expiresInHours);

      // Generate unique invite code
      const inviteCode = crypto.randomBytes(20).toString('hex');

      const invite = await prisma.roomInvite.create({
        data: {
          roomId,
          invitedBy: userId,
          message,
          inviteCode,
          expiresAt
        }
      });

      ws.send(msgpack.encode([SERVER_EVENTS.ROOM_INVITE_CREATED, { invite }, Date.now()]));

      console.log('✅ [ROOM] Room invite created:', { roomId, inviteId: invite.id });
    } catch (error) {
      console.error('❌ [ROOM] Error in handleCreateRoomInvite:', error);
      throw error;
    }
  }


  // DM handlers
  async function handleCreateDM(userId, payload, ws) {
    try {
      const { userId: targetUserId } = payload;
      
      if (!targetUserId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user ID is required' }, Date.now()]));
        return;
      }

      if (targetUserId === userId) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Cannot create DM with yourself' }, Date.now()]));
        return;
      }

      // Check if target user exists
      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
      });

      if (!targetUser) {
        ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Target user not found' }, Date.now()]));
        return;
      }

      // Check if DM channel already exists between these users
      // We need to find a DM channel where BOTH users are members
      debug.log(`🔍 [CREATE_DM] Checking for existing DM between users: ${userId} and ${targetUserId}`);
      
      const existingDM = await prisma.channel.findFirst({
        where: {
          type: 'dm',
          members: {
            some: {
              userId: userId
            }
          }
        },
        include: {
          members: {
            where: {
              userId: {
                in: [userId, targetUserId]
              }
            },
            select: {
              userId: true
            }
          },
          uidUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          },
          createdByUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          },
          _count: {
            select: { messages: true }
          }
        }
      });

      // Verify that both users are actually members of this DM channel
      if (existingDM && existingDM.members.length === 2) {
        const memberUserIds = existingDM.members.map(m => m.userId);
        const bothUsersPresent = memberUserIds.includes(userId) && memberUserIds.includes(targetUserId);
        
        debug.log(`🔍 [CREATE_DM] Found DM with members: ${memberUserIds.join(', ')}`);
        debug.log(`🔍 [CREATE_DM] Both users present: ${bothUsersPresent}`);
        
        if (!bothUsersPresent) {
          // This DM doesn't actually contain both users, continue to create new one
          debug.log(`⚠️ [CREATE_DM] DM found but doesn't contain both users, creating new one`);
          existingDM = null;
        } else {
          debug.log(`✅ [CREATE_DM] Found existing DM between both users: ${existingDM.id}`);
        }
      } else if (existingDM) {
        // DM exists but doesn't have exactly 2 members, continue to create new one
        debug.log(`⚠️ [CREATE_DM] DM found but has ${existingDM.members.length} members, creating new one`);
        existingDM = null;
      } else {
        debug.log(`ℹ️ [CREATE_DM] No existing DM found, will create new one`);
      }

      if (existingDM) {
        // DM already exists, just return it
        ws.send(msgpack.encode([SERVER_EVENTS.DM_CREATED, { channel: existingDM }, Date.now()]));
        return;
      }

      // Create new DM channel
      debug.log(`🆕 [CREATE_DM] Creating new DM channel between users: ${userId} and ${targetUserId}`);
      
      const dmChannel = await prisma.channel.create({
        data: {
          type: 'dm',
          createdBy: userId,
          uid: targetUserId,
          isPrivate: true
        },
        include: {
          uidUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          },
          createdByUser: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true }
          },
          _count: {
            select: { messages: true }
          }
        }
      });

      // Add both users as members
      await prisma.channelMember.createMany({
        data: [
          { channelId: dmChannel.id, userId: userId },
          { channelId: dmChannel.id, userId: targetUserId }
        ]
      });

      debug.log(`✅ [CREATE_DM] Successfully created DM channel: ${dmChannel.id} with both users as members`);

      // Clear cache for both users
      await clearAllChannelCaches('DM created');

      ws.send(msgpack.encode([SERVER_EVENTS.DM_CREATED, { channel: dmChannel }, Date.now()]));

      console.log('✅ [DM] DM created:', { channelId: dmChannel.id, userId, targetUserId });
    } catch (error) {
      console.error('❌ [DM] Error in handleCreateDM:', error);
      ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Failed to create DM' }, Date.now()]));
    }
  }

  const port = process.env.EXPRESS_PORT || 3002;
  const host = process.env.HOST || '0.0.0.0'; // ← Changed to 0.0.0.0 for external access
  const protocol = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';
  const WSS_URL = process.env.NEXT_PUBLIC_SOCKET_URL;
  const domain = process.env.NODE_ENV === 'production' ? process.env.DOMAIN || 'demo.lay4r.io' : `localhost:${port}`;
  
  server.listen(port, host, () => { // ← Added host parameter
    console.log('🚀 [SERVER] Express server started:', {
      port,
      host,
      apiUrl: `${protocol === 'wss' ? 'https' : 'http'}://${domain}/api`,
      websocketUrl: `${WSS_URL}`,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  });

  // Graceful shutdown handling
  const gracefulShutdown = async (signal) => {
    console.log(`\n🛑 [SERVER] Received ${signal}. Starting graceful shutdown...`);
    
    try {
      // Close WebSocket server
      console.log('🔌 [SERVER] Closing WebSocket server...');
      wss.close(() => {
        console.log('✅ [SERVER] WebSocket server closed');
      });
      
      // Close HTTP server
      console.log('🌐 [SERVER] Closing HTTP server...');
      server.close(() => {
        console.log('✅ [SERVER] HTTP server closed');
      });
      
      // Disconnect from database
      console.log('🔌 [DATABASE] Disconnecting from database...');
      await prisma.$disconnect();
      console.log('✅ [DATABASE] Database disconnected');
      
      console.log('✅ [SERVER] Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('❌ [SERVER] Error during graceful shutdown:', error);
      process.exit(1);
    }
  };

  // Handle different shutdown signals
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For nodemon

  // Handle uncaught exceptions
  process.on('uncaughtException', async (error) => {
    console.error('💥 [SERVER] Uncaught Exception:', error);
    await gracefulShutdown('UNCAUGHT_EXCEPTION');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', async (reason, promise) => {
    console.error('💥 [SERVER] Unhandled Rejection at:', promise, 'reason:', reason);
    await gracefulShutdown('UNHANDLED_REJECTION');
  });
}