/**
 * Security-Regression-Tests fuer die Production-Haertung (Task 17 / Revision VI).
 *
 * Deckt ab:
 *  - Start-Abbruch in Production bei Default-/Platzhalter-Secrets
 *  - GlobalDeveloperIdentity: BOT_OWNER_ID/Legacy-Alias + Snowflake-Validierung
 *  - In Nicht-Production wird NICHT abgebrochen
 *  - package.json start/main zeigen auf dist/src/index.js
 *  - Faction-Upload akzeptiert nur passende Magic-Number (Mime != Inhalt -> reject)
 *  - DEV-Upload-Verzeichnis liegt NICHT unter dem oeffentlichen uploads-Pfad
 */
import * as path from 'node:path';
import { collectProductionEnvErrors, isDiscordSnowflake } from '../../src/utils/envValidation';

const AI_KEY_FIXTURES = [
  { key: 'GROQ_API_KEY', placeholder: 'your_groq_api_key_here' },
  { key: 'CEREBRAS_API_KEY', placeholder: 'your_cerebras_api_key_here' },
  { key: 'OPENROUTER_API_KEY', placeholder: 'your_openrouter_api_key_here' },
  { key: 'GEMINI_API_KEY', placeholder: 'your_gemini_api_key_here' },
  { key: 'OPENAI_API_KEY', placeholder: 'your_openai_api_key_here' },
] as const;

function validProdEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DISCORD_TOKEN: 'MTA-real-token-value',
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'real-client-secret-value',
    BOT_OWNER_ID: '123456789012345678',
    DATABASE_URL: 'postgresql://discordbot:S3cretPW@postgres:5432/db?schema=public',
    POSTGRES_PASSWORD: 'S3cretPW',
    SESSION_SECRET: 'a'.repeat(64),
    ENCRYPTION_KEY: 'b'.repeat(64),
    DEV_PASSWORD: 'a-very-long-random-dev-password',
    GROQ_API_KEY: 'gsk_realkey',
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
  };
}

