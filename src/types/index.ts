import {
  ChatInputCommandInteraction,
  Client,
  Collection,
  PermissionResolvable,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandSubcommandBuilder,
} from 'discord.js';

/**
 * Command-Interface für Slash-Commands.
 */
export interface Command {
  data: SlashCommandBuilder
    | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  cooldown?: number; // Sekunden
  permissions?: PermissionResolvable[];
  adminOnly?: boolean;
  devOnly?: boolean;
  manufacturerOnly?: boolean;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

/**
 * Event-Interface für Discord-Events.
 */
export interface BotEvent {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => Promise<void>;
}

/**
 * Extended Client mit Command-Collection.
 */
export interface ExtendedClient extends Client {
  commands: Collection<string, Command>;
}

/**
 * Upload-Paket Metadaten.
 */
export interface PackageMetadata {
  packageId: string;
  userId: string;
  name: string;
  description?: string;
  files: FileMetadata[];
  totalSize: number;
  createdAt: Date;
  status: string;
}

/**
 * Datei-Metadaten.
 */
export interface FileMetadata {
  uploadId: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileHash: string;
  fileType: string;
  isValid: boolean;
  validationStatus: string;
  uploadedAt: Date;
}

/**
 * Validierungs-Feedback.
 */
export interface ValidationFeedback {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

/**
 * Giveaway-Daten.
 */
export interface GiveawayData {
  id: string;
  prize: string;
  description?: string;
  channelId: string;
  messageId?: string;
  creatorId: string;
  duration: number;
  endsAt: Date;
  status: string;
  participantCount: number;
  winnerId?: string;
}

/**
 * Poll-Daten.
 */
export interface PollData {
  id: string;
  title: string;
  description?: string;
  options: PollOption[];
  pollType: string;
  allowMultiple: boolean;
  maxChoices: number;
  endsAt?: Date;
  status: string;
  totalVotes: number;
}

export interface PollOption {
  id: string;
  text: string;
  emoji?: string;
  votes?: number;
}

/**
 * Moderation-Case.
 */
export interface ModCaseData {
  caseNumber: number;
  targetUserId: string;
  moderatorId: string;
  action: string;
  reason: string;
  duration?: number;
  escalationLevel: number;
}

/**
 * Security-Event.
 */
export interface SecurityEventData {
  eventType: string;
  severity: string;
  description: string;
  userId?: string;
  ipAddress?: string;
  details?: Record<string, unknown>;
}

/**
 * Feed-Konfiguration.
 */
export interface FeedConfig {
  name: string;
  feedType: string;
  url: string;
  channelId: string;
  interval: number;
  filters?: Record<string, unknown>;
}

/**
 * Dashboard-Session.
 */
export interface DashboardSession {
  userId: string;
  discordId: string;
  role: string;
  deviceInfo?: string;
  ipAddress?: string;
  expiresAt: Date;
}

/**
 * XP-Konfiguration.
 */
export interface XpConfigData {
  messageXpMin: number;
  messageXpMax: number;
  voiceXpPerMinute: number;
  eventXpBonus: number;
  xpCooldownSeconds: number;
  levelMultiplier: number;
}
