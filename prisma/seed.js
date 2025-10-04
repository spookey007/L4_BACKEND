const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create test users
  const user1 = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      email: 'alice@example.com',
      username: 'alice',
      displayName: 'Alice Johnson',
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      status: 'online',
      isVerified: true
    }
  });

  const user2 = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      email: 'bob@example.com',
      username: 'bob',
      displayName: 'Bob Smith',
      walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
      status: 'online',
      isVerified: true
    }
  });

  const user3 = await prisma.user.upsert({
    where: { email: 'charlie@example.com' },
    update: {},
    create: {
      email: 'charlie@example.com',
      username: 'charlie',
      displayName: 'Charlie Brown',
      walletAddress: '0x9876543210fedcba9876543210fedcba98765432',
      status: 'idle',
      isVerified: false
    }
  });

  // Create a DM channel between Alice and Bob
  const dmChannel = await prisma.channel.create({
    data: {
      type: 'dm',
      createdBy: user1.id,
      members: {
        create: [
          { userId: user1.id },
          { userId: user2.id }
        ]
      }
    }
  });

  // Create a group channel
  const groupChannel = await prisma.channel.create({
    data: {
      type: 'text-group',
      name: 'General',
      topic: 'General discussion channel',
      createdBy: user1.id,
      isPrivate: false,
      members: {
        create: [
          { userId: user1.id },
          { userId: user2.id },
          { userId: user3.id }
        ]
      }
    }
  });

  // Create some sample messages
  const message1 = await prisma.message.create({
    data: {
      channelId: dmChannel.id,
      authorId: user1.id,
      content: 'Hey Bob! How are you doing?',
      sentAt: new Date(Date.now() - 3600000) // 1 hour ago
    }
  });

  const message2 = await prisma.message.create({
    data: {
      channelId: dmChannel.id,
      authorId: user2.id,
      content: 'Hi Alice! I\'m doing great, thanks for asking. How about you?',
      sentAt: new Date(Date.now() - 3500000) // 58 minutes ago
    }
  });

  const message3 = await prisma.message.create({
    data: {
      channelId: groupChannel.id,
      authorId: user1.id,
      content: 'Welcome everyone to the General channel! 🎉',
      sentAt: new Date(Date.now() - 1800000) // 30 minutes ago
    }
  });

  const message4 = await prisma.message.create({
    data: {
      channelId: groupChannel.id,
      authorId: user2.id,
      content: 'Thanks for creating this channel!',
      sentAt: new Date(Date.now() - 1700000) // 28 minutes ago
    }
  });

  const message5 = await prisma.message.create({
    data: {
      channelId: groupChannel.id,
      authorId: user3.id,
      content: 'Hello everyone! 👋',
      sentAt: new Date(Date.now() - 1600000) // 27 minutes ago
    }
  });

  // Add some reactions
  await prisma.messageReaction.create({
    data: {
      messageId: message3.id,
      userId: user2.id,
      emoji: '🎉'
    }
  });

  await prisma.messageReaction.create({
    data: {
      messageId: message3.id,
      userId: user3.id,
      emoji: '🎉'
    }
  });

  await prisma.messageReaction.create({
    data: {
      messageId: message5.id,
      userId: user1.id,
      emoji: '👋'
    }
  });

  // Update channel last messages
  await prisma.channel.update({
    where: { id: dmChannel.id },
    data: { lastMessageId: message2.id }
  });

  await prisma.channel.update({
    where: { id: groupChannel.id },
    data: { lastMessageId: message5.id }
  });

  // Create read receipts
  await prisma.readReceipt.createMany({
    data: [
      {
        messageId: message1.id,
        userId: user2.id,
        readAt: new Date(Date.now() - 3500000)
      },
      {
        messageId: message2.id,
        userId: user1.id,
        readAt: new Date(Date.now() - 3400000)
      },
      {
        messageId: message3.id,
        userId: user2.id,
        readAt: new Date(Date.now() - 1700000)
      },
      {
        messageId: message3.id,
        userId: user3.id,
        readAt: new Date(Date.now() - 1600000)
      },
      {
        messageId: message4.id,
        userId: user1.id,
        readAt: new Date(Date.now() - 1600000)
      },
      {
        messageId: message4.id,
        userId: user3.id,
        readAt: new Date(Date.now() - 1500000)
      },
      {
        messageId: message5.id,
        userId: user1.id,
        readAt: new Date(Date.now() - 1500000)
      },
      {
        messageId: message5.id,
        userId: user2.id,
        readAt: new Date(Date.now() - 1400000)
      }
    ]
  });

  console.log('✅ Database seeded successfully!');
  console.log(`Created ${3} users`);
  console.log(`Created ${2} channels`);
  console.log(`Created ${5} messages`);
  console.log(`Created ${3} reactions`);
  console.log(`Created ${8} read receipts`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });