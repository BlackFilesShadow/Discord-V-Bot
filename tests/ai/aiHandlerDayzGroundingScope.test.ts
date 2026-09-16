jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: {
    ai: {
      provider: 'groq',
      groqApiKey: 'groq-key',
      groqModel: 'openai/gpt-oss-120b',
      cerebrasApiKey: 'cerebras-key',
      cerebrasModel: 'gpt-oss-120b',
      openrouterApiKey: '',
      openrouterModel: 'openrouter/free',
      geminiApiKey: '',
      geminiModel: 'gemini-3.7-flash',
      openaiApiKey: '',
      openaiModel: 'gpt-5.6-luna',
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { aiAnalysis: { create: jest.fn() } },
}));

jest.mock('../../src/modules/ai/webSearch', () => ({
  liveSearch: jest.fn(),
  looksFactQuestion: jest.fn(() => false),
  formatSearchResultsForPrompt: jest.fn(),
}));

jest.mock('../../src/modules/ai/commandCatalog', () => ({
  asksAboutCommands: jest.fn(() => false),
  formatCatalogForPromptFocused: jest.fn(),
}));

jest.mock('../../src/utils/rateLimiter', () => ({
  checkRateLimit: jest.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
}));

const mockValidateDayzTechnicalAnswer = jest.fn(() => ({ valid: true, violations: [] as string[] }));
const mockBuildDayzTechnicalFallback = jest.fn(() => 'FALLBACK');
jest.mock('../../src/modules/ai/nitradoHelp', () => ({
  lookupNitradoHelp: jest.fn(() => ({ found: false, topicIds: [] })),
  looksLikeDayZFileQuestion: jest.fn(() => false),
  getDayZFileTruthBlock: jest.fn(() => 'GROUNDING_BLOCK'),
  // Bewusst IMMER false: simuliert eine DayZ-Domain-Frage, die NICHT in die
  // schmale "dayzTechnical"-Teilmenge faellt (kein "hasDayz && hasTechnical",
  // keine Datei-Frage) - genau die Kategorie, die vor der Erweiterung des
  // Grounding-Checks komplett ungeprueft an die KI-Antwort durchgereicht wurde.
  isDayzTechnicalAdminQuestion: jest.fn(() => false),
  validateDayzTechnicalAnswer: (...args: unknown[]) => mockValidateDayzTechnicalAnswer(...(args as [])),
  buildDayzTechnicalFallback: (...args: unknown[]) => mockBuildDayzTechnicalFallback(...(args as [])),
}));

jest.mock('../../src/modules/nitrado/mirror/redactor', () => ({
  redactText: (value: string) => value,
}));

jest.mock('../../src/utils/responseCache', () => ({ cached: jest.fn() }));

jest.mock('../../src/modules/ai/promptBudget', () => ({
  clampBlock: jest.fn((_kind: string, value: string) => value),
  clampHistory: jest.fn((value: unknown[]) => value),
  getTotalPromptBudget: jest.fn(() => 32_000),
}));

jest.mock('../../src/modules/ai/dayz129Catalog', () => ({
  answerDayz129CatalogQuestion: jest.fn(() => null),
}));

jest.mock('../../src/modules/ai/conversationMemory', () => ({
  getRecentTurns: jest.fn(async () => []),
  recordTurn: jest.fn(async () => undefined),
}));

jest.mock('../../src/modules/ai/dayzHallucinationGuard', () => ({
  buildHallucinationGuardFallback: jest.fn(() => ''),
  consumeHallucinationGuardReference: jest.fn(() => ({ context: null, guard: null })),
  formatHallucinationGuardPrompt: jest.fn(() => ''),
  preflightLiveServerQuestion: jest.fn(() => ({ handled: false })),
  validateLiveServerAnswer: jest.fn(() => ({ valid: true, violations: [] })),
}));

jest.mock('../../src/modules/ai/liveTime', () => ({
  answerLiveTimeQuestion: jest.fn(() => null),
  buildLiveTimeContext: jest.fn(() => 'ZEITKONTEXT'),
  shouldIncludeLiveTimeContext: jest.fn(() => false),
}));

