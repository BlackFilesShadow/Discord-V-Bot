const txMock = {
  $queryRawUnsafe: jest.fn(),
  poll: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  pollVote: {
    findMany: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
  poll: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  pollVote: {
    groupBy: jest.fn(),
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { endPoll, togglePollVote, votePoll } from '../../src/modules/polls/pollSystem';

const ACTIVE_POLL = {
  id: 'poll-1',
  guildId: 'guild-1',
  status: 'ACTIVE',
  endsAt: new Date(Date.now() + 60_000),
  options: [
    { id: 'opt_0', text: 'A', emoji: '1' },
    { id: 'opt_1', text: 'B', emoji: '2' },
  ],
  allowMultiple: false,
  maxChoices: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  txMock.$queryRawUnsafe.mockResolvedValue([]);
  txMock.pollVote.count.mockResolvedValue(1);
  txMock.poll.update.mockResolvedValue({});
});

describe('Poll voting/finalization atomicity', () => {
  it('serialisiert Vote-Pruefung + Insert + exakten Counter unter demselben DB-Lock', async () => {
    txMock.poll.findFirst.mockResolvedValue(ACTIVE_POLL);
    txMock.pollVote.findMany.mockResolvedValue([]);
    txMock.pollVote.create.mockResolvedValue({ id: 'vote-1' });

    const result = await votePoll('poll-1', 'user-1', 'opt_0', 'guild-1');

    expect(result.success).toBe(true);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'poll:poll-1',
    );
    expect(txMock.pollVote.create).toHaveBeenCalledWith({
      data: { pollId: 'poll-1', userId: 'user-1', optionId: 'opt_0' },
    });
    expect(txMock.pollVote.count).toHaveBeenCalledWith({ where: { pollId: 'poll-1' } });
    expect(txMock.poll.update).toHaveBeenCalledWith({
      where: { id: 'poll-1' },
      data: { totalVotes: 1 },
    });
  });

  it('blockiert eine zweite Slash-Stimme bei allowMultiple=false vor jeder Mutation', async () => {
    txMock.poll.findFirst.mockResolvedValue(ACTIVE_POLL);
    txMock.pollVote.findMany.mockResolvedValue([{ id: 'vote-old', optionId: 'opt_1' }]);

    const result = await votePoll('poll-1', 'user-1', 'opt_0', 'guild-1');

    expect(result.success).toBe(false);
    expect(txMock.pollVote.create).not.toHaveBeenCalled();
    expect(txMock.poll.update).not.toHaveBeenCalled();
  });

  it('wechselt Single-Choice beim Button atomar statt Delete und Vote zu trennen', async () => {
    txMock.poll.findFirst.mockResolvedValue(ACTIVE_POLL);
    txMock.pollVote.findMany.mockResolvedValue([{ id: 'vote-old', optionId: 'opt_1' }]);
    txMock.pollVote.create.mockResolvedValue({ id: 'vote-new' });
    txMock.pollVote.deleteMany.mockResolvedValue({ count: 1 });

    const result = await togglePollVote('poll-1', 'user-1', 'opt_0', 'guild-1');

    expect(result).toEqual(expect.objectContaining({ success: true, action: 'ADDED' }));
    expect(txMock.pollVote.deleteMany).toHaveBeenCalledWith({ where: { pollId: 'poll-1', userId: 'user-1' } });
    expect(txMock.pollVote.create).toHaveBeenCalledWith({
      data: { pollId: 'poll-1', userId: 'user-1', optionId: 'opt_0' },
    });
    expect(txMock.pollVote.count).toHaveBeenCalled();
  });

  it('entfernt einen Button-Vote unter demselben Lock und synchronisiert den Counter', async () => {
    txMock.poll.findFirst.mockResolvedValue({ ...ACTIVE_POLL, allowMultiple: true, maxChoices: 3 });
    txMock.pollVote.findMany.mockResolvedValue([{ id: 'vote-old', optionId: 'opt_0' }]);
    txMock.pollVote.count.mockResolvedValue(0);
    txMock.pollVote.delete.mockResolvedValue({});

    const result = await togglePollVote('poll-1', 'user-1', 'opt_0', 'guild-1');

    expect(result).toEqual(expect.objectContaining({ success: true, action: 'REMOVED' }));
    expect(txMock.pollVote.delete).toHaveBeenCalledWith({ where: { id: 'vote-old' } });
    expect(txMock.poll.update).toHaveBeenCalledWith({
      where: { id: 'poll-1' },
      data: { totalVotes: 0 },
    });
  });

  it('finalisiert DB-Status nicht, wenn die kritische Discord-Ausgabe fehlschlaegt', async () => {
    txMock.poll.findFirst.mockResolvedValue({
      ...ACTIVE_POLL,
      title: 'Test',
      votes: [{ optionId: 'opt_0' }],
    });
    const publish = jest.fn().mockRejectedValue(new Error('discord down'));

    await expect(endPoll('poll-1', 'guild-1', publish)).rejects.toThrow('discord down');

    expect(publish).toHaveBeenCalledTimes(1);
    expect(txMock.poll.update).not.toHaveBeenCalled();
  });

  it('setzt ENDED erst nach erfolgreicher kritischer Ausgabe', async () => {
    txMock.poll.findFirst.mockResolvedValue({
      ...ACTIVE_POLL,
      title: 'Test',
      votes: [{ optionId: 'opt_0' }, { optionId: 'opt_0' }],
    });
    const order: string[] = [];
    const publish = jest.fn(async () => { order.push('publish'); });
    txMock.poll.update.mockImplementation(async () => { order.push('db'); return {}; });

    const result = await endPoll('poll-1', 'guild-1', publish);

    expect(result.totalVotes).toBe(2);
    expect(order).toEqual(['publish', 'db']);
    expect(txMock.poll.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ENDED', totalVotes: 2 }),
    }));
  });
});
