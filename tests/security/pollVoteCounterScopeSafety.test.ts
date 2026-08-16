import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Poll-Reaction-Votes — Transaction-/Scope-Sicherheitsinvarianten', () => {
  const add = read('src/events/messageReactionAdd.ts');
  const remove = read('src/events/messageReactionRemove.ts');

  it('loescht alte Single-Choice-Votes und korrigiert den Counter atomar', () => {
    const transactionStart = add.indexOf('await prisma.$transaction(async tx => {');
    const deleteStart = add.indexOf('const deleted = await tx.pollVote.deleteMany', transactionStart);
    const updateStart = add.indexOf('const updated = await tx.poll.updateMany', deleteStart);
    expect(transactionStart).toBeGreaterThan(-1);
    expect(deleteStart).toBeGreaterThan(transactionStart);
    expect(updateStart).toBeGreaterThan(deleteStart);
  });

  it('scoppt den Single-Choice-Counter-Write auf Poll und Guild und nutzt die reale Delete-Anzahl', () => {
    expect(add).toContain('where: { id: poll.id, guildId }');
    expect(add).toContain('data: { totalVotes: { decrement: deleted.count } }');
    expect(add).toContain('if (updated.count !== 1)');
    expect(add).not.toContain('data: { totalVotes: { decrement: existingVotes.length } }');
  });

  it('zieht Reaction-Remove und Counter-Decrement in dieselbe Transaktion', () => {
    const transactionStart = remove.indexOf('const deletedCount = await prisma.$transaction(async tx => {');
    const deleteStart = remove.indexOf('const deleted = await tx.pollVote.deleteMany', transactionStart);
    const updateStart = remove.indexOf('const updated = await tx.poll.updateMany', deleteStart);
    expect(transactionStart).toBeGreaterThan(-1);
    expect(deleteStart).toBeGreaterThan(transactionStart);
    expect(updateStart).toBeGreaterThan(deleteStart);
  });

  it('scoppt auch Reaction-Remove auf Guild und verarbeitet nur tatsaechlich geloeschte Votes', () => {
    expect(remove).toContain('where: { id: poll.id, guildId }');
    expect(remove).toContain('data: { totalVotes: { decrement: deleted.count } }');
    expect(remove).toContain('return deleted.count;');
    expect(remove).toContain('if (deletedCount > 0)');
  });

  it('verwendet in den gehaerteten Counter-Pfaden kein ungescopptes prisma.poll.update mehr', () => {
    const addScopeStart = add.indexOf('// Vote-Loeschung + Counter-Korrektur');
    const addScopeEnd = add.indexOf('// Vorherige Emoji-Reaktionen', addScopeStart);
    const removeScopeStart = remove.indexOf('const deletedCount = await prisma.$transaction');
    const removeScopeEnd = remove.indexOf("logAudit('POLL_VOTE_REMOVED'", removeScopeStart);
    expect(add.slice(addScopeStart, addScopeEnd)).not.toContain('prisma.poll.update({');
    expect(remove.slice(removeScopeStart, removeScopeEnd)).not.toContain('prisma.poll.update({');
  });
});
