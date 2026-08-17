import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const removeSource = read('src/events/guildMemberRemove.ts');
const indexSource = read('src/index.ts');
const sagaSource = read('src/modules/moderation/leaveCleanupSaga.ts');

describe('Leave-1A production isolation', () => {
  it('does not wire the incomplete cleanup saga into guildMemberRemove yet', () => {
    expect(removeSource).not.toContain('leaveCleanupSaga');
    expect(removeSource).not.toContain('enqueueLeaveCleanupRequest');
  });

  it('does not start an incomplete cleanup worker from the process runtime', () => {
    expect(indexSource).not.toContain('startLeaveCleanup');
    expect(indexSource).not.toContain('leaveCleanupSaga');
  });

  it('documents that activation is forbidden until all destructive domains are connected', () => {
    expect(sagaSource).toContain('noch NICHT aus guildMemberRemove');
    expect(sagaSource).toContain('Whitelist/Nitrado, Linking, Economy und Stats');
  });

  it('reuses the existing persistent DataDeletionRequest deletion queue instead of adding a parallel table', () => {
    expect(sagaSource).toContain('prisma.dataDeletionRequest');
    expect(sagaSource).not.toMatch(/prisma\.leaveCleanupJob/i);
  });
});
