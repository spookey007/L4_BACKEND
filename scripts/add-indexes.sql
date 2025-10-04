-- Performance optimization indexes for faster queries

-- Channel queries
CREATE INDEX IF NOT EXISTS idx_channel_members_user_id ON "ChannelMember"("userId");
CREATE INDEX IF NOT EXISTS idx_channel_members_channel_id ON "ChannelMember"("channelId");
CREATE INDEX IF NOT EXISTS idx_channel_members_composite ON "ChannelMember"("channelId", "userId");

-- Message queries
CREATE INDEX IF NOT EXISTS idx_message_channel_id ON "Message"("channelId");
CREATE INDEX IF NOT EXISTS idx_message_sent_at ON "Message"("sentAt");
CREATE INDEX IF NOT EXISTS idx_message_channel_sent_at ON "Message"("channelId", "sentAt");
CREATE INDEX IF NOT EXISTS idx_message_author_id ON "Message"("authorId");
CREATE INDEX IF NOT EXISTS idx_message_deleted_at ON "Message"("deletedAt");

-- Channel queries
CREATE INDEX IF NOT EXISTS idx_channel_updated_at ON "Channel"("updatedAt");
CREATE INDEX IF NOT EXISTS idx_channel_type ON "Channel"("type");
CREATE INDEX IF NOT EXISTS idx_channel_name ON "Channel"("name");

-- User queries
CREATE INDEX IF NOT EXISTS idx_user_username ON "User"("username");
CREATE INDEX IF NOT EXISTS idx_user_wallet_address ON "User"("walletAddress");

-- Reaction queries
CREATE INDEX IF NOT EXISTS idx_message_reaction_message_id ON "MessageReaction"("messageId");
CREATE INDEX IF NOT EXISTS idx_message_reaction_user_id ON "MessageReaction"("userId");
CREATE INDEX IF NOT EXISTS idx_message_reaction_composite ON "MessageReaction"("messageId", "userId", "emoji");

-- Typing indicators
CREATE INDEX IF NOT EXISTS idx_typing_indicator_user_id ON "TypingIndicator"("userId");
CREATE INDEX IF NOT EXISTS idx_typing_indicator_channel_id ON "TypingIndicator"("channelId");

-- Read receipts
CREATE INDEX IF NOT EXISTS idx_read_receipt_user_id ON "ReadReceipt"("userId");
CREATE INDEX IF NOT EXISTS idx_read_receipt_message_id ON "ReadReceipt"("messageId");
CREATE INDEX IF NOT EXISTS idx_read_receipt_composite ON "ReadReceipt"("userId", "messageId");
