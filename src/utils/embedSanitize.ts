/**
 * Embed-Sanitization-Helpers.
 *
 * Zweck: Verhindert Markdown-Injection, Mention-Bypass und Discord-API-Errors
 * durch zu lange Felder, wenn USER-CONTENT in Embeds gerendert wird.
 *
 * Discord-Limits (Stand 2026):
 *   - Embed.title         max 256 Zeichen
 *   - Embed.description   max 4096 Zeichen
 *   - Field.name          max 256 Zeichen
 *   - Field.value         max 1024 Zeichen
 *   - Footer.text         max 2048 Zeichen
 *   - Author.name         max 256 Zeichen
 *   - Total per Embed     max 6000 Zeichen
 *
 * Regel: JEDE User-gelieferte Zeichenkette MUSS durch eine dieser Funktionen
 * gehen, bevor sie in einem Embed landet. Bot-eigene/konstante Texte
 * brauchen das nicht.
 */
import { escapeMarkdown } from 'discord.js';

/**
 * Sanitisiert User-Content fuer ein Embed-Field-Value (max 1024 Zeichen).
 * - Escaped Markdown (verhindert ** _ ` ~~ etc. Manipulation)
 * - Hart auf maxLength gekappt mit '...' Suffix bei Trunkation
 * - null/undefined -> Default (leerer ZWS '\u200B' fuer Discord-Konformitaet)
 */
export function safeEmbedField(value: unknown, maxLength: number = 1024): string {
  if (value === null || value === undefined) return '\u200B';
  const raw = typeof value === 'string' ? value : String(value);
  if (raw.length === 0) return '\u200B';
  const escaped = escapeMarkdown(raw);
  if (escaped.length <= maxLength) return escaped;
  // Truncate auf maxLength - 3 fuer Suffix; ZWS-fix fuer Edge-Case 0
  const cut = Math.max(1, maxLength - 3);
  return `${escaped.slice(0, cut)}...`;
}

/**
 * Sanitisiert User-Content fuer Embed-Title (max 256 Zeichen).
 */
export function safeEmbedTitle(value: unknown): string {
  return safeEmbedField(value, 256);
}

/**
 * Sanitisiert User-Content fuer Embed-Description (max 4096 Zeichen).
 */
export function safeEmbedDescription(value: unknown): string {
  return safeEmbedField(value, 4096);
}

/**
 * Sanitisiert User-Content fuer Embed-Author-Name (max 256 Zeichen).
 */
export function safeEmbedAuthor(value: unknown): string {
  return safeEmbedField(value, 256);
}

/**
 * Sanitisiert User-Content fuer Embed-Footer-Text (max 2048 Zeichen).
 */
export function safeEmbedFooter(value: unknown): string {
  return safeEmbedField(value, 2048);
}

/**
 * Entfernt @everyone/@here-Mentions aus User-Content (Mention-Bypass-Schutz).
 * ZWS zwischen @ und everyone/here verhindert die Mention.
 * Verwendung: zusaetzlich zu safeEmbedField wenn AllowedMentions nicht gesetzt
 * werden kann (z.B. bei statisch gerenderten Content).
 */
export function stripMassMentions(value: string): string {
  return value.replace(/@(everyone|here)/gi, '@\u200B$1');
}
