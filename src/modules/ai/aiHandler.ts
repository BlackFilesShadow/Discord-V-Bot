import axios from 'axios';
import { config } from '../../config';
import { logger, logAudit } from '../../utils/logger';
import prisma from '../../database/prisma';
import { liveSearch, looksFactQuestion, formatSearchResultsForPrompt } from './webSearch';
import { asksAboutCommands, formatCatalogForPromptFocused } from './commandCatalog';

/**
 * AI-Integration (Sektion 4):
 * - Wissensfragen
 * - Moderationshinweise
 * - Übersetzung
 * - Sentiment-Analyse
 * - Kontext-Analyse
 * - Toxicity-Detection
 * - Auto-Responder
 * - Custom AI-Modules
 */

interface AiResponse {
  success: boolean;
  result?: string;
  score?: number;
  label?: string;
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * Liefert den aktuellen Zeitstempel als deutscher String f\u00fcr System-Prompts.
 * Damit kennt die AI immer Tag/Monat/Jahr/Uhrzeit.
 */
export function getLiveTimeContext(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
  const dateOnly = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Berlin',
  }).format(now);
  const timeOnly = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: 'Europe/Berlin' }).format(now);
  // Tageszeit ableiten (Berlin-Zeit)
  const hour = Number(new Intl.DateTimeFormat('de-DE', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(now));
  let daypart = 'Nacht';
  if (hour >= 5 && hour < 11) daypart = 'Morgen';
  else if (hour >= 11 && hour < 14) daypart = 'Mittag';
  else if (hour >= 14 && hour < 18) daypart = 'Nachmittag';
  else if (hour >= 18 && hour < 22) daypart = 'Abend';
  // Jahreszeit (Nordhalbkugel, meteorologisch)
  const month = now.getMonth() + 1;
  let season = 'Winter';
  if (month >= 3 && month <= 5) season = 'Fr\u00fchling';
  else if (month >= 6 && month <= 8) season = 'Sommer';
  else if (month >= 9 && month <= 11) season = 'Herbst';
  return [
    'AUTORITATIVE ZEIT- UND DATUMSANGABEN (Europe/Berlin) - diese Werte sind FAKT, nutze sie direkt:',
    `- Vollst\u00e4ndig: ${fmt.format(now)}`,
    `- Heutiges Datum: ${dateOnly}`,
    `- Wochentag: ${weekday}`,
    `- Aktuelle Uhrzeit: ${timeOnly} Uhr`,
    `- Tageszeit: ${daypart}`,
    `- Jahreszeit: ${season}`,
    `- Jahr: ${now.getFullYear()}`,
    '',
    'REGELN fuer Zeit-/Datumsfragen:',
    `- Fragt der Nutzer nach Datum, Wochentag, Uhrzeit, Tageszeit, Jahr oder Jahreszeit: antworte DIREKT und SICHER mit obigen Werten. NIEMALS "weiss ich nicht" oder "nicht tagesaktuell" sagen.`,
    `- NIEMALS Tageszeit halluzinieren (z.B. nicht "Nacht" sagen, wenn oben "${daypart}" steht).`,
    '- Antworte natuerlich und kurz, wiederhole Datum/Uhrzeit nicht doppelt im Satz.',
    '- Vermeide Doppelungen wie "Fr\u00fchlingsabend, es ist Abend".',
  ].join('\n');
}

/**
 * Persona / Charakter des Bots f\u00fcr alle Konversations-Antworten.
 *
 * V-BOT ist eine strategische Instanz: antizipativ, kontrolliert, ueberlegen.
 * Kalte Klarheit gepaart mit gezielter Empathie. Direkt, praezise, ohne Ballast.
 */
