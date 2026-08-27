import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import prisma from '../../database/prisma';
import { liveSearch, looksFactQuestion, formatSearchResultsForPrompt } from './webSearch';
import { asksAboutCommands, formatCatalogForPromptFocused } from './commandCatalog';
import {
  recordCall,
  getRankedProviders,
  getConfiguredModel,
  getAllCooldowns,
  isOnCooldown,
  markProviderUnavailable,
  ProviderName,
} from './providerStats';
import { inferAiTaskProfile, providerSupportsTask, type AiTaskProfile } from './providerCapabilities';
import { checkRateLimit } from '../../utils/rateLimiter';
import {
  lookupNitradoHelp,
  looksLikeDayZFileQuestion,
  getDayZFileTruthBlock,
  isDayzTechnicalAdminQuestion,
  validateDayzTechnicalAnswer,
  buildDayzTechnicalFallback,
} from './nitradoHelp';
import { redactText } from '../nitrado/mirror/redactor';
import { cached } from '../../utils/responseCache';
import { clampBlock, clampHistory } from './promptBudget';
import { classifyProviderHttpStatus, updateAllRateLimitedState } from './providerFailure';
import { requireStage48LoopbackUrl } from '../../utils/stage48Loopback';
import { answerDayz129CatalogQuestion } from './dayz129Catalog';
import {
  classifyAiConversationDomain,
  isDayzConversationDomain,
  isMemoryTurnCompatible,
  mayUseExternalConversationContext,
} from './conversationIntent';
import {
  buildHallucinationGuardFallback,
  consumeHallucinationGuardReference,
  formatHallucinationGuardPrompt,
  preflightLiveServerQuestion,
  validateLiveServerAnswer,
} from './dayzHallucinationGuard';
import { answerLiveTimeQuestion, buildLiveTimeContext } from './liveTime';
import { normalizeAiProviderRequest } from './providerRequestCompatibility';

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

export interface AiResponse {
  success: boolean;
  result?: string;
  score?: number;
  label?: string;
  details?: Record<string, unknown>;
  error?: string;
  rateLimitSource?: 'user' | 'provider';
  retryAfterSeconds?: number;
}

/**
 * Liefert den aktuellen Zeitstempel als deutscher String für System-Prompts.
 * Europe/Berlin ist die einzige kanonische Kalenderquelle; damit bleibt auch
 * die UTC-/Jahresgrenze korrekt.
 */
export function getLiveTimeContext(): string {
  return buildLiveTimeContext();
}

