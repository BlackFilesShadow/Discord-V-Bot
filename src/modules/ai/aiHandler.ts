import axios from 'axios';
import { config } from '../../config';
import { logger, logAudit } from '../../utils/logger';
import prisma from '../../database/prisma';

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
 * Wissensfrage beantworten.
 */
export async function answerQuestion(question: string, context?: string): Promise<AiResponse> {
  try {
    const response = await callOpenAI([
      { role: 'system', content: 'Du bist ein hilfreicher Assistent für einen Discord-Server. Antworte kurz und präzise auf Deutsch.' },
      ...(context ? [{ role: 'system', content: `Kontext: ${context}` }] : []),
      { role: 'user', content: question },
    ]);

    return { success: true, result: response };
  } catch (error) {
    logger.error('AI Wissensfrage Fehler:', error);
    return { success: false, error: 'AI nicht verfügbar.' };
  }
}

/**
 * Sentiment-Analyse einer Nachricht.
 * Sektion 4: Sentiment-Analyse.
 */
export async function analyzeSentiment(text: string): Promise<AiResponse> {
  try {
    const response = await callOpenAI([
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
    const response = await callOpenAI([
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
    const response = await callOpenAI([
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
    const response = await callOpenAI([
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
    const response = await callOpenAI([
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
 * OpenAI API aufrufen.
 */
async function callOpenAI(messages: { role: string; content: string }[]): Promise<string> {
  if (!config.ai.openaiApiKey) {
    throw new Error('OpenAI API Key nicht konfiguriert.');
  }

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: config.ai.model,
      messages,
      max_tokens: 1000,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${config.ai.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return response.data.choices[0]?.message?.content || '';
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
          const aiResp = await callOpenAI([
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
    if (!config.ai.openaiApiKey) {
      throw new Error('OpenAI API Key nicht konfiguriert.');
    }

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: config.ai.model,
        messages: [
          { role: 'system', content: mod.systemPrompt },
          { role: 'user', content: input },
        ],
        max_tokens: mod.maxTokens,
        temperature: mod.temperature,
      },
      {
        headers: {
          Authorization: `Bearer ${config.ai.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const result = response.data.choices[0]?.message?.content || '';
    return { success: true, result };
  } catch (error) {
    logger.error(`Custom AI Module ${moduleId} Fehler:`, error);
    return { success: false, error: 'Modul-Ausführung fehlgeschlagen.' };
  }
}
