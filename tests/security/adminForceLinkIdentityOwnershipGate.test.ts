import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/linking/adminForceLink.ts'), 'utf8');

describe('admin force-link ownership gate', () => {
  it('checks both name and resolved identity ownership before writing', () => {
    expect(source).toContain("reason: 'PLAYER_NAME_TAKEN'");
    expect(source).toContain("reason: 'IDENTITY_TAKEN'");
    expect(source).toContain('forcedPlayerName');
    expect(source).toContain('identityHash');
  });

  it('scopes every conflict check to the target Nitrado connection, not just the guild', () => {
    // Ohne nitradoConnId-Scope wuerde eine auf Server A gebundene GUID/Name ein
    // legitimes Force-Link fuer einen anderen Nutzer auf Server B derselben
    // Guild faelschlich blockieren (DB-Unique-Constraint ist guildId+nitradoConnId+... scoped).
    expect(source).toContain(
      'SELECT DISTINCT "gameId" FROM "PlayerSession" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "playerName"=$3',
    );
    expect(source).toContain(
      'SELECT "userDiscordId" FROM "GameIdentityLink" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "identityHash"=$3 AND "status"=',
    );
    expect(source).toContain('AND "userDiscordId"<>$4 LIMIT 1 FOR UPDATE');
    expect(source.match(/"identityHash"=\$3 AND "status"=.*?"userDiscordId"<>\$4/g)?.length).toBe(2);
  });
});
