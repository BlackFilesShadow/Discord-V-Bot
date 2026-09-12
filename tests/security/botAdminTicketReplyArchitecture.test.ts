import fs from 'fs';
import path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('BotAdmin owner-ticket dashboard reply architecture', () => {
  it('mounts the owner action router without tightening existing ticket read/close routes', () => {
    const contract = read('src/dashboard/routes/v2/botAdminLegacyContract.ts');

    expect(contract).toContain("import { botAdminTicketReplyRouter } from './botAdminTicketReply';");
    expect(contract).toContain("botAdminLegacyContractRouter.get('/tickets', requireBotAdmin");
    expect(contract).toContain("botAdminLegacyContractRouter.use('/tickets', botAdminTicketReplyRouter);");
  });

  it('keeps dashboard owner actions behind global DEV/Owner identity plus active BotAdmin session', () => {
    const route = read('src/dashboard/routes/v2/botAdminTicketReply.ts');

    expect(route).toContain('requireGlobalDeveloperIdentity');
    expect(route).toContain('requireBotAdmin');
    expect(route).toContain("'/:id/accept'");
    expect(route).toContain("'/:id/deny'");
    expect(route).toContain("'/:id/reply'");
    expect(route).toContain('acceptTicket(ticketId, req.auth!.discordId, client)');
    expect(route).toContain('denyTicket(ticketId, req.auth!.discordId, client, reason || undefined)');
    expect(route).toContain('replyToOwnerTicketFromDashboard');
    expect(route).toContain('BOTADMIN_TICKET_ACCEPT');
    expect(route).toContain('BOTADMIN_TICKET_DENY');
    expect(route).toContain('BOTADMIN_TICKET_REPLY');
  });

  it('reuses the existing ticket decision logic instead of duplicating status transitions', () => {
    const route = read('src/dashboard/routes/v2/botAdminTicketReply.ts');
    const manager = read('src/modules/ticket/ticketManager.ts');

    expect(route).toContain("import { acceptTicket, denyTicket } from '../../../modules/ticket/ticketManager';");
    expect(manager).toContain('export async function acceptTicket');
    expect(manager).toContain('export async function denyTicket');
    expect(route).not.toContain("data: { status: 'OPEN' }");
    expect(route).not.toContain("data: { status: 'DENIED'");
  });

  it('does not alter the existing DM relay implementation', () => {
    const manager = read('src/modules/ticket/ticketManager.ts');
    const dashboard = read('src/modules/ticket/ticketDashboardReply.ts');

    expect(manager).toContain('export async function handleTicketDm');
    expect(dashboard).not.toContain('handleTicketDm');
    expect(dashboard).toContain("fromRole: 'OWNER'");
    expect(dashboard).toContain("ticket.status !== 'OPEN'");
  });
});
