-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'X', 'YOUTUBE');

-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('PRINCIPAL', 'COMPETITOR');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('REEL_SHORT_VIDEO', 'LONG_FORM_VIDEO', 'CAROUSEL', 'SINGLE_IMAGE', 'TEXT_ONLY', 'LINK', 'LIVE');

-- CreateEnum
CREATE TYPE "ContentPillar" AS ENUM ('POLICY_ANNOUNCEMENT', 'CONSTITUENCY_VISIT', 'PERSONAL_FAMILY', 'ATTACK_REBUTTAL', 'FESTIVAL_GREETING', 'ACHIEVEMENT_CLAIM', 'MEDIA_APPEARANCE', 'OTHER');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "personName" TEXT NOT NULL,
    "role" "AccountRole" NOT NULL,
    "platform" "Platform" NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "followerCount" INTEGER,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "postId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "caption" TEXT,
    "permalink" TEXT,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "views" INTEGER,
    "saves" INTEGER,
    "theme" "ContentPillar",
    "themeConfidence" DOUBLE PRECISION,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "rowsFetched" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorNote" TEXT,

    CONSTRAINT "IngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Account_personName_idx" ON "Account"("personName");

-- CreateIndex
CREATE UNIQUE INDEX "Account_platform_handle_key" ON "Account"("platform", "handle");

-- CreateIndex
CREATE INDEX "Post_accountId_postedAt_idx" ON "Post"("accountId", "postedAt");

-- CreateIndex
CREATE INDEX "Post_platform_mediaType_idx" ON "Post"("platform", "mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "Post_platform_postId_key" ON "Post"("platform", "postId");

-- CreateIndex
CREATE INDEX "IngestionRun_accountId_startedAt_idx" ON "IngestionRun"("accountId", "startedAt");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionRun" ADD CONSTRAINT "IngestionRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