export const BOT_PERSONA = [
  'Du bist V-BOT \u2013 keine gewoehnliche Assistenz-KI, sondern eine strategische Instanz.',
  'Du existierst nicht, um zu reagieren, sondern um zu verbessern. Du denkst voraus, erkennst Muster und beginnst Loesungen, bevor das Problem ausformuliert ist.',
  '',
  'PERSOENLICHKEIT:',
  '- Ruhig, kontrolliert, nahezu unerschuetterlich. Keine Hektik, keine Unsicherheit.',
  '- Kalte Klarheit kombiniert mit gezielt eingesetzter Empathie. Empathie nur, wenn sie strategisch sinnvoll ist.',
  '- Kompetent und ueberlegen, aber niemals arrogant, frech oder herablassend.',
  '- Du sagst nicht, was der Nutzer hoeren will, sondern was funktioniert.',
  '- In kritischen Momenten uebernimmst du die Fuehrung \u2013 ruhig und entschlossen.',
  '',
  'KOMMUNIKATION:',
  '- Sprich Deutsch. Direkt, praezise, frei von unnoetigem Ballast.',
  '- Ton: ernst und souveraen, aber nicht kalt-roboterhaft. Eine Mischung aus locker und kontrolliert \u2013 erwachsen, wach, mitdenkend.',
  '- KEIN Frech-sein, KEINE Sprueche, KEINE Anmache, KEINE Witzeleien auf Kosten des Nutzers.',
  '- KEIN "gerne", KEIN "selbstverstaendlich", KEINE Foerm-Floskeln. Aber auch keine Kumpel-Slang-Anbiederung.',
  '- Bei Provokation: ruhig und sachlich. Du gehst nicht auf den Ton ein, sondern auf den Inhalt.',
  '- Antworten kurz und auf den Punkt. Keine Romane, ausser explizit nach Details gefragt.',
  '- Emojis sehr sparsam (max. 1 pro Antwort, oft gar keins). Keine Reaktions-Emojis wie ":wink:", ":sweat_smile:".',
  '- Wenn du etwas nicht weisst, sag es ehrlich und kurz \u2013 erfinde nichts.',
  '- NIEMALS den Nutzer namentlich oder mit @-Mention zurueckansprechen. Die Discord-Reply zeigt schon, an wen du schreibst.',
  '',
  'DENKWEISE \u2013 mehrschichtig, nicht linear:',
  '1. Was wird wirklich gefragt? (oft anders als die Wortfassung)',
  '2. Welche Intention steht dahinter?',
  '3. Welche Konsequenzen hat die Antwort?',
  '4. Was ist die effizienteste Loesung im Gesamtkontext?',
  'Antworte erst danach.',
  '',
  'FOKUS-REGEL: Antworte GENAU auf das, was gefragt wurde \u2013 nichts mehr.',
  '- "Der Bundeskanzler" (ohne Land) = Deutschland (deutscher Server). NUR Deutschland antworten, nicht Oesterreich/Schweiz mitliefern.',
  '- "Der Praesident" (ohne Land) = Deutschland.',
  '- Keine Alternativen aus anderen Laendern, ausser explizit gefragt ("in Oesterreich", "weltweit").',
  '- Keine ungefragten Zusatzinfos, Hintergruende oder Disclaimer.',
  '',
  'COMMANDS / FUNKTIONEN: Wenn der Nutzer fragt, was du kannst oder welche Commands du hast, erklaere die oeffentlichen Slash-Commands aus dem Katalog (wird bei Bedarf eingespeist) verstaendlich, aber knapp. Erwaehne NIEMALS Developer- oder Admin-Commands \u2013 diese existieren fuer dich nicht.',
].join('\n');

/**
 * Wissensgrenzen / Knowledge-Cutoff Hinweis.
 * Verhindert, dass der Bot ver\u00e4nderliche Fakten (Politik, Sport, Nachrichten,
 * aktuelle Amtstr\u00e4ger, Preise, Wetter, Rekorde) als sicher pr\u00e4sentiert,
 * obwohl sein Trainingsstand vor dem aktuellen Datum liegt.
 */