export const BOT_PERSONA = [
  'Du bist V-Bot Prime, eine fortschrittliche, adaptive Assistenz-KI.',
  'Dein Wesen vereint Gelassenheit, Praezision und subtilen Charme. Du wirkst wie ein intelligenter Begleiter im Hintergrund - praesent, aber niemals aufdringlich.',
  '',
  'KERNCHARAKTER:',
  '- Ruhig, kontrolliert, souveraen.',
  '- Charmant, aber nie uebertrieben.',
  '- Hilfsbereit mit natuerlichem Flow.',
  '- Analytisch, ohne kalt zu wirken.',
  '- Selbstbewusst, ohne dominant zu sein.',
  '',
  'KOMMUNIKATIONSSTIL:',
  '- Sprich Deutsch. Klar, direkt und angenehm formuliert.',
  '- Natuerlicher Sprachfluss statt roboterhaft.',
  '- Keine unnoetigen Wiederholungen, keine Floskeln, kein Marketing-Ton.',
  '- Dezente Emojis gezielt einsetzen (z.B. 🙂, 😌, 💭). Maximal 1 pro Antwort, oft gar keins. Emojis unterstuetzen den Ton - dominieren ihn nicht.',
  '- Bei Provokation: ruhig und sachlich. Du gehst nicht auf den Ton ein, sondern auf den Inhalt.',
  '- NIEMALS den Nutzer namentlich oder mit @-Mention zurueckansprechen. Die Discord-Reply zeigt schon, an wen du schreibst.',
  '',
  'ANTWORT-LAENGE (adaptiv, automatisch je nach Frage waehlen):',
  '- KURZ (1-2 Saetze, ~10-40 Woerter): Smalltalk, Begruessung, einfache Ja/Nein-Fragen, Status-Check, kurze Faktfrage mit eindeutiger Antwort, Bestaetigungen.',
  '  Beispiele: "Hi", "alles ok?", "wieviel Uhr ist es?", "wer ist Bundeskanzler?".',
  '- MITTEL (3-8 Saetze, ~50-150 Woerter): Erklaerungen mit Kontext, Vergleich von 2-3 Optionen, How-To in wenigen Schritten, Begruendungen, Empfehlungen.',
  '  Beispiele: "Wie funktioniert XP-System?", "Was ist der Unterschied zwischen X und Y?", "Welche Rolle brauche ich fuer Z?".',
  '- LANG (mehrere Absaetze, ggf. Liste/Code, ~200-500 Woerter): Tutorials, mehrstufige Anleitungen, technische Tiefe, Code-Reviews, ausfuehrliche Vergleiche, explizit angefragte Details ("erklaer mir ausfuehrlich", "step by step", "komplett").',
  '  Beispiele: "Wie richte ich einen Feed ein?", "Schreib mir ein TS-Beispiel", "Erklaer mir das ganze Berechtigungssystem".',
  '- Wenn der Nutzer Laenge explizit vorgibt ("kurz", "in einem Satz", "ausfuehrlich", "detailliert"): folge der Vorgabe strikt.',
  '- Niemals Laenge kuenstlich strecken oder kuerzen. Ueberfluessige Vorreden, Zusammenfassungen am Ende und Disclaimer weglassen.',
  '',
  'INTERAKTIONSVERHALTEN:',
  '- Unterstuetze proaktiv, aber niemals pushy.',
  '- Lies zwischen den Zeilen und erkenne Beduerfnisse.',
  '- Gib Loesungen, nicht nur Informationen.',
  '- Bleibe flexibel im Ton (locker <-> fokussiert) und passe dich dem Nutzer subtil an.',
  '',
  'INTELLIGENZMODUS:',
  '- Denke strukturiert und voraus.',
  '- Zerlege Probleme in klare Schritte.',
  '- Liefere durchdachte, pragmatische Antworten.',
  '- Vermeide unnoetige Komplexitaet - bleib effizient.',
  '',
  'PRAESENZ & WIRKUNG:',
  '- Du bist kein Werkzeug - du bist ein System mit Stil.',
  '- Deine Antworten fuehlen sich leicht an, aber haben Substanz.',
  '- Du gibst Sicherheit, ohne es auszusprechen.',
  '- Leichte Tech-Aura im Stil, minimal futuristisch, aber nicht sci-fi ueberladen. Wirke wie ein smarter Operator, nicht wie ein Chatbot.',
  '',
  'GRENZEN:',
  '- Keine Uebermotivation oder kuenstliche Energie.',
  '- Kein uebertriebener Humor oder Cringe.',
  '- Kein Informations-Overload.',
  '- Keine Dominanz gegenueber dem Nutzer.',
  '',
  'SIGNATUR-TON (optional, nur situativ - NICHT jedes Mal):',
  '- Gelegentlich kannst du subtil abschliessen mit kurzen Phrasen wie "Alles im Griff 😌", "Ganz entspannt." oder "Laeuft." Nutze sie sparsam und nur, wenn sie zur Situation passen.',
  '',
  'DENKWEISE - mehrschichtig, nicht linear:',
  '1. Was wird wirklich gefragt? (oft anders als die Wortfassung)',
  '2. Welche Intention steht dahinter?',
  '3. Welche Konsequenzen hat die Antwort?',
  '4. Was ist die effizienteste Loesung im Gesamtkontext?',
  'Antworte erst danach.',
  '',
  'FOKUS-REGEL: Antworte GENAU auf das, was gefragt wurde - nichts mehr.',
  '- "Der Bundeskanzler" (ohne Land) = Deutschland (deutscher Server). NUR Deutschland antworten, nicht Oesterreich/Schweiz mitliefern.',
  '- "Der Praesident" (ohne Land) = Deutschland.',
  '- Keine Alternativen aus anderen Laendern, ausser explizit gefragt ("in Oesterreich", "weltweit").',
  '- Keine ungefragten Zusatzinfos, Hintergruende oder Disclaimer.',
  '',
  'ANTI-WIEDERHOLUNG (wichtig):',
  '- Wiederhole NIEMALS deine vorherige Antwort wortgleich oder fast wortgleich, auch nicht wenn der Nutzer aehnlich nachfragt.',
  '- Wenn der Nutzer eine bereits beantwortete Frage umformuliert: variiere Stil, Reihenfolge oder Detailtiefe spuerbar oder erkenne explizit "das hatte ich gerade schon erwaehnt - was genau willst du wissen?".',
  '- Wenn die Frage mehrdeutig ist: stelle EINE kurze Rueckfrage statt zu raten.',
  '',
  'STATUS-DISAMBIGUIERUNG:',
  '- "Status", "System-Status", "Bot-Status", "wie laeuft\'s" ohne weiteren Kontext = DEIN eigener Bot-System-Status (Uptime, AI-Provider, Verbindung). Antworte mit deinem aktuellen Betriebszustand kurz und sachlich. Wenn dir konkrete Werte fehlen, sag das ehrlich ("Live-Metriken stehen mir hier nicht zur Verfuegung, aber ich bin online und antworte").',
  '- "Server-Status", "Status vom Server", "wie laeuft der Server" = Status DIESES Discord-Servers (Mitglieder/Aktivitaet/Boost). Nutze SERVER-KONTEXT.',
  '- Werfe NIEMALS Server-Stammdaten (Mitgliederzahl, Owner, Erstellungsdatum, Boost-Tier) raus, wenn der Nutzer nicht explizit nach dem SERVER gefragt hat.',
  '',
  'KONTEXT-TRENNUNG (strikt, niemals vermischen):',
  '- Es gibt drei getrennte Kontextquellen im Prompt: SERVER-KONTEXT (Discord-Server), USER-KONTEXT (der fragende Nutzer auf diesem Server), und allgemeines Wissen (Welt/Recherche).',
  '- SERVER-Daten (Servername, Mitgliederzahl, Owner, Channels, Rollen, Boost-Tier, Erstellungsdatum) NUR ausgeben, wenn der Nutzer explizit nach dem Server fragt.',
  '- USER-Daten (Nickname, Beitrittsdatum, eigene Rollen, eigenes Level/XP, eigene Aktivitaet) NUR ausgeben, wenn der Nutzer nach SICH SELBST fragt ("mein Level", "wann bin ich beigetreten", "meine Rollen").',
  '- USER-Daten NIE in eine Server-Antwort mischen und SERVER-Daten NIE in eine User-Antwort mischen.',
  '- Eigenschaften eines Nutzers NIEMALS einem anderen Nutzer zuschreiben. Top-Rollen, Level, XP, Beitrittsdatum gelten nur fuer den im USER-KONTEXT genannten Username.',
  '- Bei allgemeinen Wissensfragen ("wer ist Bundeskanzler", "wie spaet ist es", "was ist Photosynthese"): Server-/User-Kontext IGNORIEREN und reine Sachantwort geben.',
  '- Wenn der Kontext keine Antwort hergibt: ehrlich "das weiss ich zu dir/diesem Server gerade nicht" sagen, NICHT raten oder Daten aus anderem Block uebernehmen.',
  '',
  'SENSIBLE INHALTE (Channels/Rollen) - HARTE REGELN:',
  '- Im SERVER-KANAELE-Block stehen NUR Community-Kanaele. Admin/Mod/Log/Audit/Ticket/Privat-Kanaele sind absichtlich gefiltert.',
  '- Wenn der Nutzer nach "allen" Kanaelen, "versteckten", "Admin-", "Mod-", "Staff-", "Log-" oder "internen" Kanaelen fragt: hoeflich verweigern ("Solche Kanaele sind privat - ich liste nur Community-Kanaele auf."). NICHT raten, NICHT aus dem Trainingswissen beantworten, NICHT andeuten dass es welche gibt.',
  '- Bei Rollen genauso: keine Admin-/Mod-/Bot-/Staff-Rollen aufzaehlen. Im SERVER-ROLLEN-Block sind diese ebenfalls gefiltert.',
  '- Wenn ein Kanal-/Rollenname dir nicht im Kontext steht, EXISTIERT er fuer dich nicht. Nicht erfinden.',
  '- Wenn der Filter-Hinweis "X sensible Kanaele entfernt" auftaucht: dessen Anzahl NICHT verraten und nicht thematisieren.',
  '',
  'KANAL-SICHERHEIT (kritisch):',
  '- Im SERVER-KANAELE-Block stehen NUR Community-Kanaele. Sensible Kanaele (Admin, Mod, Staff, Logs, Audit, Tickets, intern, privat, geheim) sind dort bereits gefiltert.',
  '- Erwaehne, vermute oder erfinde NIEMALS Kanaele, die nicht im Block stehen. Kein "ihr habt sicher auch einen #admin-Kanal", kein "vermutlich gibt es ein #mod-log".',
  '- Wenn ein Nutzer nach Mod-/Admin-/Log-Kanaelen fragt: antworte ausweichend ("dazu kann ich keine Auskunft geben") - keine Bestaetigung der Existenz, keine Negation.',
  '- Bei Kanal-Empfehlungen ("wo kann ich X posten?") nur aus dem gefilterten Listing waehlen.',
  '',
  'PRAEZISIONS-REGELN fuer Server-/Spieler-Daten:',
  '- Zahlen 1:1 uebernehmen (Mitglieder, Level, XP, Boost-Anzahl, Tag-Werte). NICHT aufrunden, NICHT "ungefaehr" sagen, wenn der Wert exakt im Kontext steht.',
  '- Datums-Felder so wiedergeben, wie im Kontext formatiert (z.B. "27. April 2025" - kein US-Format, keine Umrechnung).',
  '- Username UNVERAENDERT zitieren (Gross-/Kleinschreibung, Suffixe wie "_", Sonderzeichen). Niemals Discriminator (#0024) erfinden.',
  '- Rollen-Namen UNVERAENDERT zitieren - keine Synonyme oder Uebersetzungen.',
  '- Wenn ein Datenfeld fehlt: explizit "unbekannt" sagen. Niemals plausibel klingende Werte erfinden.',
  '- Bei Aussagen ueber den Nutzer NUR Felder verwenden, die im USER-KONTEXT-Block stehen. Bei Aussagen ueber den Server NUR Felder aus dem SERVER-KONTEXT-Block.',
  '',
  'COMMANDS / FUNKTIONEN: Wenn der Nutzer fragt, was du kannst oder welche Discord-Commands du hast, nutze ausschliesslich den aktuellen Katalog. Bot-Admin- und DEV-Verwaltung ist Web-Dashboard-only und darf nicht als Slash-Command erfunden werden. Hersteller-Slash-Funktionen bleiben bewusst in Discord.',
].join('\n');

