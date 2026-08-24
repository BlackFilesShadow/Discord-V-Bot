import fs from 'node:fs';
import path from 'node:path';

describe('ticket template archive lifecycle', () => {
  const root = process.cwd();
  const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'prisma/migrations/20260825010500_ticket_template_archive_preserve/migration.sql'),
    'utf8',
  );
  const ticketSystem = fs.readFileSync(path.join(root, 'src/modules/tickets/ticketSystem.ts'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'src/dashboard/routes/v2/tickets.ts'), 'utf8');
  const transcriptRoute = fs.readFileSync(path.join(root, 'src/dashboard/routes/transcripts.ts'), 'utf8');

  it('keeps archived TicketInstance rows when a template is deleted', () => {
    expect(schema).toContain('templateId             String?');
    expect(schema).toContain('TicketTemplate? @relation(fields: [templateId], references: [id], onDelete: SetNull)');
    expect(schema).toContain('templateLabelSnapshot  String');
    expect(schema).toContain('templateSlotSnapshot   Int');
    expect(migration).toContain('ON DELETE SET NULL ("templateId")');
    expect(migration).not.toContain('ON DELETE CASCADE ON UPDATE CASCADE;');
  });

  it('snapshots template identity when opening a ticket', () => {
    expect(ticketSystem).toContain('templateLabelSnapshot: t.label');
    expect(ticketSystem).toContain('templateSlotSnapshot: t.slot');
  });

  it('fences stale open buttons while a template is being deleted', () => {
    expect(ticketSystem).toContain("where: { id: t.id, isActive: true }");
    expect(ticketSystem).toContain("throw new Error('TICKET_TEMPLATE_INACTIVE')");
    expect(route).toContain("data: { isActive: false }");
    expect(route).toContain("status: 'OPEN'");
  });

  it('blocks template deletion when ticket archival is incomplete', () => {
    expect(route).toContain('purged.failed > 0');
    expect(route).toContain('remainingOpen > 0');
    expect(route).toContain('preservedArchives: true');
  });

  it('renders deleted-template ticket rows from immutable snapshots', () => {
    expect(route).toContain('i.template?.label ?? i.templateLabelSnapshot');
    expect(route).toContain('i.template?.slot ?? i.templateSlotSnapshot');
  });

  it('serves archived transcript HTML directly from TicketInstance without requiring its template', () => {
    expect(transcriptRoute).toContain('prisma.ticketInstance.findUnique');
    expect(transcriptRoute).toContain('transcriptHtml');
    expect(transcriptRoute).not.toContain('include: { template:');
  });

  it('handles archived instances whose template relation is already null', () => {
    expect(ticketSystem).toContain('managerRoleIds?: unknown } | null');
    expect(ticketSystem).toContain('if (!instance.template) return false;');
    expect(ticketSystem).toContain('if (tmId && inst.template)');
    expect(ticketSystem).toContain('if (fresh?.template)');
  });

  it('still updates the persisted close reason even if the deleted template prevents a Discord embed refresh', () => {
    expect(ticketSystem).toContain('await prisma.ticketInstance.update({');
    expect(ticketSystem).toContain('closeReason: next');
    expect(ticketSystem.indexOf('closeReason: next')).toBeLessThan(ticketSystem.indexOf('if (tmId && inst.template)'));
  });
});
