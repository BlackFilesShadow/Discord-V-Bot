jest.mock('dotenv', () => ({
  __esModule: true,
  default: { config: jest.fn() },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { aiProviderStat: { findMany: jest.fn().mockResolvedValue([]) } },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/modules/ai/aiObservability', () => ({
  recordAiFallback: jest.fn(),
  recordAiProviderAttempt: jest.fn(),
}));

jest.mock('../../src/modules/ai/providerRequestCompatibility', () => ({
  normalizeAiProviderRequest: jest.fn((_url: string, data: unknown) => data),
}));

const AI_KEY_FIELDS = [
  ['GROQ_API_KEY', 'groqApiKey'],
  ['CEREBRAS_API_KEY', 'cerebrasApiKey'],
  ['OPENROUTER_API_KEY', 'openrouterApiKey'],
  ['GEMINI_API_KEY', 'geminiApiKey'],
  ['OPENAI_API_KEY', 'openaiApiKey'],
] as const;

const AI_ENV_NAMES = [
  'AI_PROVIDER',
  ...AI_KEY_FIELDS.map(([name]) => name),
  'GROQ_MODEL', 'CEREBRAS_MODEL', 'OPENROUTER_MODEL', 'GEMINI_MODEL', 'OPENAI_MODEL',
];

interface ProviderRuntime {
  config: typeof import('../../src/config')['config'];
  getProviderConfigurationHealth: typeof import('../../src/modules/ai/providerStats')['getProviderConfigurationHealth'];
  getStats: typeof import('../../src/modules/ai/providerStats')['getStats'];
}