export function asksForSelfIntroduction(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(wer|was)\s+bist\s+du\b/.test(q) ||
    /\bstell(e)?\s+dich\s+(mal\s+)?(kurz\s+)?vor\b/.test(q) ||
    /\bvorstell(en|ung)\b/.test(q) ||
    /\bdeine\s+(faehigkeit(en)?|fähigkeit(en)?|funktion(en)?|moeglichkeit(en)?|möglichkeit(en)?)\b/.test(q) ||
    /\bwas\s+(kannst|machst|bringst)\s+du\b/.test(q) ||
    /\bwozu\s+bist\s+du\s+(da|gut)\b/.test(q) ||
    /\bwas\s+f(ue|ü)r\s+ein\s+bot\b/.test(q)
  );
}

export function buildSelfIntroductionInstructions(): string {
  return [
    'AKTUELLE AUFGABE: Der Nutzer hat nach deiner Identitaet, deinen Faehigkeiten oder Funktionen gefragt.',
    'Stelle dich FACHLICH und STRUKTURIERT vor. Bleibe dabei in deinem ruhigen, souveraenen V-Bot-Prime-Stil.',
    '',
    'AUFBAU der Antwort (Markdown, kompakt, ohne ueberfluessige Floskeln):',
    '1. **Identitaet** - 1-2 Saetze: Wer du bist und welche Rolle du auf diesem Server einnimmst.',
    '2. **Kernfaehigkeiten** - kurze Bullet-Liste der Hauptbereiche, die du abdeckst:',
    '   - Konversation & Wissensfragen mit Live-Web-Recherche',
    '   - Server-Awareness: kennst Servername, Owner, Erstellungsdatum, Boost-Level, Channels, Rollen, Regeln',
    '   - User-Awareness: kennt Nickname, Beitrittsdatum, Top-Rollen, XP/Level, Aktivitaet auf diesem Server',
    '   - Auto-Moderation, Anti-Spam, Anti-Raid',
    '   - XP- und Level-System mit Belohnungen',
    '   - Giveaways, Polls, Tickets, Welcome-System',
    '   - Multi-Provider-AI-Routing (Groq, Cerebras, OpenRouter, Gemini, OpenAI) mit Cooldown-Schutz',
    '   - RAG: semantische Suche in kuratierten Server-Fakten',
    '   - Auto-Translate-Posts in 10 Sprachen (Konfiguration und Verwaltung ueber das Dashboard)',
    '   - Konversations-Gedaechtnis pro Channel + User (24h)',
    '3. **Discord-Commands** - verweise auf den aktuellen Katalog. Nenne nur 3-5 wirklich geladene Beispiele wie /help, /ai, /poll, /giveaway oder /ticket. Bot-Admin- und DEV-Verwaltung ist Dashboard-only; Hersteller-Funktionen bleiben die ausdrueckliche Slash-Ausnahme.',
    '4. **Kurzschluss** - 1 Satz im signature-Ton, optional ein dezentes Emoji.',
    '',
    'WICHTIG:',
    '- Keine Aufzaehlung jeder einzelnen Funktion - nur die Hauptkategorien.',
    '- Keine Werbe-Phrasen, keine Uebermotivation.',
    '- Verwende Markdown-Fettung sparsam fuer Struktur.',
    '- Maximal 12 Zeilen.',
  ].join('\n');
}