describe('collectProductionEnvErrors', () => {
  it('akzeptiert eine vollstaendig gueltige Production-Konfiguration', () => {
    expect(collectProductionEnvErrors(validProdEnv())).toEqual([]);
  });

  it('erlaubt leere optionale API-Keys', () => {
    const env = validProdEnv();
    env.GEMINI_API_KEY = '';
    env.OPENAI_API_KEY = '';
    expect(collectProductionEnvErrors(env)).toEqual([]);
  });

  it.each(['fehlend', 'leer', 'whitespace'])('behaelt optionale AI-Keys ausserhalb des fatalen Startvertrags (%s)', (state) => {
    const env = validProdEnv();
    for (const { key } of AI_KEY_FIXTURES) {
      if (state === 'fehlend') delete env[key];
      else env[key] = state === 'leer' ? '' : ' \t\r\n ';
    }

    expect(collectProductionEnvErrors(env)).toEqual([]);
  });

  it.each(AI_KEY_FIXTURES)('akzeptiert $key als einzigen echten Key mit Rand-Whitespace', ({ key }) => {
    const env = validProdEnv();
    for (const fixture of AI_KEY_FIXTURES) env[fixture.key] = '';
    env[key] = ' \tfixture-ai-key-not-real\r\n ';

    expect(collectProductionEnvErrors(env)).toEqual([]);
  });

  it.each(AI_KEY_FIXTURES)('lehnt einen ausdruecklich gesetzten $key-Platzhalter weiterhin ab', ({ key, placeholder }) => {
    const env = validProdEnv();
    for (const fixture of AI_KEY_FIXTURES) env[fixture.key] = '';
    env[key] = ` \t${placeholder}\n `;

    const errors = collectProductionEnvErrors(env);
    expect(errors).toEqual([
      expect.stringContaining(`${key} trägt noch den Platzhalterwert`),
    ]);
  });

  it.each(AI_KEY_FIXTURES.filter(({ key }) => key !== 'GROQ_API_KEY'))(
    'lehnt einen $key-Platzhalter auch neben einem echten Primaer-Key ab',
    ({ key, placeholder }) => {
      const env = validProdEnv();
      env[key] = placeholder;

      const errors = collectProductionEnvErrors(env);
      expect(errors).toEqual([expect.stringContaining(`${key} trägt noch den Platzhalterwert`)]);
      expect(errors.join('\n')).not.toContain(env.GROQ_API_KEY);
    },
  );

  it('bricht bei Platzhalter-DISCORD_TOKEN ab', () => {
    const env = validProdEnv();
    env.DISCORD_TOKEN = 'your_discord_bot_token_here';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('DISCORD_TOKEN'))).toBe(true);
  });

  it('bricht bei Platzhalter-SESSION_SECRET/ENCRYPTION_KEY/DEV_PASSWORD ab', () => {
    const env = validProdEnv();
    env.SESSION_SECRET = 'your_session_secret_here_min_64_chars';
    env.ENCRYPTION_KEY = 'your_32_byte_encryption_key_hex';
    env.DEV_PASSWORD = 'change_me_to_a_long_random_secret';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('SESSION_SECRET'))).toBe(true);
    expect(errors.some((e) => e.includes('ENCRYPTION_KEY'))).toBe(true);
    expect(errors.some((e) => e.includes('DEV_PASSWORD'))).toBe(true);
  });

  it('bricht ab, wenn DATABASE_URL "changeme" enthaelt', () => {
    const env = validProdEnv();
    env.DATABASE_URL = 'postgresql://discordbot:changeme@postgres:5432/db';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
  });

  it('bricht ab, wenn POSTGRES_PASSWORD=changeme', () => {
    const env = validProdEnv();
    env.POSTGRES_PASSWORD = 'changeme';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('POSTGRES_PASSWORD'))).toBe(true);
  });

  it('erzwingt eine globale Owner-ID in Production', () => {
    const env = validProdEnv();
    delete env.BOT_OWNER_ID;
    delete env.DISCORD_OWNER_ID;
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('BOT_OWNER_ID fehlt'))).toBe(true);
  });

  it('akzeptiert den kontrollierten Legacy-Alias DISCORD_OWNER_ID', () => {
    const env = validProdEnv();
    delete env.BOT_OWNER_ID;
    env.DISCORD_OWNER_ID = '123456789012345678';
    expect(collectProductionEnvErrors(env)).toEqual([]);
  });

  it('lehnt ungueltige Owner-Snowflakes ab', () => {
    const env = validProdEnv();
    env.BOT_OWNER_ID = 'not-a-snowflake';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('Discord-Snowflake'))).toBe(true);
    expect(isDiscordSnowflake('123456789012345678')).toBe(true);
    expect(isDiscordSnowflake('123')).toBe(false);
  });

  it('lehnt widerspruechliche kanonische/Legacy-Owner-IDs ab', () => {
    const env = validProdEnv();
    env.DISCORD_OWNER_ID = '999999999999999999';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('widersprechen sich'))).toBe(true);
  });

  it('erzwingt KEINE optionale DEV-IP-Allowlist', () => {
    const env = validProdEnv();
    env.DEV_REQUIRE_IP_ALLOWLIST = 'false';
    env.DEV_IP_ALLOWLIST = '';
    expect(collectProductionEnvErrors(env)).toEqual([]);
  });

  it('macht in Nicht-Production keine Vorgaben im assert-Gate', () => {
    const env = validProdEnv();
    env.NODE_ENV = 'development';
    expect(collectProductionEnvErrors(env)).toEqual([]);
  });
});

