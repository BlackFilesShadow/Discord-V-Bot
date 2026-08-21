import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));
const repository = read('src/modules/economy/repository.ts');
const linkRewards = read('src/modules/linking/linkRewards.ts');
const interest = read('src/modules/economy/bankInterest.ts');

describe('Leave-1C immutable economy key privacy regression', () => {
  it('uses the stable economy subject for all user-derived startbalance keys', () => {
    expect(repository).toContain('const subjectKey = economySubjectKey');
    expect(repository).toContain('`startbalance:${guildId}:${nitradoConnId}:${subjectKey}`');
    expect(repository).not.toContain('`startbalance:${guildId}:${nitradoConnId}:${userDiscordId}`');
    expect(linkRewards).toContain('`startbalance:link:${scope.guildId}:${scope.nitradoConnId}:${subjectKey}`');
    expect(linkRewards).not.toContain('`startbalance:link:${scope.guildId}:${scope.nitradoConnId}:${userDiscordId}`');
  });

  it('uses a pseudonymous subject for interest/deposit/withdraw immutable keys', () => {
    expect(interest).toContain('economySubjectKey(args.guildId, a.userDiscordId');
    expect(interest).not.toContain('${a.userDiscordId}`');
    expect(repository).toContain('`deposit:${guildId}:${nitradoConnId}:${subjectKey}:${randomUUID()}`');
    expect(repository).toContain('`withdraw:${guildId}:${nitradoConnId}:${subjectKey}:${randomUUID()}`');
  });
});
