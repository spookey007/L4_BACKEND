const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();

const prisma = new PrismaClient();

// Helper function to get user from session
const getUser = async (req) => {
  const token = req.cookies?.l4_session;
  if (!token) return null;
  
  const session = await prisma.session.findUnique({ 
    where: { token }, 
    include: { user: true } 
  });
  
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
};

// Get staking info for a wallet
router.get('/info/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    // Get or create staking position
    let position = await prisma.stakingPosition.findUnique({
      where: { walletAddress }
    });
    
    if (!position) {
      position = await prisma.stakingPosition.create({
        data: {
          walletAddress,
          userId: 'temp', // Will be updated when user connects
          totalStaked: 0,
          totalL4Received: 0,
          totalRewards: 0,
          pendingRewards: 0,
          isActive: true
        }
      });
    }
    
    // Calculate pending rewards based on staking transactions
    const transactions = await prisma.stakingTransaction.findMany({
      where: { 
        walletAddress,
        status: 'confirmed'
      },
      orderBy: { createdAt: 'asc' }
    });
    
    let totalPendingRewards = 0;
    const currentDate = new Date();
    
    for (const tx of transactions) {
      const daysStaked = Math.floor(
        (currentDate.getTime() - tx.createdAt.getTime()) / (1000 * 60 * 60 * 24)
      );
      
      if (daysStaked > 0) {
        const dailyRate = Number(tx.apr) / 365;
        const rewards = Number(tx.solAmount) * dailyRate * daysStaked;
        totalPendingRewards += rewards;
      }
    }
    
    // Update pending rewards
    await prisma.stakingPosition.update({
      where: { walletAddress },
      data: { pendingRewards: totalPendingRewards }
    });
    
    res.json({
      stakedAmount: position.totalStaked.toString(),
      totalRewards: position.totalRewards.toString(),
      pendingRewards: totalPendingRewards.toString(),
      dailyApr: "0.1", // 0.1% daily APR
      apr: 36.5, // 36.5% annual APR
      stakingStartDate: position.lastStakeDate?.toISOString() || null,
      stakingEndDate: position.lastStakeDate ? 
        new Date(position.lastStakeDate.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString() : null,
      totalStakedTransactions: transactions.length,
      lastStakeDate: position.lastStakeDate?.toISOString() || null,
      isActive: position.isActive
    });
  } catch (error) {
    console.error('Error fetching staking info:', error);
    res.status(500).json({ error: 'Failed to fetch staking info' });
  }
});

// Stake SOL for L4 tokens
router.post('/stake', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { solAmount, l4Price, txHash } = req.body;
    
    if (!solAmount || !l4Price || !txHash) {
      return res.status(400).json({ error: 'solAmount, l4Price, and txHash are required' });
    }
    
    const solAmountDecimal = parseFloat(solAmount);
    const l4PriceDecimal = parseFloat(l4Price);
    const l4Amount = solAmountDecimal / l4PriceDecimal;
    
    // Create staking transaction
    const transaction = await prisma.stakingTransaction.create({
      data: {
        userId: user.id,
        walletAddress: user.walletAddress,
        solAmount: solAmountDecimal,
        l4Amount: l4Amount,
        l4Price: l4PriceDecimal,
        txHash,
        status: 'confirmed', // For now, assume confirmed
        confirmedAt: new Date(),
        apr: 0.365, // 36.5% APR
        lockPeriodDays: 180
      }
    });
    
    // Update or create staking position
    const existingPosition = await prisma.stakingPosition.findUnique({
      where: { walletAddress: user.walletAddress }
    });
    
    if (existingPosition) {
      await prisma.stakingPosition.update({
        where: { walletAddress: user.walletAddress },
        data: {
          totalStaked: existingPosition.totalStaked + solAmountDecimal,
          totalL4Received: existingPosition.totalL4Received + l4Amount,
          lastStakeDate: new Date()
        }
      });
    } else {
      await prisma.stakingPosition.create({
        data: {
          userId: user.id,
          walletAddress: user.walletAddress,
          totalStaked: solAmountDecimal,
          totalL4Received: l4Amount,
          lastStakeDate: new Date()
        }
      });
    }
    
    res.json({
      success: true,
      transaction: {
        id: transaction.id,
        solAmount: transaction.solAmount.toString(),
        l4Amount: transaction.l4Amount.toString(),
        txHash: transaction.txHash
      }
    });
  } catch (error) {
    console.error('Error staking SOL:', error);
    res.status(500).json({ error: 'Failed to stake SOL' });
  }
});

// Claim rewards
router.post('/claim', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { walletAddress, totalRewards, totalStaked } = req.body;
    
    if (!walletAddress) {
      return res.status(400).json({ error: 'walletAddress is required' });
    }
    
    // Get staking position
    const position = await prisma.stakingPosition.findUnique({
      where: { walletAddress }
    });
    
    if (!position || position.pendingRewards <= 0) {
      return res.status(400).json({ error: 'No rewards to claim' });
    }
    
    // Create reward record
    const reward = await prisma.stakingReward.create({
      data: {
        userId: user.id,
        walletAddress,
        rewardAmount: position.pendingRewards,
        claimedAt: new Date(),
        daysStaked: 30, // Default for now
        apr: 0.365
      }
    });
    
    // Update position
    await prisma.stakingPosition.update({
      where: { walletAddress },
      data: {
        totalRewards: position.totalRewards + position.pendingRewards,
        pendingRewards: 0
      }
    });
    
    res.json({
      success: true,
      amount: position.pendingRewards.toString(),
      rewardId: reward.id
    });
  } catch (error) {
    console.error('Error claiming rewards:', error);
    res.status(500).json({ error: 'Failed to claim rewards' });
  }
});

// Get staking history
router.get('/history/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    const transactions = await prisma.stakingTransaction.findMany({
      where: { walletAddress },
      orderBy: { createdAt: 'desc' }
    });
    
    const rewards = await prisma.stakingReward.findMany({
      where: { walletAddress },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({
      transactions: transactions.map(tx => ({
        id: tx.id,
        solAmount: tx.solAmount.toString(),
        l4Amount: tx.l4Amount.toString(),
        l4Price: tx.l4Price.toString(),
        txHash: tx.txHash,
        status: tx.status,
        createdAt: tx.createdAt,
        confirmedAt: tx.confirmedAt
      })),
      rewards: rewards.map(reward => ({
        id: reward.id,
        rewardAmount: reward.rewardAmount.toString(),
        claimedAt: reward.claimedAt,
        daysStaked: reward.daysStaked
      }))
    });
  } catch (error) {
    console.error('Error fetching staking history:', error);
    res.status(500).json({ error: 'Failed to fetch staking history' });
  }
});

// Get L4 token price
router.get('/l4-price', async (req, res) => {
  try {
    // For now, return a mock price. In production, integrate with Jupiter API
    const mockPrice = 0.0001; // $0.0001 per L4 token
    
    res.json({
      price: mockPrice,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching L4 price:', error);
    res.status(500).json({ error: 'Failed to fetch L4 price' });
  }
});

module.exports = router;