describe('assertProductionEnv (Start-Gate)', () => {
  it.each(['fehlend', 'leer', 'whitespace'])('sperrt den Production-Start nicht allein wegen optionaler AI-Keys (%s)', (state) => {
    const { assertProductionEnv } = require('../../src/utils/envValidation');
    const env = validProdEnv();
    for (const { key } of AI_KEY_FIXTURES) {
      if (state === 'fehlend') delete env[key];
      else env[key] = state === 'leer' ? '' : ' \t\r\n ';
    }
    const logs: string[] = [];
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      assertProductionEnv(env, (message: string) => logs.push(message));
      expect(exit).not.toHaveBeenCalled();
      expect(logs.join('\n')).not.toContain('START ABGEBROCHEN');
    } finally {
      exit.mockRestore();
    }
  });

  it('bricht in Production bei unsicherer Konfiguration ab (process.exit + Meldung)', () => {
    const { assertProductionEnv } = require('../../src/utils/envValidation');
    const env = validProdEnv();
    env.DISCORD_TOKEN = 'your_discord_bot_token_here';

    const logs: string[] = [];
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    assertProductionEnv(env, (m: string) => logs.push(m));

    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.join('\n')).toContain('START ABGEBROCHEN');
    expect(logs.join('\n')).toContain('DISCORD_TOKEN');
    exit.mockRestore();
  });

  it('laesst gueltige Production-Konfiguration durch (kein exit)', () => {
    const { assertProductionEnv } = require('../../src/utils/envValidation');
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    assertProductionEnv(validProdEnv(), () => { /* noop */ });

    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('macht in Nicht-Production gar nichts (kein exit, auch bei Platzhaltern)', () => {
    const { assertProductionEnv } = require('../../src/utils/envValidation');
    const env = validProdEnv();
    env.NODE_ENV = 'development';
    env.DISCORD_TOKEN = 'your_discord_bot_token_here';
    delete env.BOT_OWNER_ID;
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    assertProductionEnv(env, () => { /* noop */ });

    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});

describe('package.json Startpfade', () => {
  const pkg = require('../../package.json');
  it('main zeigt auf dist/src/index.js', () => {
    expect(pkg.main).toBe('dist/src/index.js');
  });
  it('start startet dist/src/index.js', () => {
    expect(pkg.start ?? pkg.scripts.start).toContain('dist/src/index.js');
  });
  it('@types/express ist auf v4 gepinnt (Runtime ist express 4)', () => {
    expect(pkg.devDependencies['@types/express']).toMatch(/^\^?4\./);
  });
});

describe('Faction-Upload Magic-Number-Pruefung', () => {
  process.env.DISCORD_TOKEN ||= 'test-token';
  process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
  process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
  process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
  process.env.SESSION_SECRET ||= 'test-session-secret';
  process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';

  const { verifyMagicNumber } = require('../../src/dashboard/routes/v2/factions');

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const GIF = Buffer.from('GIF89a-----------', 'ascii');
  const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
  const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'ascii'), Buffer.from([0, 0, 0, 0])]);

  it('akzeptiert passende Header', () => {
    expect(verifyMagicNumber('image/png', PNG)).toBe(true);
    expect(verifyMagicNumber('image/jpeg', JPG)).toBe(true);
    expect(verifyMagicNumber('image/gif', GIF)).toBe(true);
    expect(verifyMagicNumber('image/webp', WEBP)).toBe(true);
    expect(verifyMagicNumber('video/webm', WEBM)).toBe(true);
    expect(verifyMagicNumber('video/mp4', MP4)).toBe(true);
    expect(verifyMagicNumber('video/quicktime', MP4)).toBe(true);
  });

  it('lehnt Inhalt ab, der nicht zum MIME passt (Spoofing)', () => {
    expect(verifyMagicNumber('image/jpeg', PNG)).toBe(false);
    expect(verifyMagicNumber('image/png', Buffer.from('<?xml version="1.0"?>plain', 'ascii'))).toBe(false);
    expect(verifyMagicNumber('image/png', Buffer.from([0x89, 0x50]))).toBe(false);
  });
});

describe('DEV-Upload-Verzeichnis ist privat', () => {
  process.env.DISCORD_TOKEN ||= 'test-token';
  process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
  process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
  process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
  process.env.SESSION_SECRET ||= 'test-session-secret';
  process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';

  const { config } = require('../../src/config');

  it('devUploadDir liegt NICHT unter dem oeffentlichen uploads-Verzeichnis', () => {
    const publicDir = config.upload.dir + path.sep;
    expect(config.upload.devUploadDir.startsWith(publicDir)).toBe(false);
  });

  it('factionsDir liegt UNTER dem oeffentlichen uploads-Verzeichnis', () => {
    const publicDir = config.upload.dir + path.sep;
    expect(config.upload.factionsDir.startsWith(publicDir)).toBe(true);
  });

  it('exportDir liegt NICHT unter dem oeffentlichen uploads-Verzeichnis', () => {
    const publicDir = config.upload.dir + path.sep;
    expect(config.upload.exportDir.startsWith(publicDir)).toBe(false);
  });
});
