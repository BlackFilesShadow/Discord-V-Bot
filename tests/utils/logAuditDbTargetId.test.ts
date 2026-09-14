const createAuditLog = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    auditLog: { create: (...args: unknown[]) => createAuditLog(...args) },
  },
}));

import { logAuditDb } from '../../src/utils/logger';

async function flushAuditWrite(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  createAuditLog.mockResolvedValue({ id: 'audit-row' });
});

describe('logAuditDb targetId persistence contract', () => {
  it('persists only the supplied internal User.id in AuditLog.targetId while retaining the Discord ID in details', async () => {
    logAuditDb('BOTADMIN_TICKET_REPLY', 'TICKET', {
      actorUserId: 'actor-internal-id',
      targetUserId: 'recipient-internal-id',
      details: { targetDiscordId: '1498019924424130666' },
    });

    await flushAuditWrite();

    expect(createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'actor-internal-id',
        targetId: 'recipient-internal-id',
        details: expect.objectContaining({ targetDiscordId: '1498019924424130666' }),
      }),
    });
    expect(createAuditLog.mock.calls[0][0].data.targetId).not.toBe('1498019924424130666');
  });
});
