import { logger } from '../../utils/logger';
import { callAI } from './aiHandler';

/**
 * Phase 17: Translation-Service.
 *
 * Nutzt das vorhandene AI-Provider-Routing (callAI mit Multi-Provider-Fallback).
 * Liefert reine Uebersetzung ohne Erlaeuterungen, Anfuehrungszeichen oder
 * Markdown-Wrapping.
 */

export interface SupportedLanguage {
  code: string;
  name: string;
  emoji: string;
}

// Fest definierte Pflicht-Sprachen + 5 weitere (Phase 17 Spec).
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'de', name: 'Deutsch',     emoji: '🇩🇪' },
  { code: 'en', name: 'English',     emoji: '🇬🇧' },
  { code: 'fr', name: 'Francais',    emoji: '🇫🇷' },
  { code: 'ar', name: 'Arabisch',    emoji: '🇸🇦' },
  { code: 'ko', name: 'Koreanisch',  emoji: '🇰🇷' },
  // Zusatz: Spanisch, Italienisch, Portugiesisch, Russisch, Tuerkisch.
  { code: 'es', name: 'Spanisch',    emoji: '🇪🇸' },
  { code: 'it', name: 'Italienisch', emoji: '🇮🇹' },
  { code: 'pt', name: 'Portugiesisch', emoji: '🇵🇹' },
  { code: 'ru', name: 'Russisch',    emoji: '🇷🇺' },
  { code: 'tr', name: 'Tuerkisch',   emoji: '🇹🇷' },
];

export const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);

export function getLanguageName(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/**
 * Uebersetzt Text mittels callAI. Gibt bei Fehler null zurueck (Aufrufer
 * entscheidet, ob Fallback auf Quelltext gewuenscht ist).
 */
export async function translate(text: string, targetCode: string, sourceCode?: string): Promise<string | null> {
  const target = getLanguageName(targetCode);
  const source = sourceCode ? getLanguageName(sourceCode) : 'auto-detect';
  const sys = [
    `Du bist ein professioneller Uebersetzer. Uebersetze den folgenden Text NACH ${target}.`,
    sourceCode ? `Quellsprache: ${source}.` : 'Erkenne die Quellsprache automatisch.',
    'WICHTIG:',
    '- Liefere AUSSCHLIESSLICH die Uebersetzung, keine Erklaerungen.',
    '- Keine Anfuehrungszeichen, kein Code-Block, keine Markdown-Formatierung.',
    '- Behalte Discord-Mentions <@123>, <@&123>, <#123> sowie Custom-Emotes <:name:123> exakt bei.',
    '- Behalte Newlines bei.',
    '- Falls der Text bereits in der Zielsprache ist, gib ihn unveraendert zurueck.',
  ].join('\n');
  try {
    const out = await callAI([
      { role: 'system', content: sys },
      { role: 'user', content: text },
    ]);
    const cleaned = out.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^```[a-z]*\s*|\s*```$/gi, '');
    return cleaned || null;
  } catch (e) {
    logger.warn(`translate fehlgeschlagen (${targetCode}): ${String(e)}`);
    return null;
  }
}
