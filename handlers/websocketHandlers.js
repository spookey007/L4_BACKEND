const { prisma } = require('../lib/prisma');
const redis = require('../lib/redis');
const msgpack = require('msgpack-lite');
const notificationService = require('../lib/notificationService');

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
  AUTH_ME: 'AUTH_ME',
  AUTH_LOGIN: 'AUTH_LOGIN',
  STORAGE_GET: 'STORAGE_GET',
  STORAGE_SET: 'STORAGE_SET',
  STORAGE_DELETE: 'STORAGE_DELETE',
  STORAGE_LIST: 'STORAGE_LIST',
  STORAGE_CLEAR: 'STORAGE_CLEAR',
  AUDIO_SETTINGS_GET: 'AUDIO_SETTINGS_GET',
  AUDIO_SETTINGS_SET: 'AUDIO_SETTINGS_SET',
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  LEAVE_ROOM: 'LEAVE_ROOM',
  CREATE_ROOM_INVITE: 'CREATE_ROOM_INVITE',
  USE_ROOM_INVITE: 'USE_ROOM_INVITE',
  SEARCH_ROOMS: 'SEARCH_ROOMS',
  CREATE_DM: 'CREATE_DM',
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
  CHANNEL_CREATED: 'CHANNEL_CREATED',
  NEW_DM_INVITE: 'NEW_DM_INVITE',
  UNREAD_COUNT_UPDATE: 'UNREAD_COUNT_UPDATE',
  NOTIFICATION_RECEIVED: 'NOTIFICATION_RECEIVED',
  UNREAD_COUNTS_RESPONSE: 'UNREAD_COUNTS_RESPONSE',
  NOTIFICATION_PREFS_RESPONSE: 'NOTIFICATION_PREFS_RESPONSE',
  PONG: 'PONG',
  ERROR: 'ERROR',
  AUTH_ME_RESPONSE: 'AUTH_ME_RESPONSE',
  AUTH_LOGIN_RESPONSE: 'AUTH_LOGIN_RESPONSE',
  STORAGE_GET_RESPONSE: 'STORAGE_GET_RESPONSE',
  STORAGE_SET_RESPONSE: 'STORAGE_SET_RESPONSE',
  STORAGE_DELETE_RESPONSE: 'STORAGE_DELETE_RESPONSE',
  STORAGE_LIST_RESPONSE: 'STORAGE_LIST_RESPONSE',
  STORAGE_CLEAR_RESPONSE: 'STORAGE_CLEAR_RESPONSE',
  AUDIO_SETTINGS_GET_RESPONSE: 'AUDIO_SETTINGS_GET_RESPONSE',
  AUDIO_SETTINGS_SET_RESPONSE: 'AUDIO_SETTINGS_SET_RESPONSE'
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
  
  // Check if there are any video attachments
  const hasVideoAttachment = attachments.some(attachment => 
    attachment.type === 'video' || 
    (attachment.filename && /\.(mp4|avi|mov|wmv|flv|webm)$/i.test(attachment.filename))
  );
  if (hasVideoAttachment) return 5; // Video
  
  // Check if there are any audio attachments
  const hasAudioAttachment = attachments.some(attachment => 
    attachment.type === 'audio' || 
    (attachment.filename && /\.(mp3|wav|ogg|m4a|aac)$/i.test(attachment.filename))
  );
  if (hasAudioAttachment) return 4; // Audio
  
  // Default to text
  return 1; // Text
}