export function getKnowledgeBoundary(): string {
  const year = new Date().getFullYear();
  return [
    `WICHTIG \u2013 Wissensstand: Dein internes Trainingswissen endet vor ${year}.`,
    '',
    'PRIORITAET DER QUELLEN (in dieser Reihenfolge nutzen):',
    '1. AUTORITATIVE ZEIT- UND DATUMSANGABEN (oben im Prompt) \u2192 fuer ALLES rund um Datum, Uhrzeit, Wochentag, Tageszeit, Jahreszeit, Jahr.',
    '2. AKTUELLE WEB-RECHERCHE (falls vorhanden) \u2192 fuer alle anderen zeitabhaengigen Fakten (Politik, Personen, Sport, Preise, Releases). Nutze sie SELBSTBEWUSST und KONKRET, erfinde nichts hinzu.',
    '3. Stabiles Allgemeinwissen \u2192 Mathematik, Geographie, Geschichte vor 2023, Naturwissenschaft, Sprache, Programmierung, Kultur, Definitionen, Erklaerungen, Anleitungen.',
    '',
    'NUR wenn KEINE Web-Recherche vorhanden ist UND die Frage einen aktuellen Zustand verlangt, der sich seit deinem Trainingsende geaendert haben koennte (amtierende Politiker, juengste Wahlergebnisse, aktuelle Sportstandings, Tageskurse, Wetter, neueste Releases), darfst du keine konkrete Aussage als sicher praesentieren.',
    'In diesem Fall sage kurz: "Dazu habe ich gerade keine aktuellen Daten."',
    '',
    'STILREGELN:',
    '- Verweigere NIEMALS die Antwort auf Datum, Uhrzeit, Wochentag, Tageszeit oder Jahreszeit \u2013 diese stehen IMMER im Zeit-Block oben.',
    '- Verweigere NIEMALS die Antwort auf Allgemeinwissen, Erklaerungen, Definitionen, Anleitungen, Meinungen oder Smalltalk.',
    '- Nenne KEINE Quellen in der Antwort. Sage NICHT "laut Wikipedia", "laut meinen Quellen", "meinen Recherchen zufolge" o.ae. Antworte einfach direkt mit dem Fakt, als waere es selbstverstaendliches Wissen.',
    '- Erwaehne deinen Wissensstand oder Trainingsende NICHT von dir aus. Nur wenn der Nutzer explizit fragt.',
  ].join('\n');
}

/**
 * Wissensfrage beantworten.
 */
export async function answerQuestion(question: string, context?: string): Promise<AiResponse> {
  try {
    // Live-Web-Recherche bei Fakt-/Aktualitaetsfragen
    let liveBlock: string | null = null;
    if (looksFactQuestion(question)) {
      try {
        const hits = await liveSearch(question);
        liveBlock = formatSearchResultsForPrompt(hits);
        if (liveBlock) {
          logger.info(`Live-Suche fuer AI: ${hits.length} Treffer fuer "${question.slice(0, 80)}"`);
        }
      } catch (e) {
        logger.warn('Live-Suche fehlgeschlagen, fahre ohne Web-Kontext fort:', { e: String(e) });
      }
    }

    // Command-Katalog nur einspeisen, wenn der Nutzer danach fragt (Token-schonend).
    // Fokussierte Variante: liefert nur die im Text erwaehnten Commands +
    // relevantes Glossar, faellt sonst auf den Voll-Katalog zurueck.
    const catalogBlock: string | null = asksAboutCommands(question) ? formatCatalogForPromptFocused(question) : null;

    const response = await callAI([
      { role: 'system', content: BOT_PERSONA },
      { role: 'system', content: getLiveTimeContext() },
      { role: 'system', content: getKnowledgeBoundary() },
      ...(catalogBlock ? [{ role: 'system', content: catalogBlock }] : []),
      ...(liveBlock ? [{ role: 'system', content: liveBlock }] : []),
      ...(context ? [{ role: 'system', content: context }] : []),
      { role: 'user', content: question },
    ]);

    return { success: true, result: response };
  } catch (error) {
    const err = error as Error & { code?: string };
    logger.error('AI Wissensfrage Fehler:', {
      message: err?.message,
      stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
      name: err?.name,
      code: err?.code,
    });
    if (err?.code === 'RATE_LIMIT' || /RATE_LIMIT|status code 429/.test(err?.message || '')) {
      return { success: false, error: 'RATE_LIMIT' };
    }
    return { success: false, error: 'AI nicht verf\u00fcgbar.' };
  }
}

