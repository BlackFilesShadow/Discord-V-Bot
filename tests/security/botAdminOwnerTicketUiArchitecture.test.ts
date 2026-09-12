import fs from 'fs';
import path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('BotAdmin owner ticket inbox architecture', () => {
  it('shows the owner inbox only after the canonical developer/owner eligibility check', () => {
    const page = read('dashboard-ui/src/pages/BotAdmin.tsx');

    expect(page).toContain("api.get<DevEligibilityStatus>('/api/v2/dev/status')");
    expect(page).toContain('const isDeveloperOwner = developerEligibility.data === true;');
    expect(page).toContain("isDeveloperOwner && <Button size=\"sm\" variant={view === 'tickets'");
    expect(page).toContain("isDeveloperOwner && view === 'tickets' && <BotAdminOwnerTickets />");
  });

  it('uses only the existing bot-owner ticket endpoints and owner-only action routes', () => {
    const ui = read('dashboard-ui/src/components/BotAdminOwnerTickets.tsx');

    expect(ui).toContain('/api/v2/bot-admin/tickets?status=');
    expect(ui).toContain('/api/v2/bot-admin/tickets/${selectedId}');
    expect(ui).toContain('/api/v2/bot-admin/tickets/${ticket.id}/accept');
    expect(ui).toContain('/api/v2/bot-admin/tickets/${ticket.id}/deny');
    expect(ui).toContain('/api/v2/bot-admin/tickets/${ticket.id}/reply');
    expect(ui).toContain('/api/v2/bot-admin/tickets/${ticket.id}/close');
    expect(ui).not.toContain('/api/v2/guilds/');
  });

  it('keeps reply and deny payloads bounded by the backend contract', () => {
    const ui = read('dashboard-ui/src/components/BotAdminOwnerTickets.tsx');

    expect(ui).toContain('maxLength={1800}');
    expect(ui).toContain('maxLength={1000}');
    expect(ui).toContain("error.status === 502");
  });
});
