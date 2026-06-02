/**
 * Security-Regression-Tests fuer die Production-Haertung (Task 17).
 *
 * Deckt ab:
 *  - Start-Abbruch in Production bei Default-/Platzhalter-Secrets
 *  - Start-Abbruch ohne DEV_REQUIRE_MFA=true
 *  - Start-Abbruch ohne DEV_REQUIRE_IP_ALLOWLIST=true bzw. leerer Allowlist
 *  - In Nicht-Production wird NICHT abgebrochen
 *  - package.json start/main zeigen auf dist/src/index.js
 *  - Faction-Upload akzeptiert nur passende Magic-Number (Mime != Inhalt -> reject)
 *  - DEV-Upload-Verzeichnis liegt NICHT unter dem oeffentlichen uploads-Pfad
 */
import * as path from 'node:path';
import { collectProductionEnvErrors } from '../../src/utils/envValidation';

// Eine vollstaendig gueltige Production-Umgebung als Basis fuer die Tests.
function validProdEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DISCORD_TOKEN: 'MTA-real-token-value',
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'real-client-secret-value',
    DATABASE_URL: 'postgresql://discordbot:S3cretPW@postgres:5432/db?schema=public',
    POSTGRES_PASSWORD: 'S3cretPW',
    SESSION_SECRET: 'a'.repeat(64),
    ENCRYPTION_KEY: 'b'.repeat(64),
    DEV_PASSWORD: 'a-very-long-random-dev-password',
    GROQ_API_KEY: 'gsk_realkey',
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    DEV_REQUIRE_MFA: 'true',
    DEV_REQUIRE_IP_ALLOWLIST: 'true',
    DEV_IP_ALLOWLIST: '203.0.113.5',
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

  it('bricht ab, wenn DEV_REQUIRE_MFA nicht true ist', () => {
    const env = validProdEnv();
    env.DEV_REQUIRE_MFA = 'false';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('DEV_REQUIRE_MFA'))).toBe(true);
  });

  it('bricht ab, wenn DEV_REQUIRE_IP_ALLOWLIST nicht true ist', () => {
    const env = validProdEnv();
    env.DEV_REQUIRE_IP_ALLOWLIST = 'false';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('DEV_REQUIRE_IP_ALLOWLIST'))).toBe(true);
  });

  it('bricht ab, wenn DEV_REQUIRE_IP_ALLOWLIST=true aber DEV_IP_ALLOWLIST leer', () => {
    const env = validProdEnv();
    env.DEV_IP_ALLOWLIST = '';
    const errors = collectProductionEnvErrors(env);
    expect(errors.some((e) => e.includes('DEV_IP_ALLOWLIST ist leer'))).toBe(true);
  });

  it('macht in Nicht-Production keine Vorgaben (collect liefert dennoch Liste, assert greift nicht)', () => {
    // collectProductionEnvErrors prueft die Regeln unabhaengig von NODE_ENV;
    // der NODE_ENV-Gate sitzt in assertProductionEnv. Hier nur Doku-Test:
    const env = validProdEnv();
    env.NODE_ENV = 'development';
    // Selbst mit dev: die reinen Regeln bleiben gleich -> gueltige Basis = []
    expect(collectProductionEnvErrors(env)).toEqual([]);
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
  // Lazy-Import: setzt Pflicht-Env, bevor config geladen wird.
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
    // PNG-Bytes, aber als image/jpeg deklariert -> reject
    expect(verifyMagicNumber('image/jpeg', PNG)).toBe(false);
    // Reiner Text als image/png deklariert -> reject
    expect(verifyMagicNumber('image/png', Buffer.from('<?xml version="1.0"?>plain', 'ascii'))).toBe(false);
    // Zu kurzer Buffer -> reject
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
