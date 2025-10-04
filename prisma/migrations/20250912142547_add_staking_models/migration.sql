/*
  Warnings:

  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- DropForeignKey
ALTER TABLE "public"."Message" DROP CONSTRAINT "Message_roomId_fkey";

-- AlterTable
ALTER TABLE "public"."Message" ADD COLUMN     "conversationId" TEXT,
ALTER COLUMN "roomId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "role",
ADD COLUMN     "role" INTEGER NOT NULL DEFAULT 1;

-- DropEnum
DROP TYPE "public"."Role";

-- CreateTable
CREATE TABLE "public"."MessageRead" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Follow" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Conversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'dm',
    "name" TEXT,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ConversationParticipant" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StakingTransaction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "solAmount" DECIMAL(18,9) NOT NULL,
    "l4Amount" DECIMAL(18,9) NOT NULL,
    "l4Price" DECIMAL(18,9) NOT NULL,
    "txHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedAt" TIMESTAMP(3),
    "blockNumber" BIGINT,
    "lockPeriodDays" INTEGER NOT NULL DEFAULT 180,
    "apr" DECIMAL(5,4) NOT NULL,

    CONSTRAINT "StakingTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StakingPosition" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "totalStaked" DECIMAL(18,9) NOT NULL DEFAULT 0,
    "totalL4Received" DECIMAL(18,9) NOT NULL DEFAULT 0,
    "totalRewards" DECIMAL(18,9) NOT NULL DEFAULT 0,
    "pendingRewards" DECIMAL(18,9) NOT NULL DEFAULT 0,
    "lastStakeDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "StakingPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StakingReward" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "rewardAmount" DECIMAL(18,9) NOT NULL,
    "claimTxHash" TEXT,
    "claimedAt" TIMESTAMP(3),
    "daysStaked" INTEGER NOT NULL,
    "apr" DECIMAL(5,4) NOT NULL,
    "transactionId" TEXT,

    CONSTRAINT "StakingReward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageRead_messageId_userId_key" ON "public"."MessageRead"("messageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "public"."Follow"("followerId", "followingId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key" ON "public"."ConversationParticipant"("conversationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StakingTransaction_txHash_key" ON "public"."StakingTransaction"("txHash");

-- CreateIndex
CREATE INDEX "StakingTransaction_walletAddress_idx" ON "public"."StakingTransaction"("walletAddress");

-- CreateIndex
CREATE INDEX "StakingTransaction_status_idx" ON "public"."StakingTransaction"("status");

-- CreateIndex
CREATE INDEX "StakingTransaction_createdAt_idx" ON "public"."StakingTransaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StakingPosition_walletAddress_key" ON "public"."StakingPosition"("walletAddress");

-- CreateIndex
CREATE INDEX "StakingPosition_walletAddress_idx" ON "public"."StakingPosition"("walletAddress");

-- CreateIndex
CREATE INDEX "StakingPosition_isActive_idx" ON "public"."StakingPosition"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "StakingReward_claimTxHash_key" ON "public"."StakingReward"("claimTxHash");

-- CreateIndex
CREATE INDEX "StakingReward_walletAddress_idx" ON "public"."StakingReward"("walletAddress");

-- CreateIndex
CREATE INDEX "StakingReward_claimedAt_idx" ON "public"."StakingReward"("claimedAt");

-- CreateIndex
CREATE INDEX "StakingReward_createdAt_idx" ON "public"."StakingReward"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageRead" ADD CONSTRAINT "MessageRead_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageRead" ADD CONSTRAINT "MessageRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StakingTransaction" ADD CONSTRAINT "StakingTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StakingPosition" ADD CONSTRAINT "StakingPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StakingReward" ADD CONSTRAINT "StakingReward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