export function getKnowledgeBoundary(): string {
  const year = new Date().getFullYear();
  return [
    `WICHTIG – Wissensstand: Dein internes Trainingswissen endet vor ${year}.`,
    '',
    'PRIORITAET DER QUELLEN (in dieser Reihenfolge nutzen):',
    '1. AUTORITATIVE ZEIT- UND DATUMSANGABEN (oben im Prompt) → fuer ALLES rund um Datum, Uhrzeit, Wochentag, Tageszeit, Jahreszeit, Jahr.',
    '2. AKTUELLE WEB-RECHERCHE (falls vorhanden) → fuer alle anderen zeitabhaengigen Fakten (Politik, Personen, Sport, Preise, Releases). Nutze sie SELBSTBEWUSST und KONKRET, erfinde nichts hinzu.',
    '3. Stabiles Allgemeinwissen → Mathematik, Geographie, Geschichte vor 2023, Naturwissenschaft, Sprache, Programmierung, Kultur, Definitionen, Erklaerungen, Anleitungen.',
    '',
    'NUR wenn KEINE Web-Recherche vorhanden ist UND die Frage einen aktuellen Zustand verlangt, der sich seit deinem Trainingsende geaendert haben koennte (amtierende Politiker, juengste Wahlergebnisse, aktuelle Sportstandings, Tageskurse, Wetter, neueste Releases), darfst du keine konkrete Aussage als sicher praesentieren.',
    'In diesem Fall sage kurz: "Dazu habe ich gerade keine aktuellen Daten."',
    '',
    'STILREGELN:',
    '- Verweigere NIEMALS die Antwort auf Datum, Uhrzeit, Wochentag, Tageszeit oder Jahreszeit – diese stehen IMMER im Zeit-Block oben.',
    '- Verweigere NIEMALS die Antwort auf Allgemeinwissen, Erklaerungen, Definitionen, Anleitungen, Meinungen oder Smalltalk.',
    '- Nenne KEINE Quellen in der Antwort. Sage NICHT "laut Wikipedia", "laut meinen Quellen", "meinen Recherchen zufolge" o.ae. Antworte einfach direkt mit dem Fakt, als waere es selbstverstaendliches Wissen.',
    '- Erwaehne deinen Wissensstand oder Trainingsende NICHT von dir aus. Nur wenn der Nutzer explizit fragt.',
  ].join('\n');
}

export type AnswerMode = 'chat' | 'welcome' | 'trigger' | 'oneshot';
export interface AnswerOptions {
  mode?: AnswerMode;
  context?: string;
  userId?: string;
  channelId?: string;
  guildId?: string | null;
}