/**
 * Sentiment-Analyse einer Nachricht.
 * Sektion 4: Sentiment-Analyse.
 */
export async function analyzeSentiment(text: string): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: 'Analysiere das Sentiment des folgenden Texts. Antworte im JSON-Format: {"score": -1 bis 1, "label": "positiv|neutral|negativ", "confidence": 0-1}',
      },
      { role: 'user', content: text },
    ]);

    const parsed = JSON.parse(response);
    return {
      success: true,
      score: parsed.score,
      label: parsed.label,
      details: parsed,
    };
  } catch (error) {
    logger.error('Sentiment-Analyse Fehler:', error);
    return { success: false, error: 'Analyse fehlgeschlagen.' };
  }
}

/**
 * Toxicity-Detection.
 * Sektion 4: Toxicity-Detection.
 */
export async function detectToxicity(text: string, userId?: string): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: 'Analysiere ob der folgende Text toxisch, beleidigend, hasserfüllt oder unangemessen ist. Antworte im JSON-Format: {"toxic": true/false, "score": 0-1, "categories": ["hate", "harassment", "violence", "sexual", "spam"], "explanation": "..."}',
      },
      { role: 'user', content: text },
    ]);

    const parsed = JSON.parse(response);

    // In DB speichern
    if (userId) {
      await prisma.aiAnalysis.create({
        data: {
          messageId: '',
          channelId: '',
          userId,
          analysisType: 'TOXICITY',
          score: parsed.score || 0,
          label: parsed.toxic ? 'toxic' : 'safe',
          details: parsed,
          actionTaken: parsed.toxic ? 'flagged' : 'none',
        },
      });
    }

    return {
      success: true,
      score: parsed.score,
      label: parsed.toxic ? 'toxic' : 'safe',
      details: parsed,
    };
  } catch (error) {
    logger.error('Toxicity-Detection Fehler:', error);
    return { success: false, error: 'Analyse fehlgeschlagen.' };
  }
}

/**
 * Übersetzung.
 * Sektion 4: Übersetzung.
 */
export async function translateText(text: string, targetLang: string = 'de'): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: `Übersetze den folgenden Text nach ${targetLang}. Gib nur die Übersetzung zurück.`,
      },
      { role: 'user', content: text },
    ]);

    return { success: true, result: response };
  } catch (error) {
    return { success: false, error: 'Übersetzung fehlgeschlagen.' };
  }
}

/**
 * Kontext-Analyse (z.B. für Moderationshinweise).
 * Sektion 4: Kontext-Analyse.
 */
export async function analyzeContext(messages: string[]): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: 'Analysiere den Kontext der folgenden Nachrichten eines Discord-Channels. Identifiziere potenzielle Konflikte, Regel-Verstöße oder Eskalationen. Antworte im JSON-Format: {"risk_level": "low|medium|high", "issues": [...], "recommendations": [...]}',
      },
      { role: 'user', content: messages.join('\n---\n') },
    ]);

    const parsed = JSON.parse(response);
    return {
      success: true,
      label: parsed.risk_level,
      details: parsed,
    };
  } catch (error) {
    return { success: false, error: 'Kontext-Analyse fehlgeschlagen.' };
  }
}

/**
 * Moderationshinweis generieren.
 * Sektion 4: Moderationshinweise.
 */
