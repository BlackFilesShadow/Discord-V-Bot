import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  parseServerBanJobPayload,
  type BanOutboxClient,
} from '../../src/modules/bans/banOutbox';
import { decrypt } from '../../src/utils/security';

const KEY = '0'.repeat(64);
const SCOPE = { guildId: 'guild-a', nitradoConnId: 'conn-a' };

function makeClient(existingPayloads: unknown[] = []) {
  const create = jest.fn(async (_args: unknown) => ({}));
  const findMany = jest.fn(async (_args: unknown) => existingPayloads.map(payload => ({ payload })));
  const client: BanOutboxClient = { nitradoJob: { findMany, create } };
  return { client, findMany, create };
}

describe('Server-Ban Outbox', () => {
  it('speichert ADD-Identifier nur verschluesselt', async () => {
    const { client, create } = makeClient();
    const raw = '76561198000000000';

    await expect(enqueueServerBanAdd(client, SCOPE, 'ban-1', raw, KEY)).resolves.toBe(true);
    const args = create.mock.calls[0][0] as { data: { operation: string; payload: unknown } };
    expect(args.data.operation).toBe('SERVER_BAN_ADD');
    const payload = parseServerBanJobPayload(args.data.payload);
    expect(payload.banId).toBe('ban-1');
    expect(payload.encryptedIdentifier).toBeDefined();
    expect(payload.encryptedIdentifier).not.toContain(raw);
    expect(decrypt(payload.encryptedIdentifier!, KEY)).toBe(raw);
  });

  it('REMOVE persistiert nur die Ban-ID', async () => {
    const { client, create } = makeClient();

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(true);
    const args = create.mock.calls[0][0] as { data: { operation: string; payload: unknown } };
    expect(args.data.operation).toBe('SERVER_BAN_REMOVE');
    expect(args.data.payload).toEqual({ banId: 'ban-1' });
  });

  it('dedupliziert aktive Jobs derselben Operation+Ban-ID', async () => {
    const { client, create } = makeClient([{ banId: 'ban-1' }]);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('lehnt ungueltige Payloads ab', () => {
    expect(() => parseServerBanJobPayload({})).toThrow('Ungueltige Server-Ban-Job-Payload');
  });
});