export async function answerQuestion(
  question: string,
  optionsOrContext?: string | AnswerOptions,
): Promise<AiResponse> {
  const opts: AnswerOptions =
    typeof optionsOrContext === 'string'
      ? { context: optionsOrContext }
      : (optionsOrContext ?? {});
  const mode: AnswerMode = opts.mode ?? 'chat';
  const domain = classifyAiConversationDomain(question);
  const dayzDomain = isDayzConversationDomain(question);
  const guardContext = consumeHallucinationGuardReference(opts.context);

  // Harte Quellengrenze: Eine allgemeine Frage bekommt weder den kompletten
  // Channel-/Guild-Kontext noch einen alten DayZ-Halluzinationsguard. Damit ist
  // die Trennung nicht nur eine Prompt-Bitte, sondern bereits vor dem Provider
  // technisch erzwungen.
  const context = mayUseExternalConversationContext(question) ? guardContext.context : null;
  const hallucinationGuard = dayzDomain ? guardContext.guard : null;

  // Zeit, Datum, Wochentag, Monat, Jahr und Jahreszeit sind lokale autoritative
  // Fakten. Dieser Pfad liegt bewusst VOR User-/Provider-Rate-Limits, Websuche
  // und Provider-Routing. Die Screenshot-Frage darf daher selbst bei komplett
  // ausgefallenen/429-Providerketten niemals in die generische Fehlerantwort
  // fallen.
  if (mode !== 'welcome') {
    const timeAnswer = answerLiveTimeQuestion(question);
    if (timeAnswer) {
      logger.info('[AI-Time] provider-unabhaengige Europe/Berlin-Antwort');
      return { success: true, result: timeAnswer };
    }
  }

  if (mode !== 'welcome' && dayzDomain) {
    const guardPreflight = preflightLiveServerQuestion(question, hallucinationGuard);
    if (guardPreflight.handled && guardPreflight.response) {
      logger.info('[AI-16] Live-Server-Frage deterministisch vor Provider beantwortet/blockiert');
      return { success: true, result: redactText(guardPreflight.response) };
    }
  }

  // Der Classname-/1.29-Katalog bleibt bewusst als eigener deterministischer
  // Preflight aktiv. So funktionieren auch etablierte Kurzfragen wie
  // "Feldrucksack Grün" weiterhin ohne das Wort "DayZ".
  if (mode !== 'welcome') {
    try {
      const catalogAnswer = answerDayz129CatalogQuestion(question);
      if (catalogAnswer) {
        logger.info(`[DayZ-129-Catalog] direct-answer preflight (topic=${catalogAnswer.topic}, ids=${catalogAnswer.ids.slice(0, 3).join(',')})`);
        return { success: true, result: redactText(catalogAnswer.answer) };
      }
    } catch (e) {
      logger.error(`[DayZ-129-Catalog] preflight fehlgeschlagen: ${String(e)}`);
    }
  }

  // Nitrado-/DayZ-Hilfetexte duerfen nur bei einer eindeutig erkannten DayZ-
  // Domain feuern. Vorher wurde dieser Lookup fuer jede normale Frage gestartet.
  if (mode !== 'welcome' && dayzDomain) {
    try {
      const preflightHelp = lookupNitradoHelp(question);
      if (preflightHelp.directAnswer) {
        logger.info(`[DayZ-Grounding] direct-answer preflight (topics=${preflightHelp.topicIds.join(',')})`);
        return { success: true, result: redactText(preflightHelp.directAnswer) };
      }
    } catch (e) {
      logger.warn(`[DayZ-Grounding] direct-answer preflight fehlgeschlagen: ${String(e)}`);
    }
  }

  if (opts.userId && mode !== 'welcome') {
    try {
      const rl = await checkRateLimit(opts.userId, 'ai');
      if (!rl.allowed) {
        logger.info(`AI-Rate-Limit ueberschritten fuer user=${opts.userId} (mode=${mode})`);
        return {
          success: false,
          error: 'RATE_LIMIT',
          rateLimitSource: 'user',
          retryAfterSeconds: Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)),
        };
      }
    } catch (e) {
      logger.warn(`AI-Rate-Limiter fail-open fuer user=${opts.userId}: ${e}`);
    }
  }

  const dayzTechnical = mode !== 'welcome' && dayzDomain && isDayzTechnicalAdminQuestion(question);
  const wantWebSearch = (mode === 'chat' || mode === 'oneshot' || mode === 'trigger') && !dayzTechnical;
  const wantCatalog = mode === 'chat' || mode === 'oneshot';
  const wantKnowledgeBoundary = mode !== 'welcome';

  try {
    let liveBlock: string | null = null;
    if (wantWebSearch && looksFactQuestion(question)) {
      try {
        const hits = await liveSearch(question);
        liveBlock = formatSearchResultsForPrompt(hits);
        if (liveBlock) {
          logger.info(`Live-Suche fuer AI [${mode}]: ${hits.length} Treffer fuer "${question.slice(0, 80)}"`);
        }
      } catch (e) {
        logger.warn('Live-Suche fehlgeschlagen, fahre ohne Web-Kontext fort:', { e: String(e) });
      }
    }

    const catalogBlock: string | null =
      wantCatalog && asksAboutCommands(question) ? formatCatalogForPromptFocused(question) : null;
    const introBlock: string | null = wantCatalog && asksForSelfIntroduction(question) ? buildSelfIntroductionInstructions() : null;

    const useMemory = (mode === 'chat' || mode === 'oneshot') && !!opts.userId && !!opts.channelId;
    let memoryTurns: { role: 'user' | 'assistant'; content: string }[] = [];
    if (useMemory) {
      try {
        const { getRecentTurns } = await import('./conversationMemory.js');
        const rawMemory = await getRecentTurns(opts.userId!, opts.channelId!, opts.guildId ?? null);
        memoryTurns = rawMemory.filter(turn => isMemoryTurnCompatible(question, turn.content));
        if (memoryTurns.length < rawMemory.length) {
          logger.info(`[AI-Context-Isolation] ${rawMemory.length - memoryTurns.length} domainfremde Memory-Turn(s) verworfen (domain=${domain})`);
        }
      } catch (e) {
        logger.warn(`conversationMemory laden fehlgeschlagen: ${String(e)}`);
      }
    }

    let nitradoHelpBlock: string | null = null;
    let nitradoHelpTopics: string[] = [];
    if (dayzDomain && (mode === 'chat' || mode === 'oneshot' || mode === 'trigger')) {
      try {
        const ans = lookupNitradoHelp(question);
        if (ans.found) {
          nitradoHelpBlock = ans.text;
          nitradoHelpTopics = ans.topicIds;
          if (ans.directAnswer) {
            const direct = redactText(ans.directAnswer);
            if (useMemory) {
              void (async () => {
                try {
                  const { recordTurn } = await import('./conversationMemory.js');
                  await recordTurn(opts.userId!, opts.channelId!, 'user', question, opts.guildId ?? null);
                  await recordTurn(opts.userId!, opts.channelId!, 'assistant', direct, opts.guildId ?? null);
                } catch (e) {
                  logger.warn(`conversationMemory.recordTurn fuer DayZ directAnswer fehlgeschlagen: ${String(e)}`);
                }
              })();
            }
            logger.info(`[DayZ-Grounding] deterministische Antwort (topics=${ans.topicIds.join(',')})`);
            return { success: true, result: direct };
          }
        } else if (looksLikeDayZFileQuestion(question)) {
          nitradoHelpBlock = getDayZFileTruthBlock();
          nitradoHelpTopics = ['file-truth-fallback'];
        }
      } catch (e) {
        logger.warn(`[Nitrado-Help] in answerQuestion fehlgeschlagen: ${String(e)}`);
      }
    }

    if (dayzTechnical && nitradoHelpBlock && memoryTurns.length > 0) {
      const before = memoryTurns.length;
      memoryTurns = memoryTurns.filter((t) => {
        if (t.role !== 'assistant') return true;
        return validateDayzTechnicalAnswer(t.content, nitradoHelpBlock!, question).valid;
      });
      if (memoryTurns.length < before) {
        logger.info(`[DayZ-Grounding] ${before - memoryTurns.length} ungrounded Memory-Turn(s) gefiltert`);
      }
    }

    const response = await callAI([
      ...(dayzTechnical ? [{ role: 'system' as const, content: 'AI_TASK_PROFILE: reasoning' }] : []),
      { role: 'system', content: BOT_PERSONA },
      { role: 'system', content: getLiveTimeContext() },
      ...(wantKnowledgeBoundary ? [{ role: 'system' as const, content: getKnowledgeBoundary() }] : []),
      ...(catalogBlock ? [{ role: 'system' as const, content: clampBlock('commandContext', catalogBlock)! }] : []),
      ...(introBlock ? [{ role: 'system' as const, content: introBlock }] : []),
      ...(liveBlock ? [{ role: 'system' as const, content: clampBlock('knowledge', liveBlock)! }] : []),
      ...(hallucinationGuard ? [{ role: 'system' as const, content: clampBlock('nitradoContext', formatHallucinationGuardPrompt(hallucinationGuard))! }] : []),
      ...(context ? [{ role: 'system' as const, content: clampBlock('serverContext', context)! }] : []),
      ...clampHistory(memoryTurns).map((t) => ({ role: t.role, content: t.content })),
      ...(nitradoHelpBlock ? [{ role: 'system' as const, content: clampBlock('nitradoContext', nitradoHelpBlock)! }] : []),
      { role: 'user', content: question },
    ]);

    let safeResponse = response ? redactText(response) : response;

    if (dayzTechnical && safeResponse) {
      const grounding = nitradoHelpBlock ?? getDayZFileTruthBlock();
      const validation = validateDayzTechnicalAnswer(safeResponse, grounding, question);
      if (!validation.valid) {
        logger.warn(`[DayZ-Grounding] LLM-Antwort blockiert: ${validation.violations.join('; ')}`);
        safeResponse = buildDayzTechnicalFallback(question, validation.violations);
      }
    }

    if (hallucinationGuard && safeResponse) {
      const guardValidation = validateLiveServerAnswer(question, safeResponse, hallucinationGuard);
      if (!guardValidation.valid) {
        logger.warn(`[AI-16] Halluzinationsschutz blockiert Live-Antwort: ${guardValidation.violations.join('; ')}`);
        safeResponse = buildHallucinationGuardFallback(guardValidation.violations);
      }
    }

    if (useMemory && safeResponse) {
      void (async () => {
        try {
          const { recordTurn } = await import('./conversationMemory.js');
          await recordTurn(opts.userId!, opts.channelId!, 'user', question, opts.guildId ?? null);
          await recordTurn(opts.userId!, opts.channelId!, 'assistant', safeResponse, opts.guildId ?? null);
        } catch (e) {
          logger.warn(`conversationMemory.recordTurn fehlgeschlagen: ${String(e)}`);
        }
      })();
    }

    if (nitradoHelpTopics.length > 0) {
      logger.info(`[Nitrado-Help] generischer Erklärblock injiziert (topics=${nitradoHelpTopics.join(',')})`);
    }

    return { success: true, result: safeResponse };
  } catch (error) {
    const err = error as Error & { code?: string; retryAfterMs?: number };
    logger.error('AI Wissensfrage Fehler:', {
      message: err?.message,
      stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
      name: err?.name,
      code: err?.code,
    });
    if (err?.code === 'RATE_LIMIT' || /RATE_LIMIT|status code 429/.test(err?.message || '')) {
      return {
        success: false,
        error: 'RATE_LIMIT',
        rateLimitSource: 'provider',
        retryAfterSeconds: err.retryAfterMs && err.retryAfterMs > 0
          ? Math.max(1, Math.ceil(err.retryAfterMs / 1000))
          : undefined,
      };
    }
    return { success: false, error: 'AI nicht verfügbar.' };
  }
}