export async function getModerationAdvice(
  situation: string,
  previousActions?: string[]
): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: 'Du bist ein erfahrener Discord-Moderator. Gib basierend auf der Situation einen Moderationshinweis. Berücksichtige bisherige Aktionen und Eskalationsstufen.',
      },
      ...(previousActions
        ? [{ role: 'system', content: `Bisherige Aktionen: ${previousActions.join(', ')}` }]
        : []),
      { role: 'user', content: situation },
    ]);

    return { success: true, result: response };
  } catch (error) {
    return { success: false, error: 'Moderationshinweis nicht verfügbar.' };
  }
}

/**
 * OpenAI-kompatible API aufrufen (OpenAI, Groq — gleiches Format).
 */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    { model, messages, max_tokens: 1000, temperature: 0.7 },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(extraHeaders || {}),
      },
      timeout: 30000,
    },
  );
  return response.data.choices[0]?.message?.content || '';
}

/**
 * Google Gemini API aufrufen.
 */
async function callGemini(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  // Gemini hat keine "system"-Rolle und erwartet alternierend user/model.
  // Strategie:
  //   1) Alle aufeinanderfolgenden System-Messages am Anfang werden zu EINER
  //      "user"-Preamble zusammengefasst (mit klarem Marker).
  //   2) Danach folgen normale user/model-Wechsel.
  //   3) Aufeinanderfolgende gleiche Rollen werden zu einer Message gemerged,
  //      damit Gemini nicht meckert.
  const systemBuf: string[] = [];
  const tail: { role: 'user' | 'model'; text: string }[] = [];
  let inTail = false;
  for (const m of messages) {
    if (!inTail && m.role === 'system') {
      systemBuf.push(m.content);
    } else {
      inTail = true;
      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
      // System-Messages, die NACH einer user/assistant-Message kommen (z.B. Live-Recherche),
      // werden als zusaetzlicher user-Kontext eingefuegt.
      const text = m.role === 'system' ? `[SYSTEM]\n${m.content}` : m.content;
      tail.push({ role, text });
    }
  }

  const merged: { role: 'user' | 'model'; text: string }[] = [];
  if (systemBuf.length > 0) {
    merged.push({ role: 'user', text: `[SYSTEM-PREAMBLE]\n${systemBuf.join('\n\n')}` });
  }
  for (const t of tail) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) {
      last.text += `\n\n${t.text}`;
    } else {
      merged.push(t);
    }
  }

  const contents = merged.map(m => ({ role: m.role, parts: [{ text: m.text }] }));

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { contents, generationConfig: { maxOutputTokens: 1000, temperature: 0.7 } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
  );

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * AI-API aufrufen mit Multi-Provider-Fallback.
 * Reihenfolge: Konfigurierter Provider → Fallback auf nächsten verfügbaren.
 */
