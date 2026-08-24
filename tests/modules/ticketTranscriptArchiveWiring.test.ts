import fs from 'node:fs';
import path from 'node:path';

describe('ticket transcript archived-image wiring', () => {
  const root = process.cwd();
  const ticketSystem = fs.readFileSync(path.join(root, 'src/modules/tickets/ticketSystem.ts'), 'utf8');
  const transcriptRoute = fs.readFileSync(path.join(root, 'src/dashboard/routes/transcripts.ts'), 'utf8');

  it('archives attachments before both ticket close transcript renders', () => {
    expect(ticketSystem.match(/archiveTranscriptAttachments\(collectedMsgs\)/g)).toHaveLength(2);
    expect(ticketSystem).toContain('const collectedMsgs = collected.map(collectMessage);');
    expect(ticketSystem).toContain('const attachmentArchive = await archiveTranscriptAttachments(collectedMsgs);');
  });

  it('renders archived raster images inline instead of relying on expiring Discord URLs', () => {
    expect(ticketSystem).toContain('a.archivedDataUrl && isInlineTranscriptImage(a.contentType)');
    expect(ticketSystem).toContain('<img src="${safeHref}" alt="${safeName}" loading="lazy">');
    expect(ticketSystem).toContain('const href = a.archivedDataUrl ?? a.url;');
    expect(ticketSystem).toContain('download="${safeName}"');
  });

  it('keeps the public transcript CSP compatible with self-contained image data', () => {
    expect(transcriptRoute).toContain("img-src https: data:");
  });

  it('fails closed instead of deleting a ticket after an attachment archive error', () => {
    expect(ticketSystem).toContain("const archiveFailed = error.message.startsWith('Ticket-Anh');");
    expect(ticketSystem).toContain('Ticket wurde NICHT geschlossen: Mindestens ein Bild/Anhang konnte nicht vollstaendig archiviert werden.');
    expect(ticketSystem).toContain('await lockedChannel.permissionOverwrites.edit(instance.openerDiscordId, { SendMessages: true })');
  });
});