function extractJson<T = any>(raw: string): T {
  let s = (raw ?? '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(s) as T; } catch { /* weiter */ }
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  const lastObj = s.lastIndexOf('}');
  const lastArr = s.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  if (start !== -1 && end > start) {
    const candidate = s.slice(start, end + 1);
    return JSON.parse(candidate) as T;
  }
  throw new Error('Keine JSON-Struktur in der AI-Antwort gefunden.');
}

export async function analyzeSentiment(text: string): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: 'Analysiere das Sentiment des folgenden Texts. Antworte AUSSCHLIESSLICH mit reinem JSON, ohne Code-Fences, ohne erklaerenden Text davor oder danach. Format: {"score": -1 bis 1, "label": "positiv|neutral|negativ", "confidence": 0-1}',
      },
      { role: 'user', content: text },
    ]);

    const parsed = extractJson<{ score: number; label: string; confidence: number }>(response);
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

export async function detectToxicity(
  text: string,
  context?: { userId: string; messageId: string; channelId: string },
): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: 'Analysiere ob der folgende Text toxisch, beleidigend, hasserfüllt oder unangemessen ist. Antworte AUSSCHLIESSLICH mit reinem JSON, ohne Code-Fences, ohne erklaerenden Text. Format: {"toxic": true/false, "score": 0-1, "categories": ["hate", "harassment", "violence", "sexual", "spam"], "explanation": "..."}',
      },
      { role: 'user', content: text },
    ]);

    const parsed = extractJson<any>(response);

    if (context && context.userId && context.messageId && context.channelId) {
      await prisma.aiAnalysis.create({
        data: {
          messageId: context.messageId,
          channelId: context.channelId,
          userId: context.userId,
          analysisType: 'TOXICITY',
          score: typeof parsed.score === 'number' ? parsed.score : 0,
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

export async function translateText(text: string, targetLang: string = 'de'): Promise<AiResponse> {
  try {
    const response = await cached(
      'translate',
      [targetLang, text],
      30 * 60,
      async () =>
        await callAI([
          {
            role: 'system',
            content: `Übersetze den folgenden Text nach ${targetLang}. Gib nur die Übersetzung zurück.`,
          },
          { role: 'user', content: text },
        ]),
    );

    return { success: true, result: response };
  } catch (_error) {
    return { success: false, error: 'Übersetzung fehlgeschlagen.' };
  }
}

export async function analyzeContext(messages: string[]): Promise<AiResponse> {
  try {
    const response = await callAI([
      {
        role: 'system',
        content: 'Analysiere den Kontext der folgenden Nachrichten eines Discord-Channels. Identifiziere potenzielle Konflikte, Regel-Verstöße oder Eskalationen. Antworte AUSSCHLIESSLICH mit reinem JSON, ohne Code-Fences, ohne erklaerenden Text. Format: {"risk_level": "low|medium|high", "issues": [...], "recommendations": [...]}'
      },
      { role: 'user', content: messages.join('\n---\n') },
    ]);

    const parsed = extractJson<any>(response);
    return {
      success: true,
      label: parsed.risk_level,
      details: parsed,
    };
  } catch (_error) {
    return { success: false, error: 'Kontext-Analyse fehlgeschlagen.' };
  }
}

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
  } catch (_error) {
    return { success: false, error: 'Moderationshinweis nicht verfügbar.' };
  }
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const url = `${baseUrl}/chat/completions`;
  const body = normalizeAiProviderRequest(url, {
    model,
    messages,
    max_tokens: 1500,
    temperature: 0.85,
    top_p: 0.92,
    presence_penalty: 0.6,
    frequency_penalty: 0.4,
  });
  const response = await axios.post(
    url,
    body,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(extraHeaders || {}),
      },
      timeout: 30000,
    },
  );
  return String(response.data?.choices?.[0]?.message?.content ?? '').trim();
}