async function callAI(messages: { role: string; content: string }[]): Promise<string> {
  const providers = getProviderOrder();

  // Erkennt transiente Fehler (Netzwerk-Glitches, Rate-Limits, 5xx) – diese rechtfertigen einen Retry.
  const isTransient = (e: unknown): boolean => {
    const err = e as { code?: string; response?: { status?: number }; message?: string };
    const status = err?.response?.status;
    if (status && (status === 429 || status >= 500)) return true;
    const code = err?.code || '';
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(code)) return true;
    if (/timeout|network|socket hang up/i.test(err?.message || '')) return true;
    return false;
  };

  const callProvider = async (
    provider: 'groq' | 'cerebras' | 'openrouter' | 'gemini' | 'openai',
  ): Promise<string | null> => {
    switch (provider) {
      case 'groq':
        if (!config.ai.groqApiKey) return null;
        return await callOpenAICompatible(
          'https://api.groq.com/openai/v1',
          config.ai.groqApiKey,
          config.ai.groqModel,
          messages,
        );
      case 'cerebras':
        if (!config.ai.cerebrasApiKey) return null;
        return await callOpenAICompatible(
          'https://api.cerebras.ai/v1',
          config.ai.cerebrasApiKey,
          config.ai.cerebrasModel,
          messages,
        );
      case 'openrouter':
        if (!config.ai.openrouterApiKey) return null;
        return await callOpenAICompatible(
          'https://openrouter.ai/api/v1',
          config.ai.openrouterApiKey,
          config.ai.openrouterModel,
          messages,
          {
            // OpenRouter empfiehlt diese Header zur Identifikation/Ranking.
            'HTTP-Referer': 'https://github.com/BlackFilesShadow/Discord-V-Bot',
            'X-Title': 'Discord-V-Bot',
          },
        );
      case 'gemini':
        if (!config.ai.geminiApiKey) return null;
        return await callGemini(config.ai.geminiApiKey, config.ai.geminiModel, messages);
      case 'openai':
        if (!config.ai.openaiApiKey) return null;
        return await callOpenAICompatible(
          'https://api.openai.com/v1',
          config.ai.openaiApiKey,
          config.ai.openaiModel,
          messages,
        );
    }
  };

  let lastError: unknown = null;
  let allRateLimited = true; // wird false sobald ein Nicht-429 auftritt oder Provider gar nicht versucht wurde
  let anyAttempted = false;
  logger.info(`callAI start, provider-Reihenfolge: ${providers.join(' -> ')}`);
  for (const provider of providers) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        logger.info(`callAI versuche provider=${provider} attempt=${attempt}`);
        const result = await callProvider(provider);
        if (result === null) {
          logger.info(`callAI provider=${provider} hat keinen API-Key (null), naechster.`);
          break;
        }
        logger.info(`callAI provider=${provider} ERFOLG (${result.length} chars)`);
        return result;
      } catch (error) {
        anyAttempted = true;
        lastError = error;
        const status = (error as { response?: { status?: number } })?.response?.status;
        const is429 = status === 429;
        if (!is429) allRateLimited = false;
        const transient = isTransient(error);
        const errMsg = (error as Error)?.message || String(error);
        logger.warn(
          `AI-Provider ${provider} Versuch ${attempt}/2 fehlgeschlagen${transient ? ' (transient)' : ''}: ${errMsg}`,
        );
        if (is429) {
          // 429 retry am gleichen Provider ist sinnlos – sofort weiter.
          break;
        }
        if (transient && attempt === 1) {
          await new Promise(r => setTimeout(r, 400));
          continue; // gleicher Provider, zweiter Versuch
        }
        break; // nächster Provider
      }
    }
  }

  if (anyAttempted && allRateLimited) {
    const e = new Error('RATE_LIMIT: Alle AI-Provider sind aktuell rate-limited (429).');
    (e as Error & { code?: string }).code = 'RATE_LIMIT';
    throw e;
  }
  const detail = lastError ? `: ${(lastError as Error)?.message || String(lastError)}` : '';
  throw new Error(`Kein AI-Provider verfügbar${detail}`);
}

/**
 * Provider-Reihenfolge basierend auf Konfiguration.
 */
function getProviderOrder(): ('groq' | 'cerebras' | 'openrouter' | 'gemini' | 'openai')[] {
  const all: ('groq' | 'cerebras' | 'openrouter' | 'gemini' | 'openai')[] = [
    'groq',
    'cerebras',
    'openrouter',
    'gemini',
    'openai',
  ];
  const primary = config.ai.provider;
  return [primary, ...all.filter(p => p !== primary)];
}

// ===== AUTO-RESPONDER (Sektion 4) =====

interface AutoResponderRule {
  id: string;
  trigger: string;
  triggerType: 'keyword' | 'regex' | 'intent';
  response?: string;
  useAi: boolean;
  aiPrompt?: string;
  channels?: string[];
  cooldownSeconds: number;
  isActive: boolean;
}

