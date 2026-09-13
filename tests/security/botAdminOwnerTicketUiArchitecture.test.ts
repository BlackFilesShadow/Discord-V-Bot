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

  it('keeps reply and deny payloads bounded while supporting larger replies and files', () => {
    const ui = read('dashboard-ui/src/components/BotAdminOwnerTickets.tsx');

    expect(ui).toContain('const MAX_REPLY_CHARS = 8000;');
    expect(ui).toContain('maxLength={MAX_REPLY_CHARS}');
    expect(ui).toContain('maxLength={1000}');
    expect(ui).toContain('api.uploadForm(`/api/v2/bot-admin/tickets/${ticket.id}/reply`, fd)');
    expect(ui).toContain("fd.append('files', file, file.name)");
    expect(ui).toContain("error.status === 502");
  });

  it('uses server-sent events for live updates with polling only as a fallback', () => {
    const ui = read('dashboard-ui/src/components/BotAdminOwnerTickets.tsx');
    const route = read('src/dashboard/routes/v2/botAdminTicketReply.ts');

    expect(ui).toContain("new EventSource('/api/v2/bot-admin/tickets/events'");
    expect(ui).toContain("source.addEventListener('ticket-update'");
    expect(ui).toContain('refetchInterval: 10_000');
    expect(route).toContain("'/events'");
    expect(route).toContain("'Content-Type', 'text/event-stream; charset=utf-8'");
    expect(route).toContain('subscribeTicketRealtimeEvents');
  });

  it('renders persisted image/video previews and protected file links', () => {
    const ui = read('dashboard-ui/src/components/BotAdminOwnerTickets.tsx');
    const route = read('src/dashboard/routes/v2/botAdminTicketReply.ts');

    expect(ui).toContain('canPreviewImage(attachment.contentType)');
    expect(ui).toContain('canPreviewVideo(attachment.contentType)');
    expect(ui).toContain('<video controls preload="metadata"');
    expect(route).toContain("'/:id/messages/:messageId/attachments/:index'");
    expect(route).toContain('downloadTicketRelayAttachmentBytes');
    expect(route).toContain("'X-Content-Type-Options', 'nosniff'");
  });
});