function loadProviderRuntime(overrides: Record<string, string> = {}): ProviderRuntime {
  const previous = new Map(AI_ENV_NAMES.map(name => [name, process.env[name]]));
  let runtime: ProviderRuntime | undefined;
  try {
    for (const name of AI_ENV_NAMES) delete process.env[name];
    Object.assign(process.env, overrides);
    jest.isolateModules(() => {
      const { config } = require('../../src/config');
      const { getProviderConfigurationHealth, getStats } = require('../../src/modules/ai/providerStats');
      runtime = { config, getProviderConfigurationHealth, getStats };
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (!runtime) throw new Error('Provider test runtime could not be loaded');
  return runtime;
}

describe('AI runtime key normalization', () => {
  it.each(AI_KEY_FIELDS)('trimmt %s beim echten Config-Import', (envName, field) => {
    const { config, getProviderConfigurationHealth } = loadProviderRuntime({
      [envName]: ' \tfixture-ai-key-not-real\r\n ',
    });

    expect(config.ai[field]).toBe('fixture-ai-key-not-real');
    expect(getProviderConfigurationHealth().configuredCount).toBe(1);
  });

  it('zaehlt Whitespace-Keys aller fuenf Provider nicht als konfiguriert', () => {
    const { config, getProviderConfigurationHealth } = loadProviderRuntime(
      Object.fromEntries(AI_KEY_FIELDS.map(([name]) => [name, ' \t\r\n '])),
    );

    for (const [, field] of AI_KEY_FIELDS) expect(config.ai[field]).toBe('');
    expect(getProviderConfigurationHealth()).toMatchObject({
      configuredProviders: [],
      configuredCount: 0,
      resilience: 'unavailable',
    });
  });
});

describe('AI provider configuration health', () => {
  it('diagnostiziert fehlende Keys und einen nicht konfigurierten Primaerprovider', () => {
    const { getProviderConfigurationHealth } = loadProviderRuntime();

    expect(getProviderConfigurationHealth()).toEqual({
      primary: 'groq',
      primaryConfigured: false,
      configuredProviders: [],
      fallbackProviders: [],
      configuredCount: 0,
      resilience: 'unavailable',
      warnings: [
        expect.stringContaining('Kein AI-Provider-API-Key konfiguriert'),
        expect.stringContaining('Primaerprovider groq hat keinen nutzbaren API-Key'),
      ],
    });
  });

  it('meldet einen einzelnen gueltigen Provider ohne redundanten Fallback', () => {
    const { getProviderConfigurationHealth } = loadProviderRuntime({
      GROQ_API_KEY: 'fixture-groq-key-not-real',
    });

    expect(getProviderConfigurationHealth()).toEqual({
      primary: 'groq',
      primaryConfigured: true,
      configuredProviders: ['groq'],
      fallbackProviders: [],
      configuredCount: 1,
      resilience: 'single_provider',
      warnings: [expect.stringContaining('Nur ein AI-Provider ist konfiguriert')],
    });
  });

  it('meldet zwei gueltige Provider als redundant und trennt den Primaerprovider vom Fallback', () => {
    const { getProviderConfigurationHealth } = loadProviderRuntime({
      AI_PROVIDER: 'gemini',
      GROQ_API_KEY: 'fixture-groq-key-not-real',
      GEMINI_API_KEY: 'fixture-gemini-key-not-real',
    });

    expect(getProviderConfigurationHealth()).toEqual({
      primary: 'gemini',
      primaryConfigured: true,
      configuredProviders: ['groq', 'gemini'],
      fallbackProviders: ['groq'],
      configuredCount: 2,
      resilience: 'redundant',
      warnings: [],
    });
  });

  it('warnt bei fehlendem Primary-Key trotz vorhandener redundanter Alternativen', () => {
    const { getProviderConfigurationHealth } = loadProviderRuntime({
      AI_PROVIDER: 'openai',
      GROQ_API_KEY: 'fixture-groq-key-not-real',
      GEMINI_API_KEY: 'fixture-gemini-key-not-real',
    });

    expect(getProviderConfigurationHealth()).toEqual({
      primary: 'openai',
      primaryConfigured: false,
      configuredProviders: ['groq', 'gemini'],
      fallbackProviders: ['groq', 'gemini'],
      configuredCount: 2,
      resilience: 'redundant',
      warnings: [expect.stringContaining('Primaerprovider openai hat keinen nutzbaren API-Key')],
    });
  });

  it('kennzeichnet den niedrig limitierten OpenRouter-Free-Router gesondert', () => {
    const { getProviderConfigurationHealth } = loadProviderRuntime({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'fixture-openrouter-key-not-real',
    });

    expect(getProviderConfigurationHealth().warnings).toEqual([
      expect.stringContaining('Nur ein AI-Provider ist konfiguriert'),
      expect.stringContaining('openrouter/free ist ein niedrig limitierter Fallback'),
    ]);
  });

  it('zeigt unbekannte Modelle und ihre konservativen Capabilities ohne API-Key-Werte', async () => {
    const apiKey = 'fixture-openrouter-private-key-not-real';
    const { getProviderConfigurationHealth, getStats } = loadProviderRuntime({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: apiKey,
      OPENROUTER_MODEL: 'custom/company-model',
    });
    const health = getProviderConfigurationHealth();
    const stats = await getStats();

    expect(health.warnings).toContainEqual(expect.stringContaining('Modell custom/company-model ist nicht in der Capability-Registry verifiziert'));
    expect(stats.find(row => row.provider === 'openrouter')).toMatchObject({
      configured: true,
      model: 'custom/company-model',
      knownModel: false,
      capabilities: ['chat'],
    });
    expect(stats.find(row => row.provider === 'groq')).toMatchObject({
      configured: false,
      model: '',
      knownModel: false,
      capabilities: [],
    });
    expect(JSON.stringify({ health, stats })).not.toContain(apiKey);
  });

  it('stellt das aufgeloeste Legacy-Modell samt verifizierten Capabilities bereit', async () => {
    const { getProviderConfigurationHealth, getStats } = loadProviderRuntime({
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'fixture-gemini-key-not-real',
      GEMINI_MODEL: 'gemini-2.0-flash-lite',
    });

    expect(getProviderConfigurationHealth().warnings).not.toContainEqual(expect.stringContaining('Capability-Registry'));
    expect((await getStats()).find(row => row.provider === 'gemini')).toMatchObject({
      configured: true,
      model: 'gemini-3.5-flash-lite',
      knownModel: true,
      capabilities: expect.arrayContaining(['chat', 'fast', 'structured', 'reasoning', 'long_context', 'tool']),
    });
  });
});
