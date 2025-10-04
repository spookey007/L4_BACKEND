const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function setFirstAdmin() {
  try {
    // Get the first user (or create one if none exist)
    let user = await prisma.user.findFirst();
    
    if (!user) {
      console.log('No users found. Please create a user first by logging in.');
      return;
    }

    // Set the first user as admin
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { role: 0 }
    });

    console.log(`✅ User ${updatedUser.walletAddress} has been set as admin (role: ${updatedUser.role})`);
  } catch (error) {
    console.error('❌ Error setting first admin:', error);
  } finally {
    await prisma.$disconnect();
  }
}

setFirstAdmin();