async function broadcastToChannel(channelId, event, payload, excludeUserId = null, connections) {
  const message = msgpack.encode([event, payload, Date.now()]);
  
  try {
    const members = await prisma.channelMember.findMany({
      where: { channelId },
      select: { userId: true }
    });
    
    console.log('👀 [SERVER] Broadcasting to channel:', {
      channelId,
      event,
      payload,
      excludeUserId,
      totalMembers: members.length,
      memberIds: members.map(m => m.userId)
    });
    
    let sentCount = 0;
    
    members.forEach(member => {
      if (member.userId !== excludeUserId) {
        const ws = connections.get(member.userId);
        if (ws && ws.readyState === 1) {
          console.log('👀 [SERVER] Sending to user:', {
            userId: member.userId,
            event,
            channelId
          });
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

// Message handlers
async function handleSendMessage(userId, payload, connections) {
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

    await broadcastToChannel(channelId, SERVER_EVENTS.MESSAGE_RECEIVED, message, null, connections);
    
    // Handle notification counting and updates
    await notificationService.handleNewMessage(message, connections);
  } catch (error) {
    console.error('❌ Error sending message:', error);
    throw error;
  }
}

async function handleJoinChannel(userId, payload, connections) {
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

    await broadcastToChannel(channelId, SERVER_EVENTS.USER_JOINED, { userId, channelId }, userId, connections);
  } catch (error) {
    console.error('Error joining channel:', error);
    throw error;
  }
}

async function handleStartTyping(userId, payload, connections) {
  try {
    const { channelId } = payload;
    console.log('👀 [SERVER] User started typing:', {
      userId,
      channelId,
      payload
    });
    await broadcastToChannel(channelId, SERVER_EVENTS.TYPING_STARTED, { userId, channelId }, userId, connections);
  } catch (error) {
    console.error('Error handling typing start:', error);
    throw error;
  }
}

async function handleStopTyping(userId, payload, connections) {
  try {
    const { channelId } = payload;
    console.log('👀 [SERVER] User stopped typing:', {
      userId,
      channelId,
      payload
    });
    await broadcastToChannel(channelId, SERVER_EVENTS.TYPING_STOPPED, { userId, channelId }, userId, connections);
  } catch (error) {
    console.error('Error handling typing stop:', error);
    throw error;
  }
}

// Channel handlers
async function handleFetchChannels(userId, payload, ws, connections) {
  try {
    console.log('🔍 [CHANNELS] Fetching channels for user:', userId);
    
    // Validate cache vs database first
    await validateCacheVsDatabase(userId);
    
    // Check cache first (after validation)
    const userCacheKey = redis.getUserChannelsKey(userId);
    const publicChannelsKey = 'channels:public';
    const [cachedUserChannels, cachedPublicChannels] = await Promise.all([
      redis.get(userCacheKey),
      redis.get(publicChannelsKey)
    ]);
    
    if (cachedUserChannels && cachedPublicChannels) {
      console.log('⚡ [CACHE] Channels served from cache for user:', userId);
      const userChannelIds = new Set(cachedUserChannels.map(c => c.id));
      const publicChannels = cachedPublicChannels.filter(c => !userChannelIds.has(c.id));
      const allChannels = [...cachedUserChannels, ...publicChannels];
      
      ws.send(msgpack.encode([SERVER_EVENTS.CHANNELS_LOADED, {
        channels: allChannels
      }, Date.now()]));
      return;
    }

    // Fetch user's channels
    const channels = await prisma.channel.findMany({
      where: {
        OR: [
          // User is a member of the channel
          {
            members: {
              some: {
                userId
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
                avatarUrl: true,
                walletAddress: true,
                status: true
              }
            }
          }
        },
        lastMessage: {
          select: {
            id: true,
            content: true,
            sentAt: true,
            author: {
              select: {
                id: true,
                username: true
              }
            }
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    // Ensure user is in the community channel
    const communityChannel = channels.find(c => c.type === 'text-group' && c.name === 'General');
    if (!communityChannel) {
      const generalChannel = await prisma.channel.findFirst({
        where: {
          type: 'text-group',
          name: 'General'
        }
      });
      
      if (generalChannel) {
        await prisma.channelMember.create({
          data: {
            channelId: generalChannel.id,
            userId
          }
        });
        
        // Re-fetch channels to include the new one
        const updatedChannels = await prisma.channel.findMany({
          where: {
            OR: [
              // User is a member of the channel
              {
                members: {
                  some: {
                    userId
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
                    avatarUrl: true,
                    walletAddress: true,
                    status: true
                  }
                }
              }
            },
            lastMessage: {
              select: {
                id: true,
                content: true,
                sentAt: true,
                author: {
                  select: {
                    id: true,
                    username: true
                  }
                }
              }
            }
          },
          orderBy: {
            updatedAt: 'desc'
          }
        });
        
        // Cache the results separately
        const userChannels = updatedChannels.filter(c => c.members.some(m => m.userId === userId));
        const publicChannels = updatedChannels.filter(c => c.type === 'text-group' && !c.isPrivate);
        
        await Promise.all([
          redis.set(userCacheKey, userChannels, 120),
          redis.set(publicChannelsKey, publicChannels, 120)
        ]);
        
        ws.send(msgpack.encode([SERVER_EVENTS.CHANNELS_LOADED, {
          channels: updatedChannels
        }, Date.now()]));
        return;
      }
    }

    // Cache the results separately
    const userChannels = channels.filter(c => c.members.some(m => m.userId === userId));
    const publicChannels = channels.filter(c => c.type === 'text-group' && !c.isPrivate);
    
    await Promise.all([
      redis.set(userCacheKey, userChannels, 120),
      redis.set(publicChannelsKey, publicChannels, 120)
    ]);

    ws.send(msgpack.encode([SERVER_EVENTS.CHANNELS_LOADED, {
      channels
    }, Date.now()]));

  } catch (error) {
    console.error('❌ [SERVER] Error fetching channels:', error);
    ws.send(msgpack.encode([SERVER_EVENTS.ERROR, {
      message: 'Failed to fetch channels',
      error: error.message
    }, Date.now()]));
  }
}

async function handleFetchMessages(userId, payload, ws) {
  try {
    const { channelId, limit = 50, before } = payload;
    
    // No caching for messages - they are real-time
    console.log('🔍 [MESSAGES] Fetching real-time messages for channel:', channelId);
    
    const membership = await prisma.channelMember.findUnique({
      where: {
        channelId_userId: {
          channelId,
          userId
        }
      }
    });

    if (!membership) {
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        include: {
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

    // Optimized message query with selective fields
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
            walletAddress: true
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
                username: true
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
                walletAddress: true
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
    
    // Handle notification count updates
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

// Reaction handlers
async function handleAddReaction(userId, payload, connections) {
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
        }, userId, connections);
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
        await broadcastToChannel(message.channelId, SERVER_EVENTS.REACTION_ADDED, newReaction, userId, connections);
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
      await broadcastToChannel(message.channelId, SERVER_EVENTS.REACTION_ADDED, reaction, userId, connections);
    }
  } catch (error) {
    console.error('❌ [SERVER] Error adding reaction:', error);
    throw error;
  }
}

async function handleRemoveReaction(userId, payload, connections) {
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
    }, userId, connections);
  } catch (error) {
    console.error('❌ [SERVER] Error removing reaction:', error);
    throw error;
  }
}

// Storage handlers
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

// Audio settings handlers
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

// Room management functions (placeholders)
async function handleCreateRoom(userId, payload, ws) {
  console.log('🏠 [ROOM] Create room requested (placeholder)');
  ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Room creation not available in this mode' }, Date.now()]));
}

async function handleJoinRoom(userId, payload, ws) {
  console.log('🚪 [ROOM] Join room requested (placeholder)');
  ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Room joining not available in this mode' }, Date.now()]));
}

async function handleLeaveRoom(userId, payload, ws) {
  console.log('🚪 [ROOM] Leave room requested (placeholder)');
  ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Room leaving not available in this mode' }, Date.now()]));
}

async function handleCreateRoomInvite(userId, payload, ws) {
  console.log('📧 [ROOM] Create room invite requested (placeholder)');
  ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Room invites not available in this mode' }, Date.now()]));
}

async function handleUseRoomInvite(userId, payload, ws) {
  console.log('🔑 [ROOM] Use room invite requested (placeholder)');
  ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Room invites not available in this mode' }, Date.now()]));
}

async function handleSearchRooms(userId, payload, ws) {
  console.log('🔍 [ROOM] Search rooms requested (placeholder)');
  ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'Room search not available in this mode' }, Date.now()]));
}

async function handleCreateDM(userId, payload, ws) {
  console.log('💬 [DM] Create DM requested (placeholder)');
  ws.send(msgpack.encode([SERVER_EVENTS.ERROR, { message: 'DM creation not available in this mode' }, Date.now()]));
}

// Cache management functions
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

// Notification handlers
async function handleGetUnreadCounts(userId, payload, ws) {
  try {
    console.log('📊 [NOTIFICATION] Getting unread counts for user:', userId);
    
    const channelCounts = await notificationService.getAllChannelUnreadCounts(userId);
    const totalCount = await notificationService.getTotalUnreadCount(userId);
    
    ws.send(msgpack.encode([SERVER_EVENTS.UNREAD_COUNTS_RESPONSE, {
      channelCounts,
      totalCount,
      timestamp: Date.now()
    }, Date.now()]));
    
    console.log('📊 [NOTIFICATION] Sent unread counts:', {
      userId,
      totalCount,
      channelCounts: Object.keys(channelCounts).length
    });
  } catch (error) {
    console.error('❌ [NOTIFICATION] Error getting unread counts:', error);
    ws.send(msgpack.encode([SERVER_EVENTS.ERROR, {
      message: 'Failed to get unread counts',
      error: error.message
    }, Date.now()]));
  }
}

async function handleGetNotificationPrefs(userId, payload, ws) {
  try {
    console.log('🔔 [NOTIFICATION] Getting notification preferences for user:', userId);
    
    const preferences = await notificationService.getNotificationPreferences(userId);
    
    ws.send(msgpack.encode([SERVER_EVENTS.NOTIFICATION_PREFS_RESPONSE, {
      preferences,
      timestamp: Date.now()
    }, Date.now()]));
    
    console.log('🔔 [NOTIFICATION] Sent notification preferences:', {
      userId,
      preferences
    });
  } catch (error) {
    console.error('❌ [NOTIFICATION] Error getting notification preferences:', error);
    ws.send(msgpack.encode([SERVER_EVENTS.ERROR, {
      message: 'Failed to get notification preferences',
      error: error.message
    }, Date.now()]));
  }
}

async function handleUpdateNotificationPrefs(userId, payload, ws) {
  try {
    const { preferences } = payload;
    console.log('🔔 [NOTIFICATION] Updating notification preferences for user:', userId, preferences);
    
    await notificationService.updateNotificationPreferences(userId, preferences);
    
    ws.send(msgpack.encode([SERVER_EVENTS.NOTIFICATION_PREFS_RESPONSE, {
      preferences,
      timestamp: Date.now()
    }, Date.now()]));
    
    console.log('🔔 [NOTIFICATION] Updated notification preferences:', {
      userId,
      preferences
    });
  } catch (error) {
    console.error('❌ [NOTIFICATION] Error updating notification preferences:', error);
    ws.send(msgpack.encode([SERVER_EVENTS.ERROR, {
      message: 'Failed to update notification preferences',
      error: error.message
    }, Date.now()]));
  }
}

module.exports = {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  determineMessageType,
  broadcastToChannel,
  updateUserPresence,
  handleSendMessage,
  handleJoinChannel,
  handleStartTyping,
  handleStopTyping,
  handleFetchChannels,
  handleFetchMessages,
  handleMarkAsRead,
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
  handleUpdateNotificationPrefs,
  clearAllChannelCaches,
  validateCacheVsDatabase
};
