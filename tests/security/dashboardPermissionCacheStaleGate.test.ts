import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const liveUpdatesSource = read('dashboard-ui/src/lib/useGuildLiveUpdates.ts');
const botAdminPageSource = read('dashboard-ui/src/pages/BotAdmin.tsx');

/**
 * Subsystem-Review des Dashboard-Frontends fand zwei "stale privileged UI"
 * Bugs: nach einem Rechte-Entzug blieben die privilegierten Tabs/Aktionen
 * fuer den betroffenen Nutzer sichtbar, bis er die Seite manuell neu laedt
 * (Backend lehnt die Aktion zwar korrekt mit 403 ab, aber die UI zeigt bis
 * dahin einen falschen Zustand). Diese Tests pinnen die Fixes.
 */
describe('Dashboard permission-cache staleness gate', () => {
  test('permissions.updated invalidiert auch die davon abgeleiteten dashboard/dashboard-slot-meta Caches', () => {
    // hasFullAccess (Permissions/Aliase/Audit-Log-Tabs) haengt an ['dashboard', guildId],
    // canManage fuer Killfeed/Radar/Black-Market/Lotterie haengt an
    // ['dashboard-slot-meta', guildId, slot] - beide werden vom selben
    // Backend-Endpunkt aus Permissions abgeleitet und muessen deshalb bei
    // jedem permissions.updated-Event mit invalidiert werden, nicht nur
    // ['permissions', guildId] selbst.
    const handlerBlock = liveUpdatesSource.match(/'permissions\.updated':.*/)?.[0] ?? '';
    expect(handlerBlock).toContain("['permissions', guildId]");
    expect(handlerBlock).toContain("['dashboard', guildId]");
    expect(handlerBlock).toContain("['dashboard-slot-meta', guildId]");
  });

  test('dashboard-slot-meta ist auch im Reconnect-Invalidierungs-Set enthalten', () => {
    const allKeysBlock = liveUpdatesSource.match(/const allKeys: readonly string\[\]\[\] = \[[\s\S]*?\];/)?.[0] ?? '';
    expect(allKeysBlock).toContain("['dashboard-slot-meta', guildId]");
  });

  test('BotAdminPage rendert die privilegierte Workspace erst nach bestaetigtem Server-Status (kein Hint-Flash)', () => {
    // Analog zu Dev.tsx's `if (dev.loading) return <...Status wird geprueft.../>`
    // - vorher fehlte dieses Gate hier komplett, obwohl useBotAdminSession
    // seinen `active`-State optimistisch aus einem sessionStorage-Hint seedet.
    expect(botAdminPageSource).toMatch(/if \(ba\.loading\)\s*\{\s*return \(/);
    const loadingIndex = botAdminPageSource.indexOf('if (ba.loading)');
    const activeCheckIndex = botAdminPageSource.indexOf('if (!ba.active)');
    // Es gibt zwei `<BotAdminWorkspace`-Stellen (DevBotAdminPage ungegatet per
    // Design, und BotAdminPage's eigener gegateter Render) - die zweite (nach
    // dem ba.active-Check) ist die relevante.
    const workspaceIndex = botAdminPageSource.indexOf('<BotAdminWorkspace', activeCheckIndex);
    expect(loadingIndex).toBeGreaterThan(-1);
    expect(loadingIndex).toBeLessThan(activeCheckIndex);
    expect(activeCheckIndex).toBeLessThan(workspaceIndex);
  });
});
