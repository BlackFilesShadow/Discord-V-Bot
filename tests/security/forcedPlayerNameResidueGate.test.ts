import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Regressionsschutz fuer einen Reste-Bug: `forcedPlayerName` lebt nur in einer
 * Rohmigration (20260828214500), nicht im Prisma-Schema, und wurde deshalb vom
 * normalen `unlinkUser`-Update sowie vom normalen `linkByPlayerName`-Upsert nie
 * mitgeloescht. Eine ganz normale `/unlink` (oder die Dashboard-DELETE-Route)
 * liess so einen alten Force-Link-Namen stehen; sobald derselbe Discord-Account
 * sich spaeter ganz normal mit einem VOELLIG ANDEREN Spieler verlinkte, wurde
 * die Zeile wieder VERIFIED+forcedPlayerName und belegte den server-eindeutigen
 * `GameIdentityLink_scope_forced_player_name_verified_key`-Index fuer den
 * laengst nicht mehr zutreffenden alten Namen. Ein spaeterer, echter
 * `/force-link` dieses Namens auf einen ANDEREN Discord-Account schlug dadurch
 * faelschlich mit PLAYER_NAME_TAKEN fehl -- obwohl niemand mehr aktiv unter
 * diesem Namen force-verlinkt war.
 */
describe('forcedPlayerName residue gate (unlink must clear provisional force-link names)', () => {
  const adminForceLink = read('src/modules/linking/adminForceLink.ts');
  const linkingCommand = read('src/commands/dashboard/linking.ts');
  const economyLinkRoute = read('src/dashboard/routes/v2/economyLink.ts');

  it('exposes a shared helper that clears forcedPlayerName independent of force-unlink', () => {
    expect(adminForceLink).toContain('export async function clearProvisionalForcedPlayerName');
    expect(adminForceLink).toContain('SET "forcedPlayerName"=NULL');
    // forceAdminUnlinkUser muss den geteilten Helper nutzen statt eigenes SQL.
    expect(adminForceLink).toContain('const cleared = await clearProvisionalForcedPlayerName(scope, userDiscordId);');
  });

  it('regular /unlink clears any stale forcedPlayerName, not just force-unlink', () => {
    expect(linkingCommand).toContain("import { clearProvisionalForcedPlayerName } from '../../modules/linking/adminForceLink';");
    const unlinkBlock = linkingCommand.slice(linkingCommand.indexOf(".setName('unlink')"));
    expect(unlinkBlock).toContain('await deactivateLinkRewardState(rewardScope, scope.actorDiscordId);');
    expect(unlinkBlock.indexOf('await clearProvisionalForcedPlayerName(rewardScope, scope.actorDiscordId);'))
      .toBeGreaterThan(unlinkBlock.indexOf('await deactivateLinkRewardState(rewardScope, scope.actorDiscordId);'));
  });

  it('the dashboard economy-link DELETE route clears any stale forcedPlayerName too', () => {
    expect(economyLinkRoute).toContain(
      "import { clearProvisionalForcedPlayerName } from '../../../modules/linking/adminForceLink';",
    );
    const deleteBlock = economyLinkRoute.slice(economyLinkRoute.indexOf("delete('/:userDiscordId'"));
    expect(deleteBlock).toContain('await clearProvisionalForcedPlayerName(linkScope, target);');
  });
});
