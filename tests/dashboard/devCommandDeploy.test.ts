process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireDev: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../src/dashboard/middleware/devSecurity', () => ({ logDevAction: jest.fn() }));
jest.mock('../../src/dashboard/clientRegistry', () => ({ tryGetDashboardClient: jest.fn() }));
jest.mock('../../src/commands/handler', () => ({
  loadCommands: jest.fn(),
  deployCommandsScoped: jest.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { deployCommandsScoped, loadCommands } from '../../src/commands/handler';
import { devCommandDeployRouter } from '../../src/dashboard/routes/v2/devCommandDeploy';

const clientMock = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;
const deployMock = deployCommandsScoped as jest.MockedFunction<typeof deployCommandsScoped>;
const loadMock = loadCommands as jest.MockedFunction<typeof loadCommands>;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(devCommandDeployRouter);
  return instance;
}

function installClient() {
  clientMock.mockReturnValue({
    commands: { size: 10 },
    guilds: { cache: new Map([
      ['123456789012345678', {}],
      ['223456789012345678', {}],
    ]) },
  } as never);
}

describe('DEV command deploy route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installClient();
  });

  it('ist der einzige Command-Reload-Handler und laesst keinen shadowed Legacy-Pfad im Sammelrouter stehen', () => {
    const commandCenter = fs.readFileSync(
      path.resolve(process.cwd(), 'src/dashboard/routes/v2/devCommandCenter.ts'),
      'utf8',
    );
    expect(commandCenter).not.toContain("devCommandCenterRouter.post('/commands/reload'");
  });

  it('meldet Guild-Teilfehler als HTTP-Fehler statt gruenem Erfolg', async () => {
    deployMock.mockResolvedValue({
      globalCount: 1,
      guildCount: 20,
      guildsOk: 1,
      guildsFailed: 1,
      failedGuildIds: ['223456789012345678'],
    });

    const res = await request(app()).post('/commands/reload').send({ scope: 'deploy', reason: 'test' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ guildsOk: 1, guildsFailed: 1, failedGuildIds: ['223456789012345678'] });
    expect(String(res.body.error)).toMatch(/unvollständig/i);
  });

  it('liefert bei komplettem Deploy Erfolg', async () => {
    deployMock.mockResolvedValue({
      globalCount: 1,
      guildCount: 20,
      guildsOk: 2,
      guildsFailed: 0,
      failedGuildIds: [],
    });

    const res = await request(app()).post('/commands/reload').send({ scope: 'deploy', reason: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.guildsFailed).toBe(0);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('laedt bei scope=all vor dem Deploy neu', async () => {
    deployMock.mockResolvedValue({
      globalCount: 1,
      guildCount: 20,
      guildsOk: 2,
      guildsFailed: 0,
      failedGuildIds: [],
    });

    const res = await request(app()).post('/commands/reload').send({ scope: 'all', reason: 'test' });
    expect(res.status).toBe(200);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('failt geschlossen wenn der Discord-Client nicht verfuegbar ist', async () => {
    clientMock.mockReturnValue(null);
    const res = await request(app()).post('/commands/reload').send({ scope: 'deploy', reason: 'test' });
    expect(res.status).toBe(503);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('blockiert einen zweiten gleichzeitigen Reload mit 409 statt races auf der Command-Registry', async () => {
    let releaseDeploy!: () => void;
    const gate = new Promise<void>((resolve) => { releaseDeploy = resolve; });
    deployMock.mockImplementation(async () => {
      await gate;
      return { globalCount: 1, guildCount: 20, guildsOk: 2, guildsFailed: 0, failedGuildIds: [] };
    });

    const instance = app();
    // supertest-Requests sind "thenable" und starten erst beim Awaiten/`.end()`;
    // ueber `.end()` mit Callback in ein Promise verpackt, um den Request sofort
    // (synchron) auszuloesen statt lazy erst beim spaeteren `await`.
    function post(): Promise<request.Response> {
      return new Promise((resolve, reject) => {
        request(instance)
          .post('/commands/reload')
          .send({ scope: 'deploy', reason: 'test' })
          .end((err, res) => {
            if (err && !res) reject(err);
            else resolve(res);
          });
      });
    }

    const first = post();
    // Sicherstellen, dass der erste Request den Lock bereits gesetzt hat, bevor der zweite startet.
    await new Promise((resolve) => setImmediate(resolve));
    const second = await post();

    expect(second.status).toBe(409);
    expect(deployMock).toHaveBeenCalledTimes(1);

    releaseDeploy();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);

    const third = await post();
    expect(third.status).toBe(200);
  });
});
