import { verifyLinkChallengesInAdmText } from '../../src/modules/linking/admChallengeVerifier';
import type { LinkClient } from '../../src/modules/linking/linkService';

function makeClient(code = 'ABCD2345') {
  const row = {
    userDiscordId: '123456789012345678',
    identityHash: null,
    status: 'PENDING' as const,
    challengeCode: code,
    challengeExpiresAt: new Date('2026-08-14T10:10:00.000Z'),
  };
  const findFirst = jest.fn(async (args: any) => {
    const requested = args?.where?.challengeCode;
    return requested === code ? row : null;
  });
  const updateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
  const upsert = jest.fn(async (_args: unknown) => ({}));
  const client: LinkClient = { gameIdentityLink: { findFirst, updateMany, upsert } };
  return { client, findFirst, updateMany };
}

const scope = { guildId: '987654321098765432', nitradoConnId: 'conn-1' };
const now = new Date('2026-08-14T10:00:00.000Z');

it('verifiziert einen gueltigen eigenstaendigen Challenge-Code zusammen mit game id', async () => {
  const { client, updateMany } = makeClient();
  const content = '12:00:00 | Player "Alice"(id=76561198000000000) says "ABCD2345"';

  const result = await verifyLinkChallengesInAdmText(client, scope, content, 's'.repeat(64), now);

  expect(result).toEqual({ candidates: 1, verified: 1 });
  expect(updateMany).toHaveBeenCalledTimes(1);
  expect(updateMany.mock.calls[0][0]).toEqual(expect.objectContaining({
    where: expect.objectContaining({
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId: '123456789012345678',
      status: 'PENDING',
    }),
  }));
});

it('ignoriert Zeilen ohne Spielidentitaet oder ohne Challenge-Kandidaten', async () => {
  const { client, findFirst, updateMany } = makeClient();
  const content = [
    '12:00:00 | Player "Alice" connected',
    '12:00:01 | Player "Alice"(id=76561198000000000) connected',
    '12:00:02 | Server message ABCD2345',
  ].join('\n');

  const result = await verifyLinkChallengesInAdmText(client, scope, content, 's'.repeat(64), now);

  expect(result).toEqual({ candidates: 0, verified: 0 });
  expect(findFirst).not.toHaveBeenCalled();
  expect(updateMany).not.toHaveBeenCalled();
});

it('verifiziert keinen zufaelligen achtstelligen Token ohne passende PENDING-Challenge', async () => {
  const { client, updateMany } = makeClient('ABCD2345');
  const content = '12:00:00 | Player "Alice"(id=76561198000000000) says "WXYZ6789"';

  const result = await verifyLinkChallengesInAdmText(client, scope, content, 's'.repeat(64), now);

  expect(result).toEqual({ candidates: 1, verified: 0 });
  expect(updateMany).not.toHaveBeenCalled();
});
