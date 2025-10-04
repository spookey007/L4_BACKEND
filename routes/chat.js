const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { prisma } = require('../lib/prisma');

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../public/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'chat-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Validation middleware
const validateMessage = (req, res, next) => {
  const { content } = req.body || {};
  
  // Check if content exists
  if (!content) {
    return res.status(400).json({ error: 'Message content is required' });
  }
  
  // Check content length
  if (content.length > 1000) {
    return res.status(400).json({ error: 'Message content too long. Maximum 1000 characters allowed.' });
  }
  
  // If we have an image file, validate it
  if (req.file && !req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Only image files are allowed' });
  }
  
  next();
};

// Validation middleware for rooms
const validateRoom = (req, res, next) => {
  const { name } = req.body || {};
  
  if (!name) {
    return res.status(400).json({ error: 'Room name is required' });
  }
  
  if (name.length > 50) {
    return res.status(400).json({ error: 'Room name too long. Maximum 50 characters allowed.' });
  }
  
  next();
};

// Get all users
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        lastSeen: true
      }
    });
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get all channels (rooms)
router.get('/channels', async (req, res) => {
  try {
    // Debug: Log all cookies and headers
    console.log('🔍 [CHANNELS API] Request headers:', {
      cookies: req.cookies,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      'user-agent': req.headers['user-agent']
    });

    // Get current user from session - try cookies first, then Authorization header
    let token = req.cookies?.l4_session;
    
    // Fallback: check Authorization header if no cookie
    if (!token && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        console.log('🔍 [CHANNELS API] Using token from Authorization header');
      }
    }
    
    if (!token) {
      console.log('❌ [CHANNELS API] No l4_session token found in cookies or Authorization header');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('🔍 [CHANNELS API] Found token:', token.substring(0, 20) + '...');

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    // Ensure user is added to the L4 Community Chat channel
    try {
      // Find the existing L4 Community Chat channel
      const communityChannel = await prisma.channel.findFirst({
        where: {
          name: 'L4 Community Group',
          type: 'text-group'
        }
      });

      if (communityChannel) {
        // Add user to the community channel if not already a member
        await prisma.channelMember.upsert({
          where: {
            channelId_userId: {
              channelId: communityChannel.id,
              userId: session.userId
            }
          },
          create: {
            channelId: communityChannel.id,
            userId: session.userId
          },
          update: {}
        });
        console.log('✅ User added to L4 Community Chat channel');
      } else {
        console.log('⚠️ L4 Community Chat channel not found in database');
      }
    } catch (error) {
      console.error('Error ensuring user membership in community channel:', error);
      // Continue even if this fails - don't break the entire request
    }

    // Return channels where user is a member OR public text-group channels
    const channels = await prisma.channel.findMany({
      where: {
        OR: [
          // User is a member of the channel
          {
            members: {
              some: {
                userId: session.userId
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
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true
              }
            }
          }
        },
        // For DMs, also include the other user's data via uid
        uidUser: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        },
        _count: {
          select: {
            messages: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    res.json({ channels });
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// Create new channel
router.post('/channels', async (req, res) => {
  try {
    const { name, type = 'text', topic } = req.body;
    
    const channel = await prisma.channel.create({
      data: {
        name,
        type,
        topic,
        createdBy: 'system',
        isPrivate: false // System channels are public by default
      }
    });
    
    res.status(201).json({ channel });
  } catch (error) {
    console.error('Error creating channel:', error);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// Get channel messages
// router.get('/channels/:id/messages', async (req, res) => {
//   try {
//     // Get current user from session
//     const token = req.cookies?.l4_session;
//     if (!token) {
//       return res.status(401).json({ error: 'Unauthorized' });
//     }

//     const session = await prisma.session.findUnique({ 
//       where: { token }, 
//       include: { user: true } 
//     });
    
//     if (!session || session.expiresAt < new Date()) {
//       return res.status(401).json({ error: 'Session expired' });
//     }

//     const channelId = req.params.id;
//     const { limit = 50, before } = req.query;

//     // Check if user is member of channel - NO AUTO-ADDING for security
//     const membership = await prisma.channelMember.findUnique({
//       where: {
//         channelId_userId: {
//           channelId,
//           userId: session.userId
//         }
//       }
//     });

//     if (!membership) {
//       console.error('❌ [SECURITY] User attempted to access channel without membership', {
//         channelId,
//         userId: session.userId,
//         userWallet: session.user.walletAddress
//       });
//       return res.status(403).json({ error: 'Access denied: You are not a member of this channel' });
//     }

//     // Verify channel exists and get channel info
//     const channel = await prisma.channel.findUnique({
//       where: { id: channelId },
//       include: {
//         members: {
//           include: {
//             user: {
//               select: {
//                 id: true,
//                 username: true,
//                 displayName: true,
//                 walletAddress: true
//               }
//             }
//           }
//         }
//       }
//     });

//     if (!channel) {
//       return res.status(404).json({ error: 'Channel not found' });
//     }

//     // Fetch latest messages with proper access control
//     const messages = await prisma.message.findMany({
//       where: {
//         channelId,
//         deletedAt: null,
//         // Only show messages from:
//         // 1. System messages (isSystem = true)
//         // 2. Messages from users who are members of this channel
//         OR: [
//           { isSystem: true }, // System messages
//           {
//             authorId: {
//               in: channel.members.map(member => member.userId)
//             }
//           }
//         ],
//         ...(before && { sentAt: { lt: new Date(before) } })
//       },
//       include: {
//         author: {
//           select: {
//             id: true,
//             username: true,
//             displayName: true,
//             avatarUrl: true,
//             walletAddress: true
//           }
//         },
//         reactions: {
//           include: {
//             user: {
//               select: {
//                 id: true,
//                 username: true
//               }
//             }
//           }
//         },
//         repliedToMessage: {
//           include: {
//             author: {
//               select: {
//                 id: true,
//                 username: true,
//                 displayName: true,
//                 walletAddress: true
//               }
//             }
//           }
//         },
//         readReceipts: {
//           where: {
//             userId: session.userId
//           }
//         }
//       },
//       orderBy: { sentAt: 'desc' }, // Get latest messages first
//       take: parseInt(limit)
//     });

//     // Reverse to show oldest first in UI (most recent at bottom)
//     const reversedMessages = messages.reverse();

//     // Mark messages as read
//     const unreadMessageIds = reversedMessages
//       .filter(msg => msg.readReceipts.length === 0)
//       .map(msg => msg.id);

//     if (unreadMessageIds.length > 0) {
//       await prisma.readReceipt.createMany({
//         data: unreadMessageIds.map(messageId => ({
//           messageId,
//           userId: session.userId,
//           readAt: new Date()
//         })),
//         skipDuplicates: true
//       });
//     }

//     res.json({ 
//       messages: reversedMessages, // Show oldest first (most recent at bottom)
//       hasMore: reversedMessages.length === parseInt(limit)
//     });
//   } catch (error) {
//     console.error('Error fetching messages:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });

// Send message to channel
router.post('/channels/:id/messages', async (req, res) => {
  try {
    // Get current user from session
    const token = req.cookies?.l4_session;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { id } = req.params;
    const { content, replyToId } = req.body;

    // Check if user is member of channel
    const membership = await prisma.channelMember.findUnique({
      where: {
        channelId_userId: {
          channelId: id,
          userId: session.userId
        }
      }
    });

    if (!membership) {
      console.error('❌ [SECURITY] User attempted to post message to channel without membership', {
        channelId: id,
        userId: session.userId,
        userWallet: session.user.walletAddress
      });
      return res.status(403).json({ error: 'Access denied: You are not a member of this channel' });
    }
    
    const message = await prisma.message.create({
      data: {
        content,
        channelId: id,
        authorId: session.userId,
        isSystem: false,
        replyToId
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        }
      }
    });
    
    res.status(201).json({ message });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Configure multer for media uploads (images, videos, etc.)
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../public/uploads/chat');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const extension = path.extname(file.originalname);
    cb(null, `${timestamp}_${randomString}${extension}`);
  }
});

const mediaUpload = multer({ 
  storage: mediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for videos
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 
      'video/mp4', 'video/webm', 'video/quicktime', // Added .mov support
      'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// Advanced media upload endpoint
router.post('/media/upload', mediaUpload.single('file'), async (req, res) => {
  try {
    // Get current user from session - try cookies first, then Authorization header
    let token = req.cookies?.l4_session;
    
    // Fallback: check Authorization header if no cookie
    if (!token && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        console.log('🔍 [CHAT MEDIA] Using token from Authorization header');
      }
    }
    
    if (!token) {
      console.log('❌ [CHAT MEDIA] No l4_session token found in cookies or Authorization header');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Generate URLs
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
    const url = `${baseUrl}/uploads/chat/${req.file.filename}`;
    
    // For images, we could generate thumbnails here
    let thumbnailUrl = null;
    if (req.file.mimetype.startsWith('image/')) {
      // In a real implementation, you'd generate a thumbnail
      thumbnailUrl = url;
    }

    const attachment = {
      url,
      type: req.file.mimetype.startsWith('image/') ? 'image' : 
            req.file.mimetype.startsWith('video/') ? 'video' :
            req.file.mimetype.startsWith('audio/') ? 'audio' : 'file',
      originalName: req.file.originalname,
      size: req.file.size,
      thumbnailUrl
    };

    res.json({ attachment });
  } catch (error) {
    console.error('Error uploading media:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy image upload endpoint (keeping for compatibility)
router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ imageUrl });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Add reaction to message
router.post('/messages/:id/reactions', async (req, res) => {
  try {
    // Get current user from session
    const token = req.cookies?.l4_session;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { id } = req.params;
    const { emoji } = req.body;

    // Validate emoji - only allow the 6 Messenger emojis
    const allowedEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    if (!emoji || !allowedEmojis.includes(emoji)) {
      return res.status(400).json({ error: 'Invalid emoji. Only 👍, ❤️, 😂, 😮, 😢, 🙏 are allowed' });
    }

    // Check if user has access to this message (via channel membership)
    const message = await prisma.message.findUnique({
      where: { id },
      include: {
        channel: {
          include: {
            members: {
              where: { userId: session.userId }
            }
          }
        }
      }
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (message.channel.members.length === 0) {
      console.error('❌ [SECURITY] User attempted to react to message without channel access', {
        messageId: id,
        userId: session.userId,
        userWallet: session.user.walletAddress
      });
      return res.status(403).json({ error: 'Access denied: You do not have access to this message' });
    }

    // Check if user already has this reaction on this message
    const existingReaction = await prisma.messageReaction.findUnique({
      where: {
        messageId_userId_emoji: {
          messageId: id,
          userId: session.userId,
          emoji: emoji
        }
      }
    });

    if (existingReaction) {
      return res.status(409).json({ error: 'Reaction already exists' });
    }
    
    const reaction = await prisma.messageReaction.create({
      data: {
        messageId: id,
        userId: session.userId,
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
    
    res.status(201).json({ reaction });
  } catch (error) {
    console.error('Error adding reaction:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Reaction already exists' });
    }
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// Remove reaction from message
router.delete('/messages/:id/reactions', async (req, res) => {
  try {
    // Get current user from session
    const token = req.cookies?.l4_session;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { id } = req.params;
    const { emoji } = req.body;

    // Validate emoji - only allow the 6 Messenger emojis
    const allowedEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    if (!emoji || !allowedEmojis.includes(emoji)) {
      return res.status(400).json({ error: 'Invalid emoji. Only 👍, ❤️, 😂, 😮, 😢, 🙏 are allowed' });
    }

    // Check if user has access to this message (via channel membership)
    const message = await prisma.message.findUnique({
      where: { id },
      include: {
        channel: {
          include: {
            members: {
              where: { userId: session.userId }
            }
          }
        }
      }
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (message.channel.members.length === 0) {
      console.error('❌ [SECURITY] User attempted to remove reaction from message without channel access', {
        messageId: id,
        userId: session.userId,
        userWallet: session.user.walletAddress
      });
      return res.status(403).json({ error: 'Access denied: You do not have access to this message' });
    }

    // Find and delete the reaction
    const reaction = await prisma.messageReaction.findUnique({
      where: {
        messageId_userId_emoji: {
          messageId: id,
          userId: session.userId,
          emoji: emoji
        }
      }
    });

    if (!reaction) {
      return res.status(404).json({ error: 'Reaction not found' });
    }

    await prisma.messageReaction.delete({
      where: {
        messageId_userId_emoji: {
          messageId: id,
          userId: session.userId,
          emoji: emoji
        }
      }
    });
    
    res.status(200).json({ message: 'Reaction removed successfully' });
  } catch (error) {
    console.error('Error removing reaction:', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// Toggle reaction (add if not exists, remove if exists)
router.put('/messages/:id/reactions', async (req, res) => {
  try {
    // Get current user from session
    const token = req.cookies?.l4_session;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { id } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }

    // Check if user has access to this message (via channel membership)
    const message = await prisma.message.findUnique({
      where: { id },
      include: {
        channel: {
          include: {
            members: {
              where: { userId: session.userId }
            }
          }
        }
      }
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (message.channel.members.length === 0) {
      console.error('❌ [SECURITY] User attempted to toggle reaction on message without channel access', {
        messageId: id,
        userId: session.userId,
        userWallet: session.user.walletAddress
      });
      return res.status(403).json({ error: 'Access denied: You do not have access to this message' });
    }

    // Validate emoji - only allow the 6 Messenger emojis
    const allowedEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    if (!allowedEmojis.includes(emoji)) {
      return res.status(400).json({ error: 'Invalid emoji. Only 👍, ❤️, 😂, 😮, 😢, 🙏 are allowed' });
    }

    // Check if user already has ANY reaction on this message (Messenger: one reaction per user)
    const existingReaction = await prisma.messageReaction.findFirst({
      where: {
        messageId: id,
        userId: session.userId
      }
    });

    if (existingReaction) {
      if (existingReaction.emoji === emoji) {
        // Same emoji - remove it (toggle off)
        await prisma.messageReaction.delete({
          where: {
            messageId_userId_emoji: {
              messageId: id,
              userId: session.userId,
              emoji: emoji
            }
          }
        });
        
        return res.status(200).json({ 
          action: 'removed',
          message: 'Reaction removed successfully' 
        });
      } else {
        // Different emoji - replace the existing one
        await prisma.messageReaction.delete({
          where: {
            messageId_userId_emoji: {
              messageId: id,
              userId: session.userId,
              emoji: existingReaction.emoji
            }
          }
        });
        
        const newReaction = await prisma.messageReaction.create({
          data: {
            messageId: id,
            userId: session.userId,
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
        
        return res.status(200).json({ 
          action: 'replaced',
          oldEmoji: existingReaction.emoji,
          reaction: newReaction 
        });
      }
    } else {
      // No existing reaction - add new one
      const reaction = await prisma.messageReaction.create({
        data: {
          messageId: id,
          userId: session.userId,
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
      
      return res.status(201).json({ 
        action: 'added',
        reaction 
      });
    }
  } catch (error) {
    console.error('Error toggling reaction:', error);
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

// Search users
router.get('/search-users', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q) {
      return res.json({ users: [] });
    }
    
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true
      },
      take: 10
    });
    
    res.json({ users });
  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Create or find DM channel
router.post('/dm/create', async (req, res) => {
  try {
    const { userId, preventDuplicates } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    // Get current user from session
    const token = req.cookies?.l4_session;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const currentUserId = session.user.id;
    
    if (userId === currentUserId) {
      return res.status(400).json({ error: 'Cannot create DM with yourself' });
    }
    
    // Check if DM channel already exists between these users
    const allChannels = await prisma.channel.findMany({
      where: {
        type: 'dm',
        AND: [
          {
            members: {
              some: {
                userId: currentUserId
              }
            }
          },
          {
            members: {
              some: {
                userId: userId
              }
            }
          }
        ]
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                status: true,
                lastSeen: true
              }
            }
          }
        },
        _count: {
          select: {
            members: true,
            messages: true
          }
        }
      }
    });
    
    // Find a channel with exactly 2 members (both users)
    const existingChannel = allChannels.find(channel => 
      channel.members.length === 2 && 
      channel.members.some(m => m.userId === currentUserId) &&
      channel.members.some(m => m.userId === userId)
    );
    
    if (existingChannel) {
      // Validate that DM channel has exactly 2 members (only for DM channels)
      if (existingChannel.type === 'dm' && existingChannel.members.length !== 2) {
        console.error('❌ [DM VALIDATION] DM channel has invalid member count:', {
          channelId: existingChannel.id,
          memberCount: existingChannel.members.length,
          expected: 2
        });
        return res.status(500).json({ error: 'Invalid DM channel: must have exactly 2 members' });
      }
      
      // If preventDuplicates flag is set, return duplicate error instead of existing channel
      if (preventDuplicates) {
        return res.status(409).json({ 
          error: 'DUPLICATE_DM',
          message: 'DM channel already exists between these users',
          channel: existingChannel 
        });
      }
      
      return res.json({ channel: existingChannel });
    }
    
    // Get the other user's data to set the channel name
    const otherUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true
      }
    });

    if (!otherUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create new DM channel with uid (no name stored for DMs)
    const channel = await prisma.channel.create({
      data: {
        type: 'dm',
        name: null, // DMs don't store names, derive from uid
        createdBy: currentUserId,
        uid: userId, // Store the other user's ID for easy reference
        isPrivate: true, // DMs are always private
        members: {
          create: [
            { userId: currentUserId },
            { userId }
          ]
        }
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                status: true,
                lastSeen: true
              }
            }
          }
        },
        _count: {
          select: {
            members: true,
            messages: true
          }
        }
      }
    });
    
    // Validate that the created DM channel has exactly 2 members
    if (channel.members.length !== 2) {
      console.error('❌ [DM VALIDATION] Created DM channel has invalid member count:', {
        channelId: channel.id,
        memberCount: channel.members.length,
        expected: 2
      });
      
      // Clean up the invalid channel
      await prisma.channel.delete({ where: { id: channel.id } });
      
      return res.status(500).json({ error: 'Failed to create DM channel: invalid member count' });
    }
    
    console.log('✅ [DM VALIDATION] DM channel created successfully with 2 members:', {
      channelId: channel.id,
      memberCount: channel.members.length,
      members: channel.members.map(m => ({ userId: m.userId, username: m.user.username }))
    });
    
    res.status(201).json({ channel });
  } catch (error) {
    console.error('Error creating DM channel:', error);
    res.status(500).json({ error: 'Failed to create DM channel' });
  }
});

module.exports = router;