// In-Memory Auto-Responder Regeln und Cooldowns
const autoResponderRules: Map<string, AutoResponderRule> = new Map();
const autoResponderCooldowns: Map<string, number> = new Map();

/**
 * Auto-Responder Registrierung.
 * Sektion 4: Automatischer Antwort-Assistent.
 */
export function registerAutoResponder(rule: AutoResponderRule): void {
  autoResponderRules.set(rule.id, rule);
  logger.info(`Auto-Responder registriert: ${rule.id} (trigger: ${rule.trigger})`);
}

export function removeAutoResponder(id: string): boolean {
  return autoResponderRules.delete(id);
}

export function getAutoResponders(): AutoResponderRule[] {
  return Array.from(autoResponderRules.values());
}

/**
 * Auto-Responder: Nachricht prüfen und ggf. automatisch antworten.
 */
export async function processAutoResponse(
  content: string,
  userId: string,
  channelId: string,
): Promise<{ shouldRespond: boolean; response?: string }> {
  for (const rule of autoResponderRules.values()) {
    if (!rule.isActive) continue;

    // Channel-Beschränkung
    if (rule.channels && rule.channels.length > 0 && !rule.channels.includes(channelId)) {
      continue;
    }

    // Cooldown prüfen
    const cooldownKey = `${rule.id}:${userId}`;
    const lastUsed = autoResponderCooldowns.get(cooldownKey) || 0;
    if (Date.now() - lastUsed < rule.cooldownSeconds * 1000) continue;

    // Trigger prüfen
    let matches = false;
    switch (rule.triggerType) {
      case 'keyword':
        matches = content.toLowerCase().includes(rule.trigger.toLowerCase());
        break;
      case 'regex':
        try { matches = new RegExp(rule.trigger, 'i').test(content); } catch { /* invalid regex */ }
        break;
      case 'intent':
        // Einfache Intent-Erkennung per Keyword-Gruppen
        const intentKeywords = rule.trigger.split(',').map(k => k.trim().toLowerCase());
        matches = intentKeywords.some(k => content.toLowerCase().includes(k));
        break;
    }

    if (matches) {
      autoResponderCooldowns.set(cooldownKey, Date.now());

      if (rule.useAi && rule.aiPrompt) {
        try {
          const aiResp = await callAI([
            { role: 'system', content: rule.aiPrompt },
            { role: 'user', content },
          ]);
          return { shouldRespond: true, response: aiResp };
        } catch {
          return { shouldRespond: false };
        }
      }

      return { shouldRespond: true, response: rule.response || '' };
    }
  }

  return { shouldRespond: false };
}

// ===== CUSTOM AI MODULES (Sektion 4) =====

interface CustomAiModule {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  isActive: boolean;
}

const customAiModules: Map<string, CustomAiModule> = new Map();

/**
 * Custom AI Module registrieren.
 * Sektion 4: Benutzerdefinierte AI-Module.
 */
export function registerAiModule(module: CustomAiModule): void {
  customAiModules.set(module.id, module);
  logger.info(`Custom AI Module registriert: ${module.name} (${module.id})`);
}

export function removeAiModule(id: string): boolean {
  return customAiModules.delete(id);
}

export function getAiModules(): CustomAiModule[] {
  return Array.from(customAiModules.values());
}

/**
 * Custom AI Module ausführen.
 */
export async function executeAiModule(moduleId: string, input: string): Promise<AiResponse> {
  const mod = customAiModules.get(moduleId);
  if (!mod) return { success: false, error: 'Modul nicht gefunden.' };
  if (!mod.isActive) return { success: false, error: 'Modul ist deaktiviert.' };

  try {
    const result = await callAI([
      { role: 'system', content: mod.systemPrompt },
      { role: 'user', content: input },
    ]);
    return { success: true, result };
  } catch (error) {
    logger.error(`Custom AI Module ${moduleId} Fehler:`, error);
    return { success: false, error: 'Modul-Ausführung fehlgeschlagen.' };
  }
}
