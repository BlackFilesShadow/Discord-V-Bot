import fs from 'node:fs';
import path from 'node:path';

describe('ticket transcript completeness contract', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/modules/tickets/ticketSystem.ts'),
    'utf8',
  );

  it('captures the Discord attachment metadata needed for durable archival', () => {
    expect(source).toContain('id: a.id,');
    expect(source).toContain('contentType: a.contentType ?? null,');
    expect(source).toContain('size: a.size,');
    expect(source).toContain('archivedDataUrl: null,');
  });

  it('archives before transcript HTML is built', () => {
    const archiveAt = source.lastIndexOf('const attachmentArchive = await archiveTranscriptAttachments(collectedMsgs);');
    const htmlAt = source.lastIndexOf('const transcriptHtml = buildTranscriptHtml(meta, collectedMsgs);');
    const dbAt = source.lastIndexOf('await prisma.ticketInstance.update({');
    expect(archiveAt).toBeGreaterThan(0);
    expect(htmlAt).toBeGreaterThan(archiveAt);
    expect(dbAt).toBeGreaterThan(htmlAt);
  });
});
