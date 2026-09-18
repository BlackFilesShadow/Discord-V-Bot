import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface CapturedWrite {
  method: string;
  body: Record<string, unknown> | null;
}

async function stubRestartPlanner(page: Page) {
  const writes: CapturedWrite[] = [];
  let plan: {
    enabled: boolean;
    mode: 'INTERVAL' | 'FIXED';
    intervalHours: number | null;
    startTime: string | null;
    times: string[];
    revision: number;
    syncStatus: 'PENDING' | 'SYNCED' | 'ERROR';
    lastSyncAt: string | null;
    lastSyncError: string | null;
    serviceBindingMatches: boolean;
  } | null = null;
  let restartTasks: Array<{
    id: number;
    time: string | null;
    hour: string;
    minute: string;
    day: string;
    month: string;
    weekday: string;
    lastRun: string | null;
    nextRun: string | null;
    timezone: string | null;
  }> = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'restart-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'restart-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: true, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });

    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      return json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: true,
        permissions: ['dashboard.access', 'nitrado.view', 'nitrado.write'],
        slots: [{ id: 'conn-restart-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE', nitradoServerId: '12345' }],
        grantsCount: 0,
      });
    }

    if (path === `/api/v2/guilds/${GUILD_ID}/nitrado-tasks/restart-plan`) {
      if (req.method() === 'PUT') {
        const body = req.postDataJSON() as Record<string, unknown>;
        writes.push({ method: 'PUT', body });
        const interval = Number(body.intervalHours);
        const start = String(body.startTime);
        const [hourRaw, minute] = start.split(':');
        const startHour = Number(hourRaw);
        const times = Array.from({ length: 24 / interval }, (_, index) => {
          const hour = String((startHour + index * interval) % 24).padStart(2, '0');
          return `${hour}:${minute}`;
        }).sort();
        plan = {
          enabled: true,
          mode: 'INTERVAL',
          intervalHours: interval,
          startTime: start,
          times,
          revision: 1,
          syncStatus: 'PENDING',
          lastSyncAt: null,
          lastSyncError: null,
          serviceBindingMatches: true,
        };
        return json(route, { ...plan });
      }
      return json(route, {
        plan,
        remote: {
          actionSupported: true,
          synchronized: false,
          restartTasks,
        },
      });
    }

    if (path === `/api/v2/guilds/${GUILD_ID}/nitrado-tasks/restart-tasks` && req.method() === 'DELETE') {
      writes.push({ method: 'DELETE', body: null });
      plan = {
        enabled: false,
        mode: 'INTERVAL',
        intervalHours: 4,
        startTime: '00:15',
        times: [],
        revision: 2,
        syncStatus: 'PENDING',
        lastSyncAt: null,
        lastSyncError: null,
        serviceBindingMatches: true,
      };
      restartTasks = [];
      return json(route, { enabled: false, times: [], revision: 2, syncStatus: 'PENDING' });
    }

    return json(route, {});
  });

  return { writes };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('PAGE 2 Nitrado restart planner', () => {
  test('zeigt live die exakten 4-Stunden-Uhrzeiten und sendet nur die kanonische Eingabe', async ({ page }) => {
    const { writes } = await stubRestartPlanner(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=restart-tasks`);

    await expect(page.getByText('Automatische Nitrado-Neustarts')).toBeVisible();
    await expect(page.getByText('Live-Vorschau')).toBeVisible();

    await page.getByLabel('Intervall').selectOption('4');
    await page.getByLabel('Erste Uhrzeit').fill('00:15');

    for (const time of ['0:15', '4:15', '8:15', '12:15', '16:15', '20:15']) {
      await expect(page.getByText(time, { exact: true })).toBeVisible();
    }

    await page.getByRole('button', { name: 'Bei Nitrado speichern' }).click();

    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      method: 'PUT',
      body: { mode: 'INTERVAL', intervalHours: 4, startTime: '00:15' },
    });
    await expect(page.getByText('Synchronisierung gestartet')).toBeVisible();
  });

  test('feste Uhrzeiten bleiben normale Uhrzeiten ohne rohe Cron-/Minutenfelder', async ({ page }) => {
    await stubRestartPlanner(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=restart-tasks`);

    await page.getByLabel('Planungsart').selectOption('FIXED');
    await page.getByLabel('Uhrzeit hinzufügen').fill('04:30');
    await page.getByRole('button', { name: 'Hinzufügen' }).click();

    await expect(page.getByText('4:30', { exact: true })).toBeVisible();
    await expect(page.getByText('Cron', { exact: false })).toHaveCount(0);
    await expect(page.getByText('Minutenvariable', { exact: false })).toHaveCount(0);
  });

  test('die bewusste Bereinigung bestätigt und löscht alle Restart-Aufgaben über den Remote-API-Pfad', async ({ page }) => {
    const state = await stubRestartPlanner(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=restart-tasks`);

    // Die Löschaktion ist nur aktiv, wenn Nitrado tatsächlich mindestens einen
    // Restart-Task bestätigt. Für den UI-Flow simulieren wir den Remote-Task
    // direkt über einen zweiten Route-State-Reload.
    await page.route(`**/api/v2/guilds/${GUILD_ID}/nitrado-tasks/restart-plan?slot=${SLOT}`, route => json(route, {
      plan: null,
      remote: {
        actionSupported: true,
        synchronized: false,
        restartTasks: [{
          id: 77,
          time: '04:00',
          hour: '4',
          minute: '0',
          day: '*',
          month: '*',
          weekday: '*',
          lastRun: null,
          nextRun: '2026-09-18T04:00:00+02:00',
          timezone: 'Europe/Berlin',
        }],
      },
    }));
    await page.reload();

    await page.getByRole('button', { name: 'Alle Restart-Aufgaben löschen' }).click();
    await expect(page.getByText('Restart-Aufgaben wirklich bereinigen?')).toBeVisible();
    await expect(page.getByText('Andere automatische Aufgaben bleiben erhalten.')).toBeVisible();
    await page.getByRole('button', { name: 'Ja, alle Restart-Aufgaben löschen' }).click();

    await expect.poll(() => state.writes.some(write => write.method === 'DELETE')).toBe(true);
  });

  for (const width of [320, 390, 430]) {
    test(`${width}px: Live-Vorschau bleibt ohne Seiten-Overflow`, async ({ page }) => {
      await stubRestartPlanner(page);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=restart-tasks`);
      await expect(page.getByText('Live-Vorschau')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
