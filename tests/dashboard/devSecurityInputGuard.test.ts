import express from 'express';
import request from 'supertest';
import { SecurityEventType } from '@prisma/client';
import { guardDevSecurityInput } from '../../src/dashboard/middleware/devSecurityInputGuard';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/dev/command-center', guardDevSecurityInput, (_req, res) => res.status(204).end());
  return instance;
}

describe('DEV security input guard', () => {
  it('akzeptiert ALL und jeden realen Prisma SecurityEventType', async () => {
    expect((await request(app()).get('/dev/command-center/security?type=ALL')).status).toBe(204);
    for (const type of Object.values(SecurityEventType)) {
      const res = await request(app()).get(`/dev/command-center/security?type=${type}`);
      expect(res.status).toBe(204);
    }
  });

  it('blockiert unbekannte Event-Typen vor Prisma', async () => {
    const res = await request(app()).get('/dev/command-center/security?type=NOT_A_REAL_EVENT');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Security-Event-Typ/i);
  });

  it('akzeptiert nur ganze durationHours von 0 bis 8760', async () => {
    for (const hours of [0, 1, 8760]) {
      const res = await request(app())
        .put('/dev/command-center/security/ip/127.0.0.1')
        .send({ durationHours: hours });
      expect(res.status).toBe(204);
    }

    for (const hours of [-1, 1.5, 8761]) {
      const res = await request(app())
        .put('/dev/command-center/security/ip/127.0.0.1')
        .send({ durationHours: hours });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ganze Zahl/i);
    }
  });

  it('laesst fehlende Dauer fuer permanente Eintraege unveraendert passieren', async () => {
    const res = await request(app())
      .put('/dev/command-center/security/ip/127.0.0.1')
      .send({ listType: 'WHITELIST' });
    expect(res.status).toBe(204);
  });
});
