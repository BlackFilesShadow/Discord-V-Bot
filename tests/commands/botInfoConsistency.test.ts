import { config } from '../../src/config';
import {
  BOT_PRODUCT_NAME,
  buildBotAboutText,
  buildBotFeaturesText,
  currentUploadLimitMiB,
} from '../../src/content/botInfo';

const REMOVED_PRIVILEGED_SLASH_NAMES = [
  '/admin-aimodels', '/admin-audit', '/admin-config', '/admin-delete',
  '/admin-error-report', '/admin-export', '/admin-feedback', '/admin-knowledge',
  '/admin-list-pakete', '/admin-logs', '/admin-monitor', '/admin-security',
  '/admin-stats', '/admin-validate', '/ai-trigger', '/xp-config',
  '/dev-admin', '/dev-db', '/dev-eval', '/dev-login', '/dev-reload',
];

describe('current public bot information', () => {
  it('uses the canonical product and developer identity', () => {
    const text = `${buildBotAboutText()}\n${buildBotFeaturesText()}`;
    expect(BOT_PRODUCT_NAME).toBe('V-Bot Prime');
    expect(text).toContain('Void_Architect');
  });

  it('derives the upload limit from live server configuration', () => {
    expect(currentUploadLimitMiB()).toBe(Math.max(1, Math.floor(config.upload.maxFileSizeBytes / 1024 / 1024)));
    expect(buildBotAboutText()).toContain(`${currentUploadLimitMiB()} MiB`);
  });

  it('advertises only the intentional Discord manufacturer exception and live help', () => {
    const text = `${buildBotAboutText()}\n${buildBotFeaturesText()}`;
    expect(text).toContain('/help');
    expect(text).toContain('/upload');
    expect(text).toContain('/mypackages');
    expect(text).toContain('Dashboard');
  });

  it('never re-advertises migrated privileged slash commands or stale limits', () => {
    const text = `${buildBotAboutText()}\n${buildBotFeaturesText()}`;
    for (const name of REMOVED_PRIVILEGED_SLASH_NAMES) expect(text).not.toContain(name);
    expect(text).not.toContain('2 GB');
    expect(text).not.toContain('Dashboard (Bald)');
    expect(text).not.toContain('NITRADO_ADM_DIR');
  });
});
