/*
  Warnings:

  - A unique constraint covering the columns `[roomId]` on the table `Channel` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."RoomMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER');

-- AlterTable
ALTER TABLE "public"."Channel" ADD COLUMN     "roomId" TEXT;

-- CreateTable
CREATE TABLE "public"."Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "uniqueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxMembers" INTEGER NOT NULL DEFAULT 100,
    "privacy" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoomMember" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role" "public"."RoomMemberRole" NOT NULL DEFAULT 'MEMBER',

    CONSTRAINT "RoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoomInvite" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "message" TEXT,
    "expiresAt" TIMESTAMP(3),
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "usedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviteCode" TEXT NOT NULL,

    CONSTRAINT "RoomInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Room_uniqueId_key" ON "public"."Room"("uniqueId");

-- CreateIndex
CREATE INDEX "Room_privacy_idx" ON "public"."Room"("privacy");

-- CreateIndex
CREATE INDEX "Room_createdBy_idx" ON "public"."Room"("createdBy");

-- CreateIndex
CREATE INDEX "Room_isActive_idx" ON "public"."Room"("isActive");

-- CreateIndex
CREATE INDEX "Room_uniqueId_idx" ON "public"."Room"("uniqueId");

-- CreateIndex
CREATE INDEX "RoomMember_roomId_idx" ON "public"."RoomMember"("roomId");

-- CreateIndex
CREATE INDEX "RoomMember_userId_idx" ON "public"."RoomMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomMember_roomId_userId_key" ON "public"."RoomMember"("roomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomInvite_inviteCode_key" ON "public"."RoomInvite"("inviteCode");

-- CreateIndex
CREATE INDEX "RoomInvite_roomId_idx" ON "public"."RoomInvite"("roomId");

-- CreateIndex
CREATE INDEX "RoomInvite_invitedBy_idx" ON "public"."RoomInvite"("invitedBy");

-- CreateIndex
CREATE INDEX "RoomInvite_isUsed_idx" ON "public"."RoomInvite"("isUsed");

-- CreateIndex
CREATE INDEX "RoomInvite_expiresAt_idx" ON "public"."RoomInvite"("expiresAt");

-- CreateIndex
CREATE INDEX "RoomInvite_inviteCode_idx" ON "public"."RoomInvite"("inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_roomId_key" ON "public"."Channel"("roomId");

-- AddForeignKey
ALTER TABLE "public"."Channel" ADD CONSTRAINT "Channel_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Channel" ADD CONSTRAINT "Channel_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Room" ADD CONSTRAINT "Room_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomMember" ADD CONSTRAINT "RoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomMember" ADD CONSTRAINT "RoomMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomInvite" ADD CONSTRAINT "RoomInvite_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomInvite" ADD CONSTRAINT "RoomInvite_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomInvite" ADD CONSTRAINT "RoomInvite_usedBy_fkey" FOREIGN KEY ("usedBy") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