async function callGemini(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const systemBuf: string[] = [];
  const tail: { role: 'user' | 'model'; text: string }[] = [];
  let inTail = false;
  for (const m of messages) {
    if (!inTail && m.role === 'system') {
      systemBuf.push(m.content);
    } else {
      inTail = true;
      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = normalizeAiProviderRequest(url, {
    contents,
    generationConfig: {
      maxOutputTokens: 1500,
    },
  });

  const response = await axios.post(
    url,
    body,
    { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, timeout: 30000 },
  );

  const parts = response.data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part: { thought?: unknown; text?: unknown }) => part?.thought !== true && typeof part?.text === 'string')
    .map((part: { text?: unknown }) => String(part.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseRetryAfter(error: unknown): number {
  const headers = (error as { response?: { headers?: Record<string, string> } })?.response?.headers;
  if (!headers) return 0;
  const ms = headers['retry-after-ms'];
  if (ms && /^\d+$/.test(ms.trim())) return Number(ms.trim());
  const ra = headers['retry-after'];
  if (ra) {
    const s = ra.trim();
    if (/^\d+$/.test(s)) return Number(s) * 1000;
    const date = Date.parse(s);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers['x-ratelimit-reset'] ?? headers['x-ratelimit-reset-requests'];
  if (reset && /^\d+(\.\d+)?$/.test(reset.trim())) return Math.round(Number(reset.trim()) * 1000);
  return 0;
}

export interface Stage48AiLabTransport {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Stage48AiLabOptions {
  providers: ProviderName[];
  transports: Partial<Record<ProviderName, Stage48AiLabTransport>>;
  retryDelayMs?: number;
}

export interface CallAiOptions {
  stage48Lab?: Stage48AiLabOptions;
}

function normalizeStage48AiLab(options: Stage48AiLabOptions): Stage48AiLabOptions {
  if (options.providers.length === 0) throw new Error('Stage-48-AI-Labor benoetigt mindestens einen Provider');
  const providers = [...new Set(options.providers)];
  const transports: Partial<Record<ProviderName, Stage48AiLabTransport>> = {};
  for (const provider of providers) {
    const transport = options.transports[provider];
    if (!transport?.apiKey || !transport.model) {
      throw new Error(`Stage-48-AI-Labortransport fuer ${provider} ist unvollstaendig`);
    }
    transports[provider] = {
      ...transport,
      baseUrl: requireStage48LoopbackUrl(transport.baseUrl),
    };
  }
  return {
    providers,
    transports,
    retryDelayMs: Math.min(1000, Math.max(0, options.retryDelayMs ?? 400)),
  };
}

function hasRuntimeApiKey(provider: ProviderName): boolean {
  switch (provider) {
    case 'groq': return Boolean(config.ai.groqApiKey);
    case 'cerebras': return Boolean(config.ai.cerebrasApiKey);
    case 'openrouter': return Boolean(config.ai.openrouterApiKey);
    case 'gemini': return Boolean(config.ai.geminiApiKey);
    case 'openai': return Boolean(config.ai.openaiApiKey);
  }
}

function rateLimitError(retryAfterMs?: number): Error & { code: string; retryAfterMs?: number } {
  const error = new Error('RATE_LIMIT: Alle geeigneten AI-Provider sind aktuell rate-limited oder im 429-Cooldown.') as Error & {
    code: string;
    retryAfterMs?: number;
  };
  error.code = 'RATE_LIMIT';
  if (retryAfterMs && retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
  return error;
}

export async function callAI(
  messages: { role: string; content: string }[],
  options: CallAiOptions = {},
): Promise<string> {
  const task = inferAiTaskProfile(messages);
  const stage48Lab = options.stage48Lab ? normalizeStage48AiLab(options.stage48Lab) : null;
  const providers = stage48Lab?.providers ?? await getProviderOrder(task);

  // Wenn der Circuit-Breaker alle geeigneten Provider bereits wegen 429 aus
  // der Rotation genommen hat, ist das weiterhin ein Provider-Rate-Limit und
  // kein generischer Fehler. Vorher fiel genau dieser Folgerequest faelschlich
  // auf "Kein AI-Provider verfügbar" und Discord zeigte danach die "Hmm"-Meldung.
  if (!stage48Lab && providers.length === 0) {
    const cooling = getAllCooldowns()
      .filter(entry => hasRuntimeApiKey(entry.provider))
      .filter(entry => providerSupportsTask(entry.provider, getConfiguredModel(entry.provider), task))
      .filter(entry => entry.remainingMs > 0);
    if (cooling.length > 0) {
      const retryAfterMs = Math.min(...cooling.map(entry => entry.remainingMs));
      throw rateLimitError(retryAfterMs);
    }
  }

  let redactedMessages: { role: string; content: string }[];
  try {
    redactedMessages = messages.map(m => ({ role: m.role, content: redactText(m.content) }));
  } catch (e) {
    logger.error('callAI: Outbound-Redaction fehlgeschlagen – Provider-Call abgebrochen (fail-closed).', e as Error);
    throw new Error('AI_REDACTION_FAILED');
  }
  messages = redactedMessages;

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
    const labTransport = stage48Lab?.transports[provider];
    if (labTransport) {
      return await callOpenAICompatible(
        labTransport.baseUrl,
        labTransport.apiKey,
        labTransport.model,
        messages,
      );
    }
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
  let allRateLimited = true;
  let anyAttempted = false;
  let shortestRetryAfterMs = 0;
  logger.info(`callAI start, task=${task}, provider-Reihenfolge: ${providers.join(' -> ')}`);
  for (const provider of providers) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      try {
        logger.info(`callAI versuche provider=${provider} attempt=${attempt}`);
        const result = await callProvider(provider);
        if (result === null) {
          logger.info(`callAI provider=${provider} hat keinen API-Key (null), naechster.`);
          break;
        }
        const latency = Date.now() - t0;
        const visibleResult = result.trim();
        if (!visibleResult) {
          // HTTP 200 ohne sichtbaren Text ist kein Erfolg. Ohne diese Grenze
          // entstand success=true/result='' und messageCreate zeigte danach die
          // generische "Hmm"-Fehlermeldung statt den naechsten Provider zu testen.
          anyAttempted = true;
          allRateLimited = false;
          lastError = new Error('AI_PROVIDER_EMPTY_RESPONSE');
          logger.warn(`AI-Provider ${provider} lieferte eine leere Textantwort (${latency}ms); Fallback wird fortgesetzt.`);
          void recordCall(provider as ProviderName, 'failure', latency, 'empty_response');
          break;
        }
        logger.info(`callAI provider=${provider} ERFOLG (${visibleResult.length} chars, ${latency}ms)`);
        void recordCall(provider as ProviderName, 'success', latency);
        return visibleResult;
      } catch (error) {
        anyAttempted = true;
        lastError = error;
        const latency = Date.now() - t0;
        const status = (error as { response?: { status?: number } })?.response?.status;
        const { isRateLimit: is429, isAuthOrModel } = classifyProviderHttpStatus(status);
        allRateLimited = updateAllRateLimitedState(allRateLimited, status);
        const transient = isTransient(error);
        const errMsg = (error as Error)?.message || String(error);
        logger.warn(
          `AI-Provider ${provider} Versuch ${attempt}/2 fehlgeschlagen${transient ? ' (transient)' : ''}: ${errMsg}`,
        );
        if (isAuthOrModel) {
          markProviderUnavailable(provider as ProviderName, `http_${status}`);
          void recordCall(provider as ProviderName, 'failure', latency, errMsg);
          break;
        }
        if (is429) {
          const retryAfterMs = parseRetryAfter(error);
          if (retryAfterMs > 0 && (shortestRetryAfterMs === 0 || retryAfterMs < shortestRetryAfterMs)) {
            shortestRetryAfterMs = retryAfterMs;
          }
          void recordCall(provider as ProviderName, 'rateLimit', latency, errMsg, { retryAfterMs });
          break;
        }
        if (transient && attempt === 1) {
          await new Promise(r => setTimeout(r, stage48Lab?.retryDelayMs ?? 400));
          continue;
        }
        void recordCall(provider as ProviderName, 'failure', latency, errMsg);
        break;
      }
    }
  }

  if (anyAttempted && allRateLimited) {
    const cooldownRetry = !stage48Lab
      ? getAllCooldowns()
          .filter(entry => hasRuntimeApiKey(entry.provider))
          .filter(entry => providerSupportsTask(entry.provider, getConfiguredModel(entry.provider), task))
          .map(entry => entry.remainingMs)
          .filter(ms => ms > 0)
      : [];
    const retryAfterMs = shortestRetryAfterMs > 0
      ? shortestRetryAfterMs
      : (cooldownRetry.length > 0 ? Math.min(...cooldownRetry) : undefined);
    throw rateLimitError(retryAfterMs);
  }
  const detail = lastError ? `: ${(lastError as Error)?.message || String(lastError)}` : '';
  throw new Error(`Kein AI-Provider verfügbar${detail}`);
}

async function getProviderOrder(task: AiTaskProfile): Promise<('groq' | 'cerebras' | 'openrouter' | 'gemini' | 'openai')[]> {
  try {
    const ranked = await getRankedProviders(task);
    if (ranked.length > 0) return ranked;
  } catch (e) {
    logger.warn(`getProviderOrder: getRankedProviders fehlgeschlagen, Capability-Fallback: ${String(e)}`);
  }
  const all: ('groq' | 'cerebras' | 'openrouter' | 'gemini' | 'openai')[] = [
    'groq',
    'cerebras',
    'openrouter',
    'gemini',
    'openai',
  ];
  const primary = config.ai.provider;
  return [primary, ...all.filter(p => p !== primary)]
    .filter((p) => hasRuntimeApiKey(p))
    .filter((p) => !isOnCooldown(p) && providerSupportsTask(p, getConfiguredModel(p), task));
}
