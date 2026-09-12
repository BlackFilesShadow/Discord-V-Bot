import fs from 'fs';
import path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('BotAdmin owner-ticket dashboard reply architecture', () => {
  it('mounts the reply router without tightening existing ticket read/close routes', () => {
    const contract = read('src/dashboard/routes/v2/botAdminLegacyContract.ts');

    expect(contract).toContain("import { botAdminTicketReplyRouter } from './botAdminTicketReply';");
    expect(contract).toContain("botAdminLegacyContractRouter.get('/tickets', requireBotAdmin");
    expect(contract).toContain("botAdminLegacyContractRouter.use('/tickets', botAdminTicketReplyRouter);");
  });

  it('keeps dashboard replies behind global DEV/Owner identity plus active BotAdmin session', () => {
    const route = read('src/dashboard/routes/v2/botAdminTicketReply.ts');

    expect(route).toContain('requireGlobalDeveloperIdentity');
    expect(route).toContain('requireBotAdmin');
    expect(route).toContain("'/:id/reply'");
    expect(route).toContain('replyToOwnerTicketFromDashboard');
    expect(route).toContain('BOTADMIN_TICKET_REPLY');
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
