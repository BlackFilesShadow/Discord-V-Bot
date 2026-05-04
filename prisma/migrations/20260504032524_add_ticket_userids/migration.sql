-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'MANUFACTURER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN', 'DEVELOPER', 'READ_ONLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BANNED', 'SUSPENDED', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'DELETED', 'VALIDATING');

-- CreateEnum
CREATE TYPE "FileType" AS ENUM ('XML', 'JSON', 'OTHER');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('PENDING', 'VALID', 'INVALID', 'ERROR', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "DownloadType" AS ENUM ('SINGLE_FILE', 'PACKAGE_ZIP', 'PACKAGE_TAR');

-- CreateEnum
CREATE TYPE "ModerationAction" AS ENUM ('KICK', 'BAN', 'TEMP_BAN', 'MUTE', 'TEMP_MUTE', 'WARN', 'FILTER', 'AUTO_MOD', 'ESCALATION');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "FilterType" AS ENUM ('KEYWORD', 'REGEX', 'LINK', 'INVITE', 'SPAM', 'CAPS', 'EMOJI_SPAM', 'MENTION_SPAM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AiAnalysisType" AS ENUM ('SENTIMENT', 'TOXICITY', 'CONTEXT', 'TRANSLATION', 'KNOWLEDGE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "GiveawayStatus" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED', 'REROLLED');

-- CreateEnum
CREATE TYPE "XpSource" AS ENUM ('MESSAGE', 'VOICE', 'EVENT', 'REACTION', 'BOOST', 'ADMIN', 'RESET', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AutoRoleTrigger" AS ENUM ('JOIN', 'REACTION', 'LEVEL', 'ACTIVITY', 'EVENT', 'GIVEAWAY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PollType" AS ENUM ('PUBLIC', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('ACTIVE', 'ENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('AUTH', 'REGISTRATION', 'UPLOAD', 'DOWNLOAD', 'MODERATION', 'GIVEAWAY', 'LEVEL', 'ROLE', 'POLL', 'SECURITY', 'ADMIN', 'SYSTEM', 'CONFIG', 'GDPR', 'AI', 'FEED', 'APPEAL', 'TICKET', 'NITRADO', 'ECONOMY', 'CASINO', 'DASHBOARD', 'WHITELIST', 'FACTION', 'SERVER_SETTINGS');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_FAILURE', 'BRUTE_FORCE', 'RATE_LIMIT_EXCEEDED', 'SUSPICIOUS_ACTIVITY', 'TOKEN_ABUSE', 'UNAUTHORIZED_ACCESS', 'DATA_BREACH_ATTEMPT', 'MALWARE_DETECTED', 'RAID_DETECTED', 'SPAM_DETECTED', 'IP_BLACKLISTED', 'DEVICE_CHANGE', 'PRIVILEGE_ESCALATION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ListType" AS ENUM ('BLACKLIST', 'WHITELIST');

-- CreateEnum
CREATE TYPE "DeletionType" AS ENUM ('FULL_DELETION', 'PARTIAL_DELETION', 'DATA_EXPORT', 'ANONYMIZATION');

-- CreateEnum
CREATE TYPE "DeletionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FeedType" AS ENUM ('RSS', 'TWITCH', 'TWITTER', 'STEAM', 'NEWS', 'WEBHOOK', 'CUSTOM');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'OPEN', 'DENIED', 'CLOSED');

-- CreateEnum
CREATE TYPE "NitradoConnectionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'PROBE_FAILED');

-- CreateEnum
CREATE TYPE "WhitelistRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EconomyTxType" AS ENUM ('PAY', 'ADMIN_PAY', 'DEPOSIT', 'WITHDRAW', 'TRANSFER', 'CASINO_BET', 'CASINO_PAYOUT', 'PLAYTIME_REWARD', 'STARTBALANCE_JOIN', 'GRANT', 'FINE', 'INTEREST');

-- CreateEnum
CREATE TYPE "CasinoGameType" AS ENUM ('SLOT', 'COINFLIP', 'DICE', 'BLACKJACK');

-- CreateEnum
CREATE TYPE "NitradoJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "NitradoSnapshotStatus" AS ENUM ('RUNNING', 'OK', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "KillCategory" AS ENUM ('DEATH', 'SUICIDE', 'NPC', 'VEHICLE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "discriminator" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "isManufacturer" BOOLEAN NOT NULL DEFAULT false,
    "manufacturerApprovedAt" TIMESTAMP(3),
    "manufacturerApprovedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturerRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "adminNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManufacturerRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OneTimePassword" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OneTimePassword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PackageStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "totalSize" BIGINT NOT NULL DEFAULT 0,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileType" "FileType" NOT NULL,
    "isValid" BOOLEAN NOT NULL DEFAULT false,
    "validationStatus" "ValidationStatus" NOT NULL DEFAULT 'PENDING',
    "isQuarantined" BOOLEAN NOT NULL DEFAULT false,
    "quarantineReason" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "chunkCount" INTEGER NOT NULL DEFAULT 1,
    "isChunked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationResult" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT,
    "packageId" TEXT,
    "isValid" BOOLEAN NOT NULL,
    "errors" JSONB,
    "warnings" JSONB,
    "suggestions" JSONB,
    "validatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Download" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "packageId" TEXT,
    "uploadId" TEXT,
    "downloadType" "DownloadType" NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Download_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "caseNumber" SERIAL NOT NULL,
    "guildId" TEXT,
    "targetUserId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "action" "ModerationAction" NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "duration" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoModFilter" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "filterType" "FilterType" NOT NULL,
    "action" "ModerationAction" NOT NULL DEFAULT 'FILTER',
    "severity" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "channelIds" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoModFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteTracking" (
    "id" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "channelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAnalysis" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "analysisType" "AiAnalysisType" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "label" TEXT,
    "details" JSONB,
    "actionTaken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Giveaway" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "prize" TEXT NOT NULL,
    "description" TEXT,
    "duration" INTEGER NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "winnerId" TEXT,
    "winnerCount" INTEGER NOT NULL DEFAULT 1,
    "status" "GiveawayStatus" NOT NULL DEFAULT 'ACTIVE',
    "minRole" TEXT,
    "blacklistRoles" JSONB,
    "customEmoji" TEXT,
    "notifyRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayEntry" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiveawayEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LevelData" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "xp" BIGINT NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "voiceMinutes" INTEGER NOT NULL DEFAULT 0,
    "lastXpGain" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LevelData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XpRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" "XpSource" NOT NULL,
    "channelId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XpConfig" (
    "id" TEXT NOT NULL,
    "messageXpMin" INTEGER NOT NULL DEFAULT 15,
    "messageXpMax" INTEGER NOT NULL DEFAULT 25,
    "voiceXpPerMinute" INTEGER NOT NULL DEFAULT 5,
    "eventXpBonus" INTEGER NOT NULL DEFAULT 50,
    "xpCooldownSeconds" INTEGER NOT NULL DEFAULT 60,
    "levelUpRoleIds" JSONB,
    "levelMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "allowedRoleIds" JSONB,
    "allowedChannelIds" JSONB,
    "maxLevel" INTEGER NOT NULL DEFAULT 20,
    "maxLevelRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XpConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LevelReward" (
    "id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "roleId" TEXT,
    "reward" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LevelReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LevelRole" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LevelRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LevelUpMessage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LevelUpMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoRole" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "roleId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "triggerType" "AutoRoleTrigger" NOT NULL,
    "triggerValue" TEXT,
    "channelId" TEXT,
    "messageId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "blacklistRoles" JSONB,
    "whitelistRoles" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedBy" TEXT NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Poll" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "options" JSONB NOT NULL,
    "pollType" "PollType" NOT NULL DEFAULT 'PUBLIC',
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "maxChoices" INTEGER NOT NULL DEFAULT 1,
    "endsAt" TIMESTAMP(3),
    "status" "PollStatus" NOT NULL DEFAULT 'ACTIVE',
    "totalVotes" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "notifyRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Poll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "deviceInfo" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenType" TEXT NOT NULL DEFAULT 'Bearer',
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastRefresh" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorAuth" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "backupCodes" JSONB,
    "webauthnEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webauthnCredentials" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "targetId" TEXT,
    "action" TEXT NOT NULL,
    "category" "AuditCategory" NOT NULL,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "channelId" TEXT,
    "guildId" TEXT,
    "isImmutable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "eventType" "SecurityEventType" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpList" (
    "id" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "listType" "ListType" NOT NULL,
    "reason" TEXT,
    "addedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IpList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GdprConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dataProcessing" BOOLEAN NOT NULL DEFAULT false,
    "analytics" BOOLEAN NOT NULL DEFAULT false,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "consentVersion" TEXT NOT NULL DEFAULT '1.0',
    "ipAddress" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GdprConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataDeletionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "requestType" "DeletionType" NOT NULL,
    "status" "DeletionStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feed" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "feedType" "FeedType" NOT NULL,
    "url" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 300,
    "lastChecked" TIMESTAMP(3),
    "lastItemId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "filters" JSONB,
    "mentionRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "webhookSecret" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedSubscription" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notifyDm" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "description" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitEntry" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "rateLimit" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "ticketNumber" SERIAL NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "guildId" TEXT,
    "guildName" TEXT,
    "subject" TEXT NOT NULL,
    "initialMessage" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'PENDING',
    "ownerDiscordId" TEXT NOT NULL,
    "ownerNoticeMsgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromDiscordId" TEXT NOT NULL,
    "fromRole" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketTemplate" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "welcomeText" TEXT NOT NULL,
    "welcomeMessages" JSONB NOT NULL DEFAULT '[]',
    "embedTitle" TEXT NOT NULL,
    "embedColor" TEXT NOT NULL DEFAULT '#dc2626',
    "postChannelId" TEXT NOT NULL,
    "postedMessageId" TEXT,
    "categoryId" TEXT,
    "staffRoleId" TEXT,
    "managerRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentionRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "transcriptChannelId" TEXT NOT NULL,
    "archiveChannelId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ticketCounter" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketInstance" (
    "id" TEXT NOT NULL,
    "ticketNumber" SERIAL NOT NULL,
    "templateNumber" INTEGER,
    "templateId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "openerDiscordId" TEXT NOT NULL,
    "openerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "transcriptMessageId" TEXT,

    CONSTRAINT "TicketInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildProfile" (
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT,
    "ownerName" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "channelCount" INTEGER NOT NULL DEFAULT 0,
    "roleCount" INTEGER NOT NULL DEFAULT 0,
    "iconUrl" TEXT,
    "preferredLocale" TEXT,
    "description" TEXT,
    "features" JSONB,
    "serverCreatedAt" TIMESTAMP(3),
    "channelsJson" JSONB,
    "rulesText" TEXT,
    "contentSyncedAt" TIMESTAMP(3),
    "aiPersonaOverride" TEXT,
    "aiBrief" TEXT,
    "aiBriefAt" TIMESTAMP(3),
    "verificationLevel" TEXT,
    "premiumTier" INTEGER,
    "premiumSubscriptionCount" INTEGER,
    "vanityUrlCode" TEXT,
    "bannerUrl" TEXT,
    "splashUrl" TEXT,
    "afkChannelName" TEXT,
    "afkTimeoutSec" INTEGER,
    "systemChannelName" TEXT,
    "rulesChannelName" TEXT,
    "publicUpdatesChannelName" TEXT,
    "nsfwLevel" TEXT,
    "mfaLevel" TEXT,
    "emojiCount" INTEGER,
    "stickerCount" INTEGER,
    "isLarge" BOOLEAN,
    "botCount" INTEGER,
    "topRolesJson" JSONB,
    "feedbackChannelId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildProfile_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "GuildMemberProfile" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "username" TEXT,
    "nickname" TEXT,
    "joinedAt" TIMESTAMP(3),
    "topRolesJson" JSONB,
    "isBoosting" BOOLEAN NOT NULL DEFAULT false,
    "boostingSince" TIMESTAMP(3),
    "isPending" BOOLEAN NOT NULL DEFAULT false,
    "timeoutUntil" TIMESTAMP(3),
    "isLeft" BOOLEAN NOT NULL DEFAULT false,
    "leftAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildMemberProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildKnowledge" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "embedding" TEXT,
    "embeddingModel" TEXT,
    "embeddedAt" TIMESTAMP(3),

    CONSTRAINT "GuildKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProviderStat" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "rateLimitCount" INTEGER NOT NULL DEFAULT 0,
    "totalLatencyMs" BIGINT NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversationTurn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "guildId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConversationTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslatedPost" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "sourceLang" TEXT NOT NULL,
    "targetLang" TEXT NOT NULL,
    "translatedText" TEXT,
    "customTitle" VARCHAR(200),
    "imageUrl" TEXT,
    "rolePings" TEXT,
    "mode" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "recurrenceCron" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslatedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" VARCHAR(120) NOT NULL,
    "message" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "adminNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notifyChannelId" TEXT,
    "notifyMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT,
    "channelId" TEXT,
    "message" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrenceMs" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfRoleMenu" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'MULTI',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfRoleMenu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfRoleOption" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "emoji" TEXT,
    "description" VARCHAR(100),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelfRoleOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardGuildLink" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerDiscordId" TEXT NOT NULL,
    "alias5" VARCHAR(5) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardGuildLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NitradoConnection" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "alias" VARCHAR(40) NOT NULL,
    "alias5" VARCHAR(5) NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "nitradoServerId" TEXT,
    "serviceId" TEXT,
    "status" "NitradoConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastValidatedAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "addedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildPermissionGrant" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "grantedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildPermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildPermissionRoleGrant" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleDiscordId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "grantedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildPermissionRoleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerSettings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "whitelistActive" BOOLEAN NOT NULL DEFAULT false,
    "economyActive" BOOLEAN NOT NULL DEFAULT false,
    "permaOnly" BOOLEAN NOT NULL DEFAULT false,
    "whitelistChannelId" TEXT,
    "whitelistRequestChannelId" TEXT,
    "whitelistInfoMessageId" TEXT,
    "whitelistApproveLogChannelId" TEXT,
    "whitelistDenyLogChannelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Faction" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "flagUrl" TEXT,
    "bannerUrl" TEXT,
    "mediaUrl" TEXT,
    "leaderDiscordId" TEXT,
    "deputyDiscordId" TEXT,
    "treasurerDiscordId" TEXT,
    "embedChannelId" TEXT,
    "embedMessageId" TEXT,
    "roleId" TEXT,
    "joinPolicy" TEXT NOT NULL DEFAULT 'REQUEST',
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "color" VARCHAR(7),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactionSystemConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "factionChannelId" TEXT,
    "listMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FactionSystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactionMember" (
    "id" TEXT NOT NULL,
    "factionId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactionMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhitelistEntry" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "approvedByDiscordId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'DIRECT',
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhitelistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhitelistRequest" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "requesterDiscordId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "status" "WhitelistRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByDiscordId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhitelistRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "currencyName" VARCHAR(40) NOT NULL DEFAULT 'Coins',
    "emoji" VARCHAR(40) NOT NULL DEFAULT '💰',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startBalance" INTEGER NOT NULL DEFAULT 0,
    "playtimeRewardPercent" INTEGER NOT NULL DEFAULT 5,
    "bankChannelId" TEXT,
    "bankInterestPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyAccount" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "walletBalance" BIGINT NOT NULL DEFAULT 0,
    "bankBalance" BIGINT NOT NULL DEFAULT 0,
    "lifetimeEarned" BIGINT NOT NULL DEFAULT 0,
    "lifetimeSpent" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyTransaction" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "type" "EconomyTxType" NOT NULL,
    "reason" VARCHAR(200),
    "actorDiscordId" TEXT,
    "counterpartDiscordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyLink" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "EconomyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CasinoGame" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "CasinoGameType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "winChancePct" INTEGER NOT NULL DEFAULT 45,
    "minBet" BIGINT NOT NULL DEFAULT 1,
    "maxBet" BIGINT NOT NULL DEFAULT 10000,
    "payoutMult" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CasinoGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CasinoRound" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "bet" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL DEFAULT 0,
    "result" JSONB NOT NULL,
    "serverSeed" VARCHAR(128) NOT NULL,
    "clientSeed" VARCHAR(128),
    "nonce" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CasinoRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevSession" (
    "id" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DevSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevUpload" (
    "id" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "storedPath" VARCHAR(512) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DevUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "hash" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "NitradoJob" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "operation" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NitradoJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NitradoSnapshot" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "serviceId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "NitradoSnapshotStatus" NOT NULL DEFAULT 'RUNNING',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "totalDirs" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "storedBytes" BIGINT NOT NULL DEFAULT 0,
    "oversizeFiles" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "settingsJson" JSONB,
    "serviceMetaJson" JSONB,

    CONSTRAINT "NitradoSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NitradoSnapshotFile" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "name" VARCHAR(512) NOT NULL,
    "parentDir" VARCHAR(1024) NOT NULL,
    "isDir" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "modifiedAt" TIMESTAMP(3),
    "sha256" VARCHAR(64),
    "mimeGuess" VARCHAR(120),
    "isText" BOOLEAN NOT NULL DEFAULT false,
    "contentText" TEXT,
    "storedPath" VARCHAR(512),
    "oversize" BOOLEAN NOT NULL DEFAULT false,
    "errorMsg" TEXT,

    CONSTRAINT "NitradoSnapshotFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KillfeedConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" VARCHAR(32) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "categories" "KillCategory"[],
    "showShooterCoords" BOOLEAN NOT NULL DEFAULT false,
    "showVictimCoords" BOOLEAN NOT NULL DEFAULT true,
    "showWeapon" BOOLEAN NOT NULL DEFAULT true,
    "showDistance" BOOLEAN NOT NULL DEFAULT true,
    "embedColor" VARCHAR(9) NOT NULL DEFAULT '#dc2626',
    "lastEventAt" TIMESTAMP(3),
    "lastEtag" VARCHAR(128),
    "lastFileName" VARCHAR(256),
    "lastByteOffset" BIGINT NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "lastErrorMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KillfeedConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KillfeedEvent" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "category" "KillCategory" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "shooterName" VARCHAR(120),
    "shooterPos" VARCHAR(120),
    "victimName" VARCHAR(120) NOT NULL,
    "victimPos" VARCHAR(120),
    "weapon" VARCHAR(120),
    "distance" DOUBLE PRECISION,
    "rawLine" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KillfeedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_discordId_key" ON "User"("discordId");

-- CreateIndex
CREATE INDEX "User_discordId_idx" ON "User"("discordId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturerRequest_userId_key" ON "ManufacturerRequest"("userId");

-- CreateIndex
CREATE INDEX "ManufacturerRequest_status_idx" ON "ManufacturerRequest"("status");

-- CreateIndex
CREATE INDEX "OneTimePassword_userId_idx" ON "OneTimePassword"("userId");

-- CreateIndex
CREATE INDEX "OneTimePassword_expiresAt_idx" ON "OneTimePassword"("expiresAt");

-- CreateIndex
CREATE INDEX "Package_userId_idx" ON "Package"("userId");

-- CreateIndex
CREATE INDEX "Package_status_idx" ON "Package"("status");

-- CreateIndex
CREATE INDEX "Package_isDeleted_idx" ON "Package"("isDeleted");

-- CreateIndex
CREATE INDEX "Package_name_idx" ON "Package"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Package_userId_name_key" ON "Package"("userId", "name");

-- CreateIndex
CREATE INDEX "Upload_userId_idx" ON "Upload"("userId");

-- CreateIndex
CREATE INDEX "Upload_packageId_idx" ON "Upload"("packageId");

-- CreateIndex
CREATE INDEX "Upload_fileType_idx" ON "Upload"("fileType");

-- CreateIndex
CREATE INDEX "Upload_validationStatus_idx" ON "Upload"("validationStatus");

-- CreateIndex
CREATE INDEX "Upload_isDeleted_idx" ON "Upload"("isDeleted");

-- CreateIndex
CREATE INDEX "ValidationResult_uploadId_idx" ON "ValidationResult"("uploadId");

-- CreateIndex
CREATE INDEX "ValidationResult_packageId_idx" ON "ValidationResult"("packageId");

-- CreateIndex
CREATE INDEX "Download_userId_idx" ON "Download"("userId");

-- CreateIndex
CREATE INDEX "Download_packageId_idx" ON "Download"("packageId");

-- CreateIndex
CREATE INDEX "Download_uploadId_idx" ON "Download"("uploadId");

-- CreateIndex
CREATE INDEX "Download_createdAt_idx" ON "Download"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModerationCase_caseNumber_key" ON "ModerationCase"("caseNumber");

-- CreateIndex
CREATE INDEX "ModerationCase_targetUserId_idx" ON "ModerationCase"("targetUserId");

-- CreateIndex
CREATE INDEX "ModerationCase_moderatorId_idx" ON "ModerationCase"("moderatorId");

-- CreateIndex
CREATE INDEX "ModerationCase_action_idx" ON "ModerationCase"("action");

-- CreateIndex
CREATE INDEX "ModerationCase_isActive_idx" ON "ModerationCase"("isActive");

-- CreateIndex
CREATE INDEX "ModerationCase_caseNumber_idx" ON "ModerationCase"("caseNumber");

-- CreateIndex
CREATE INDEX "ModerationCase_guildId_idx" ON "ModerationCase"("guildId");

-- CreateIndex
CREATE INDEX "Appeal_caseId_idx" ON "Appeal"("caseId");

-- CreateIndex
CREATE INDEX "Appeal_userId_idx" ON "Appeal"("userId");

-- CreateIndex
CREATE INDEX "Appeal_status_idx" ON "Appeal"("status");

-- CreateIndex
CREATE INDEX "AutoModFilter_filterType_idx" ON "AutoModFilter"("filterType");

-- CreateIndex
CREATE INDEX "AutoModFilter_isActive_idx" ON "AutoModFilter"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "InviteTracking_inviteCode_key" ON "InviteTracking"("inviteCode");

-- CreateIndex
CREATE INDEX "InviteTracking_inviterId_idx" ON "InviteTracking"("inviterId");

-- CreateIndex
CREATE INDEX "AiAnalysis_userId_idx" ON "AiAnalysis"("userId");

-- CreateIndex
CREATE INDEX "AiAnalysis_analysisType_idx" ON "AiAnalysis"("analysisType");

-- CreateIndex
CREATE INDEX "AiAnalysis_createdAt_idx" ON "AiAnalysis"("createdAt");

-- CreateIndex
CREATE INDEX "Giveaway_status_idx" ON "Giveaway"("status");

-- CreateIndex
CREATE INDEX "Giveaway_endsAt_idx" ON "Giveaway"("endsAt");

-- CreateIndex
CREATE INDEX "Giveaway_channelId_idx" ON "Giveaway"("channelId");

-- CreateIndex
CREATE INDEX "GiveawayEntry_giveawayId_idx" ON "GiveawayEntry"("giveawayId");

-- CreateIndex
CREATE INDEX "GiveawayEntry_userId_idx" ON "GiveawayEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GiveawayEntry_giveawayId_userId_key" ON "GiveawayEntry"("giveawayId", "userId");

-- CreateIndex
CREATE INDEX "LevelData_guildId_idx" ON "LevelData"("guildId");

-- CreateIndex
CREATE INDEX "LevelData_level_idx" ON "LevelData"("level");

-- CreateIndex
CREATE INDEX "LevelData_xp_idx" ON "LevelData"("xp");

-- CreateIndex
CREATE UNIQUE INDEX "LevelData_userId_guildId_key" ON "LevelData"("userId", "guildId");

-- CreateIndex
CREATE INDEX "XpRecord_userId_idx" ON "XpRecord"("userId");

-- CreateIndex
CREATE INDEX "XpRecord_guildId_idx" ON "XpRecord"("guildId");

-- CreateIndex
CREATE INDEX "XpRecord_source_idx" ON "XpRecord"("source");

-- CreateIndex
CREATE INDEX "XpRecord_createdAt_idx" ON "XpRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LevelReward_level_key" ON "LevelReward"("level");

-- CreateIndex
CREATE INDEX "LevelReward_level_idx" ON "LevelReward"("level");

-- CreateIndex
CREATE INDEX "LevelRole_guildId_idx" ON "LevelRole"("guildId");

-- CreateIndex
CREATE INDEX "LevelRole_roleId_idx" ON "LevelRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "LevelRole_guildId_level_key" ON "LevelRole"("guildId", "level");

-- CreateIndex
CREATE INDEX "LevelUpMessage_guildId_idx" ON "LevelUpMessage"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "LevelUpMessage_guildId_level_key" ON "LevelUpMessage"("guildId", "level");

-- CreateIndex
CREATE INDEX "AutoRole_guildId_idx" ON "AutoRole"("guildId");

-- CreateIndex
CREATE INDEX "AutoRole_triggerType_idx" ON "AutoRole"("triggerType");

-- CreateIndex
CREATE INDEX "AutoRole_isActive_idx" ON "AutoRole"("isActive");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_userId_idx" ON "UserRoleAssignment"("userId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_roleId_idx" ON "UserRoleAssignment"("roleId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_isActive_idx" ON "UserRoleAssignment"("isActive");

-- CreateIndex
CREATE INDEX "Poll_status_idx" ON "Poll"("status");

-- CreateIndex
CREATE INDEX "Poll_channelId_idx" ON "Poll"("channelId");

-- CreateIndex
CREATE INDEX "Poll_endsAt_idx" ON "Poll"("endsAt");

-- CreateIndex
CREATE INDEX "PollVote_pollId_idx" ON "PollVote"("pollId");

-- CreateIndex
CREATE INDEX "PollVote_userId_idx" ON "PollVote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PollVote_pollId_userId_optionId_key" ON "PollVote"("pollId", "userId", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_token_idx" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_isActive_idx" ON "Session"("isActive");

-- CreateIndex
CREATE INDEX "IDX_session_expire" ON "session"("expire");

-- CreateIndex
CREATE INDEX "OAuthToken_userId_idx" ON "OAuthToken"("userId");

-- CreateIndex
CREATE INDEX "OAuthToken_expiresAt_idx" ON "OAuthToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorAuth_userId_key" ON "TwoFactorAuth"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_targetId_idx" ON "AuditLog"("targetId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_category_idx" ON "AuditLog"("category");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_eventType_idx" ON "SecurityEvent"("eventType");

-- CreateIndex
CREATE INDEX "SecurityEvent_severity_idx" ON "SecurityEvent"("severity");

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_idx" ON "SecurityEvent"("userId");

-- CreateIndex
CREATE INDEX "SecurityEvent_isResolved_idx" ON "SecurityEvent"("isResolved");

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IpList_ipAddress_key" ON "IpList"("ipAddress");

-- CreateIndex
CREATE INDEX "IpList_listType_idx" ON "IpList"("listType");

-- CreateIndex
CREATE INDEX "IpList_ipAddress_idx" ON "IpList"("ipAddress");

-- CreateIndex
CREATE UNIQUE INDEX "GdprConsent_userId_key" ON "GdprConsent"("userId");

-- CreateIndex
CREATE INDEX "GdprConsent_userId_idx" ON "GdprConsent"("userId");

-- CreateIndex
CREATE INDEX "DataDeletionRequest_status_idx" ON "DataDeletionRequest"("status");

-- CreateIndex
CREATE INDEX "DataDeletionRequest_scheduledAt_idx" ON "DataDeletionRequest"("scheduledAt");

-- CreateIndex
CREATE INDEX "Feed_feedType_idx" ON "Feed"("feedType");

-- CreateIndex
CREATE INDEX "Feed_isActive_idx" ON "Feed"("isActive");

-- CreateIndex
CREATE INDEX "FeedSubscription_feedId_idx" ON "FeedSubscription"("feedId");

-- CreateIndex
CREATE INDEX "FeedSubscription_userId_idx" ON "FeedSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedSubscription_feedId_userId_key" ON "FeedSubscription"("feedId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_key_key" ON "BotConfig"("key");

-- CreateIndex
CREATE INDEX "BotConfig_category_idx" ON "BotConfig"("category");

-- CreateIndex
CREATE INDEX "BotConfig_key_idx" ON "BotConfig"("key");

-- CreateIndex
CREATE INDEX "RateLimitEntry_identifier_idx" ON "RateLimitEntry"("identifier");

-- CreateIndex
CREATE INDEX "RateLimitEntry_expiresAt_idx" ON "RateLimitEntry"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitEntry_identifier_action_key" ON "RateLimitEntry"("identifier", "action");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_keyPrefix_idx" ON "ApiKey"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_ticketNumber_key" ON "Ticket"("ticketNumber");

-- CreateIndex
CREATE INDEX "Ticket_userDiscordId_idx" ON "Ticket"("userDiscordId");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE INDEX "Ticket_ticketNumber_idx" ON "Ticket"("ticketNumber");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");

-- CreateIndex
CREATE INDEX "TicketMessage_createdAt_idx" ON "TicketMessage"("createdAt");

-- CreateIndex
CREATE INDEX "TicketTemplate_guildId_idx" ON "TicketTemplate"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketTemplate_guildId_slot_key" ON "TicketTemplate"("guildId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "TicketInstance_ticketNumber_key" ON "TicketInstance"("ticketNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TicketInstance_channelId_key" ON "TicketInstance"("channelId");

-- CreateIndex
CREATE INDEX "TicketInstance_guildId_status_idx" ON "TicketInstance"("guildId", "status");

-- CreateIndex
CREATE INDEX "TicketInstance_templateId_idx" ON "TicketInstance"("templateId");

-- CreateIndex
CREATE INDEX "TicketInstance_templateId_templateNumber_idx" ON "TicketInstance"("templateId", "templateNumber");

-- CreateIndex
CREATE INDEX "GuildProfile_name_idx" ON "GuildProfile"("name");

-- CreateIndex
CREATE INDEX "GuildMemberProfile_guildId_idx" ON "GuildMemberProfile"("guildId");

-- CreateIndex
CREATE INDEX "GuildMemberProfile_discordId_idx" ON "GuildMemberProfile"("discordId");

-- CreateIndex
CREATE INDEX "GuildMemberProfile_guildId_lastSeenAt_idx" ON "GuildMemberProfile"("guildId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuildMemberProfile_guildId_discordId_key" ON "GuildMemberProfile"("guildId", "discordId");

-- CreateIndex
CREATE INDEX "GuildKnowledge_guildId_idx" ON "GuildKnowledge"("guildId");

-- CreateIndex
CREATE INDEX "GuildKnowledge_guildId_isActive_idx" ON "GuildKnowledge"("guildId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderStat_provider_key" ON "AiProviderStat"("provider");

-- CreateIndex
CREATE INDEX "AiConversationTurn_userId_channelId_createdAt_idx" ON "AiConversationTurn"("userId", "channelId", "createdAt");

-- CreateIndex
CREATE INDEX "AiConversationTurn_createdAt_idx" ON "AiConversationTurn"("createdAt");

-- CreateIndex
CREATE INDEX "TranslatedPost_guildId_isActive_idx" ON "TranslatedPost"("guildId", "isActive");

-- CreateIndex
CREATE INDEX "TranslatedPost_nextRunAt_isActive_idx" ON "TranslatedPost"("nextRunAt", "isActive");

-- CreateIndex
CREATE INDEX "Feedback_guildId_status_createdAt_idx" ON "Feedback"("guildId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");

-- CreateIndex
CREATE INDEX "Reminder_userId_isActive_idx" ON "Reminder"("userId", "isActive");

-- CreateIndex
CREATE INDEX "Reminder_dueAt_isActive_idx" ON "Reminder"("dueAt", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SelfRoleMenu_messageId_key" ON "SelfRoleMenu"("messageId");

-- CreateIndex
CREATE INDEX "SelfRoleMenu_guildId_isActive_idx" ON "SelfRoleMenu"("guildId", "isActive");

-- CreateIndex
CREATE INDEX "SelfRoleOption_menuId_position_idx" ON "SelfRoleOption"("menuId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SelfRoleOption_menuId_roleId_key" ON "SelfRoleOption"("menuId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardGuildLink_guildId_key" ON "DashboardGuildLink"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardGuildLink_alias5_key" ON "DashboardGuildLink"("alias5");

-- CreateIndex
CREATE INDEX "DashboardGuildLink_ownerDiscordId_idx" ON "DashboardGuildLink"("ownerDiscordId");

-- CreateIndex
CREATE UNIQUE INDEX "NitradoConnection_alias5_key" ON "NitradoConnection"("alias5");

-- CreateIndex
CREATE INDEX "NitradoConnection_guildId_idx" ON "NitradoConnection"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "NitradoConnection_guildId_slot_key" ON "NitradoConnection"("guildId", "slot");

-- CreateIndex
CREATE INDEX "GuildPermissionGrant_guildId_idx" ON "GuildPermissionGrant"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "GuildPermissionGrant_guildId_userDiscordId_key" ON "GuildPermissionGrant"("guildId", "userDiscordId");

-- CreateIndex
CREATE INDEX "GuildPermissionRoleGrant_guildId_idx" ON "GuildPermissionRoleGrant"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "GuildPermissionRoleGrant_guildId_roleDiscordId_key" ON "GuildPermissionRoleGrant"("guildId", "roleDiscordId");

-- CreateIndex
CREATE INDEX "ServerSettings_guildId_idx" ON "ServerSettings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerSettings_guildId_nitradoConnId_key" ON "ServerSettings"("guildId", "nitradoConnId");

-- CreateIndex
CREATE INDEX "Faction_guildId_idx" ON "Faction"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "Faction_guildId_nitradoConnId_name_key" ON "Faction"("guildId", "nitradoConnId", "name");

-- CreateIndex
CREATE INDEX "FactionSystemConfig_guildId_idx" ON "FactionSystemConfig"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "FactionSystemConfig_guildId_nitradoConnId_key" ON "FactionSystemConfig"("guildId", "nitradoConnId");

-- CreateIndex
CREATE INDEX "FactionMember_userDiscordId_idx" ON "FactionMember"("userDiscordId");

-- CreateIndex
CREATE UNIQUE INDEX "FactionMember_factionId_userDiscordId_key" ON "FactionMember"("factionId", "userDiscordId");

-- CreateIndex
CREATE INDEX "WhitelistEntry_guildId_idx" ON "WhitelistEntry"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "WhitelistEntry_guildId_nitradoConnId_gameId_key" ON "WhitelistEntry"("guildId", "nitradoConnId", "gameId");

-- CreateIndex
CREATE UNIQUE INDEX "WhitelistRequest_messageId_key" ON "WhitelistRequest"("messageId");

-- CreateIndex
CREATE INDEX "WhitelistRequest_guildId_status_idx" ON "WhitelistRequest"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyConfig_guildId_key" ON "EconomyConfig"("guildId");

-- CreateIndex
CREATE INDEX "EconomyConfig_guildId_idx" ON "EconomyConfig"("guildId");

-- CreateIndex
CREATE INDEX "EconomyAccount_guildId_idx" ON "EconomyAccount"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyAccount_guildId_userDiscordId_key" ON "EconomyAccount"("guildId", "userDiscordId");

-- CreateIndex
CREATE INDEX "EconomyTransaction_guildId_userDiscordId_createdAt_idx" ON "EconomyTransaction"("guildId", "userDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "EconomyTransaction_guildId_createdAt_idx" ON "EconomyTransaction"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "EconomyLink_guildId_idx" ON "EconomyLink"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyLink_guildId_nitradoConnId_userDiscordId_key" ON "EconomyLink"("guildId", "nitradoConnId", "userDiscordId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyLink_guildId_nitradoConnId_gameId_key" ON "EconomyLink"("guildId", "nitradoConnId", "gameId");

-- CreateIndex
CREATE UNIQUE INDEX "CasinoGame_guildId_type_key" ON "CasinoGame"("guildId", "type");

-- CreateIndex
CREATE INDEX "CasinoRound_guildId_userDiscordId_createdAt_idx" ON "CasinoRound"("guildId", "userDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "CasinoRound_gameId_createdAt_idx" ON "CasinoRound"("gameId", "createdAt");

-- CreateIndex
CREATE INDEX "DevSession_userDiscordId_idx" ON "DevSession"("userDiscordId");

-- CreateIndex
CREATE INDEX "DevSession_expiresAt_idx" ON "DevSession"("expiresAt");

-- CreateIndex
CREATE INDEX "DevUpload_userDiscordId_createdAt_idx" ON "DevUpload"("userDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "DevUpload_expiresAt_idx" ON "DevUpload"("expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "NitradoJob_status_nextRunAt_idx" ON "NitradoJob"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "NitradoJob_guildId_idx" ON "NitradoJob"("guildId");

-- CreateIndex
CREATE INDEX "NitradoSnapshot_guildId_nitradoConnId_startedAt_idx" ON "NitradoSnapshot"("guildId", "nitradoConnId", "startedAt");

-- CreateIndex
CREATE INDEX "NitradoSnapshot_nitradoConnId_status_idx" ON "NitradoSnapshot"("nitradoConnId", "status");

-- CreateIndex
CREATE INDEX "NitradoSnapshotFile_snapshotId_parentDir_idx" ON "NitradoSnapshotFile"("snapshotId", "parentDir");

-- CreateIndex
CREATE INDEX "NitradoSnapshotFile_snapshotId_name_idx" ON "NitradoSnapshotFile"("snapshotId", "name");

-- CreateIndex
CREATE INDEX "NitradoSnapshotFile_snapshotId_sha256_idx" ON "NitradoSnapshotFile"("snapshotId", "sha256");

-- CreateIndex
CREATE INDEX "KillfeedConfig_guildId_nitradoConnId_idx" ON "KillfeedConfig"("guildId", "nitradoConnId");

-- CreateIndex
CREATE INDEX "KillfeedConfig_guildId_isActive_idx" ON "KillfeedConfig"("guildId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "KillfeedConfig_guildId_nitradoConnId_channelId_key" ON "KillfeedConfig"("guildId", "nitradoConnId", "channelId");

-- CreateIndex
CREATE INDEX "KillfeedEvent_guildId_nitradoConnId_occurredAt_idx" ON "KillfeedEvent"("guildId", "nitradoConnId", "occurredAt");

-- CreateIndex
CREATE INDEX "KillfeedEvent_guildId_nitradoConnId_category_idx" ON "KillfeedEvent"("guildId", "nitradoConnId", "category");

-- AddForeignKey
ALTER TABLE "ManufacturerRequest" ADD CONSTRAINT "ManufacturerRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneTimePassword" ADD CONSTRAINT "OneTimePassword_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationResult" ADD CONSTRAINT "ValidationResult_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationResult" ADD CONSTRAINT "ValidationResult_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Download" ADD CONSTRAINT "Download_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Download" ADD CONSTRAINT "Download_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Download" ADD CONSTRAINT "Download_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteTracking" ADD CONSTRAINT "InviteTracking_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Giveaway" ADD CONSTRAINT "Giveaway_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LevelData" ADD CONSTRAINT "LevelData_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XpRecord" ADD CONSTRAINT "XpRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorAuth" ADD CONSTRAINT "TwoFactorAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GdprConsent" ADD CONSTRAINT "GdprConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedSubscription" ADD CONSTRAINT "FeedSubscription_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedSubscription" ADD CONSTRAINT "FeedSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketInstance" ADD CONSTRAINT "TicketInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TicketTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMemberProfile" ADD CONSTRAINT "GuildMemberProfile_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildProfile"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildKnowledge" ADD CONSTRAINT "GuildKnowledge_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildProfile"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfRoleOption" ADD CONSTRAINT "SelfRoleOption_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "SelfRoleMenu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSettings" ADD CONSTRAINT "ServerSettings_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Faction" ADD CONSTRAINT "Faction_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionSystemConfig" ADD CONSTRAINT "FactionSystemConfig_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionMember" ADD CONSTRAINT "FactionMember_factionId_fkey" FOREIGN KEY ("factionId") REFERENCES "Faction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhitelistEntry" ADD CONSTRAINT "WhitelistEntry_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhitelistRequest" ADD CONSTRAINT "WhitelistRequest_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EconomyLink" ADD CONSTRAINT "EconomyLink_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CasinoRound" ADD CONSTRAINT "CasinoRound_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "CasinoGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NitradoSnapshot" ADD CONSTRAINT "NitradoSnapshot_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NitradoSnapshotFile" ADD CONSTRAINT "NitradoSnapshotFile_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "NitradoSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KillfeedConfig" ADD CONSTRAINT "KillfeedConfig_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KillfeedEvent" ADD CONSTRAINT "KillfeedEvent_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

