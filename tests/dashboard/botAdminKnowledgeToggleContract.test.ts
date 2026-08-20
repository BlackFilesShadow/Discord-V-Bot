import express from 'express';
import request from 'supertest';

const knowledge = {
  addKnowledge: jest.fn(),
  exportKnowledge: jest.fn(),
  importKnowledge: jest.fn(),
  listKnowledgeAdmin: jest.fn(),
  reembedKnowledge: jest.fn(),
  regenerateAiBrief: jest.fn(),
  removeKnowledge: jest.fn(),
  setKnowledgeActive: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  setPersonaOverride: jest.fn(),
  updateKnowledge: jest.fn(),
};

jest.mock('../../src/modules/ai/guildKnowledge', () => knowledge);
jest.mock('../../src/modules/ai/knowledgeScope', () => ({ listKnowledgeGameservers: jest.fn().mockResolvedValue([]) }));
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { guildProfile: { findUnique: jest.fn().mockResolvedValue(null) } },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logAuditDb: jest.fn(),
  logger: { error: jest.fn() },
}));

import { botAdminKnowledgeRouter } from '../../src/dashboard/routes/v2/botAdminKnowledge';

const GID = '123456789012345678';
const ID = '11111111-1111-4111-8111-111111111111';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = {
      userId: '22222222-2222-4222-8222-222222222222',
      discordId: '437718598876268545',
      role: 'DEVELOPER',
    };
    next();
  });
  instance.use('/api/v2/bot-admin/knowledge', botAdminKnowledgeRouter);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  knowledge.setKnowledgeActive.mockResolvedValue({ ok: true, message: 'ok' });
});

describe('Dashboard-1X canonical knowledge toggle contract', () => {
  it.each([{}, { active: 'false' }, { active: 0 }, { active: null }])('rejects malformed active payload %#', async body => {
    const r = await request(app())
      .post(`/api/v2/bot-admin/knowledge/${ID}/toggle?guildId=${GID}`)
      .send(body);

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/true oder false/);
    expect(knowledge.setKnowledgeActive).not.toHaveBeenCalled();
  });

  it.each([true, false])('preserves exact boolean active=%s', async active => {
    const r = await request(app())
      .post(`/api/v2/bot-admin/knowledge/${ID}/toggle?guildId=${GID}`)
      .send({ active });

    expect(r.status).toBe(200);
    expect(knowledge.setKnowledgeActive).toHaveBeenCalledWith(GID, ID, active);
  });
});
