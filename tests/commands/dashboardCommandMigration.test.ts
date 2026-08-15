import fs from 'node:fs';
import path from 'node:path';
import {
  classifyCommand,
  MOVED_TO_DASHBOARD,
  PRESERVED_MANUFACTURER_COMMANDS,
} from '../../src/commands/inventory';

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

describe('Dashboard command migration completeness', () => {
  it('laesst keinen adminOnly/devOnly Slash-Command ausser der Hersteller-Ausnahme im Loader-Pfad', () => {
    const root = path.resolve(process.cwd(), 'src/commands');
    const violations = walk(root)
      .filter(file => file !== path.join(root, 'developer', 'devManufacturer.ts'))
      .filter(file => {
        const src = fs.readFileSync(file, 'utf8');
        return /\badminOnly\s*:\s*true\b/.test(src) || /\bdevOnly\s*:\s*true\b/.test(src);
      })
      .map(file => path.relative(root, file));
    expect(violations).toEqual([]);
  });

  it('behaelt Hersteller-Kommandos ausdruecklich in Discord', () => {
    expect(PRESERVED_MANUFACTURER_COMMANDS).toContain('dev-manufacturer');
    expect(classifyCommand({ name: 'dev-manufacturer', source: 'developer/devManufacturer.ts', devOnly: true })).toMatchObject({
      target: 'discord', migrationStatus: 'active', staysInDiscord: true,
    });
    expect(classifyCommand({ name: 'upload', source: 'user/upload.ts', manufacturerOnly: true })).toMatchObject({
      target: 'discord', migrationStatus: 'active', staysInDiscord: true,
    });
    expect(classifyCommand({ name: 'mypackages', source: 'user/mypackages.ts', manufacturerOnly: true })).toMatchObject({
      target: 'discord', migrationStatus: 'active', staysInDiscord: true,
    });
  });

  it('markiert alle entfernten Admin-/DEV-Slash-Namen als dashboard-migriert', () => {
    const expected = [
      'admin-aimodels', 'admin-audit', 'admin-config', 'admin-delete', 'admin-error-report',
      'admin-export', 'admin-feedback', 'admin-knowledge', 'admin-list-pakete', 'admin-logs',
      'admin-monitor', 'admin-security', 'admin-stats', 'admin-validate', 'ai-trigger', 'xp-config',
      'dev-admin', 'dev-db', 'dev-eval', 'dev-login', 'dev-reload', 'ping', 'status',
    ];
    for (const name of expected) expect(MOVED_TO_DASHBOARD).toContain(name);
  });
});
