import { verifyLinkChallengesInAdmText } from '../../src/modules/linking/admChallengeVerifier';
import type { LinkClient } from '../../src/modules/linking/linkService';

const findFirst = jest.fn(async (_args: unknown) => null);
const updateMany = jest.fn(async (_args: unknown) => ({ count: 0 }));
const upsert = jest.fn(async (_args: unknown) => ({}));
const client: LinkClient = { gameIdentityLink: { findFirst, updateMany, upsert } };

it('deaktiviert den alten Ingame-Chat-Challenge-Flow vollstaendig', async () => {
  const result = await verifyLinkChallengesInAdmText(
    client,
    { guildId: 'guild-1', nitradoConnId: 'conn-1' },
    '12:00:00 | Player "Alice"(id=guid-1) says "ABCD2345"',
    's'.repeat(64),
    new Date('2026-08-16T00:00:00.000Z'),
  );

  expect(result).toEqual({ candidates: 0, verified: 0 });
  expect(findFirst).not.toHaveBeenCalled();
  expect(updateMany).not.toHaveBeenCalled();
  expect(upsert).not.toHaveBeenCalled();
});