jest.mock('../../src/modules/ai/providerRequestCompatibility', () => ({
  normalizeAiProviderRequest: jest.fn((_url: string, body: unknown) => body),
}));

jest.mock('../../src/modules/ai/providerStats', () => ({
  __esModule: true,
  recordCall: jest.fn(),
  getRankedProviders: jest.fn(async () => ['groq']),
  getConfiguredModel: jest.fn(() => 'openai/gpt-oss-120b'),
  getAllCooldowns: jest.fn(() => []),
  getCooldownRemainingMs: jest.fn(() => 0),
  isOnCooldown: jest.fn(() => false),
  markProviderUnavailable: jest.fn(),
}));

jest.mock('../../src/modules/ai/providerCapabilities', () => ({
  inferAiTaskProfile: jest.fn(() => 'chat'),
  providerSupportsTask: jest.fn(() => true),
}));

import axios from 'axios';
import { answerQuestion } from '../../src/modules/ai/aiHandler';

const post = axios.post as jest.Mock;

/**
 * Regressionsschutz fuer die Erweiterung des DayZ-Grounding-Checks von der
 * schmalen "dayzTechnical"-Teilmenge auf die komplette DayZ-Domaene
 * (aiHandler.ts, answerQuestion). isDayzTechnicalAdminQuestion ist in diesem
 * Testfile fest auf `false` gemockt - jede hier verwendete DayZ-Frage waere
 * damit VOR der Erweiterung nie durch validateDayzTechnicalAnswer geprueft
 * worden, egal was die KI geantwortet haette.
 */
describe('answerQuestion: DayZ-Grounding-Check deckt die gesamte DayZ-Domaene ab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateDayzTechnicalAnswer.mockReturnValue({ valid: true, violations: [] });
    mockBuildDayzTechnicalFallback.mockReturnValue('FALLBACK');
  });

  it('ruft validateDayzTechnicalAnswer auch fuer eine DayZ-Domain-Frage auf, die nicht "dayzTechnical" ist', async () => {
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'Eine Antwort ueber DayZ.' } }] } });

    const result = await answerQuestion('Was macht DayZ als Survival-Spiel besonders?');

    expect(result).toEqual({ success: true, result: 'Eine Antwort ueber DayZ.' });
    expect(mockValidateDayzTechnicalAnswer).toHaveBeenCalledWith(
      'Eine Antwort ueber DayZ.',
      'GROUNDING_BLOCK',
      'Was macht DayZ als Survival-Spiel besonders?',
    );
  });

  it('ersetzt eine ungrounded DayZ-Antwort durch den Fallback, auch ausserhalb der alten dayzTechnical-Teilmenge', async () => {
    mockValidateDayzTechnicalAnswer.mockReturnValue({ valid: false, violations: ['UNSUPPORTED_IDENTIFIER:FakeClassname'] });
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'Das Item heisst `FakeClassname` in DayZ.' } }] } });

    const result = await answerQuestion('Was macht DayZ als Survival-Spiel besonders?');

    expect(result).toEqual({ success: true, result: 'FALLBACK' });
    expect(mockBuildDayzTechnicalFallback).toHaveBeenCalledWith(
      'Was macht DayZ als Survival-Spiel besonders?',
      ['UNSUPPORTED_IDENTIFIER:FakeClassname'],
    );
  });

  it('laesst eine normale, nicht-DayZ-Frage weiterhin unangetastet (kein Grounding-Check ausserhalb der DayZ-Domain)', async () => {
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'Photosynthese wandelt Licht in Energie um.' } }] } });

    const result = await answerQuestion('Wie funktioniert Photosynthese?');

    expect(result).toEqual({ success: true, result: 'Photosynthese wandelt Licht in Energie um.' });
    expect(mockValidateDayzTechnicalAnswer).not.toHaveBeenCalled();
  });
});
