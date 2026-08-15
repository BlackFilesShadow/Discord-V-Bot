process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { xpConfig: { findUnique: jest.fn() } },
}));

import express from 'express';
import request from 'supertest';
import prisma from '../../src/database/prisma';
import { guardDevXpMutationInput } from '../../src/dashboard/middleware/devXpMutationInputGuard';

const findMock = prisma.xpConfig.findUnique as jest.Mock;
const GUILD = '123456789012345678';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/dev/command-center', guardDevXpMutationInput, (_req, res) => res.status(204).end());
  return instance;
}

describe('DEV XP mutation input guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMock.mockResolvedValue(null);
  });

  it('blockiert ungueltige Zahlen vor dem nachfolgenden Business-Handler', async () => {
    for (const body of [
      { messageXpMin: -1 },
      { messageXpMax: 10001 },
      { voiceXpPerMinute: 1.5 },
      { maxLevel: 0 },
      { levelMultiplier: 101 },
    ]) {
      const res = await request(app()).patch(`/dev/command-center/xp/${GUILD}`).send(body);
      expect(res.status).toBe(400);
    }
  });

  it('verwendet bei fehlender Config die Prisma-Defaults 15/25 fuer Min-Max-Validierung', async () => {
    const invalid = await request(app())
      .patch(`/dev/command-center/xp/${GUILD}`)
      .send({ messageXpMin: 30 });
    expect(invalid.status).toBe(400);
    expect(findMock).toHaveBeenCalledWith({
      where: { id: GUILD },
      select: { messageXpMin: true, messageXpMax: true },
    });

    const valid = await request(app())
      .patch(`/dev/command-center/xp/${GUILD}`)
      .send({ messageXpMin: 20 });
    expect(valid.status).toBe(204);
  });

  it('validiert einseitige Updates gegen bereits persistierte Bounds', async () => {
    findMock.mockResolvedValue({ messageXpMin: 10, messageXpMax: 40 });
    expect((await request(app()).patch(`/dev/command-center/xp/${GUILD}`).send({ messageXpMin: 41 })).status).toBe(400);
    expect((await request(app()).patch(`/dev/command-center/xp/${GUILD}`).send({ messageXpMax: 9 })).status).toBe(400);
    expect((await request(app()).patch(`/dev/command-center/xp/${GUILD}`).send({ messageXpMin: 11, messageXpMax: 39 })).status).toBe(204);
  });

  it('ignoriert Nicht-XP- und Nicht-PATCH-Routen', async () => {
    expect((await request(app()).get(`/dev/command-center/xp/${GUILD}`)).status).toBe(204);
    expect((await request(app()).patch('/dev/command-center/config/foo').send({ value: 1 })).status).toBe(204);
    expect(findMock).not.toHaveBeenCalled();
  });
});
