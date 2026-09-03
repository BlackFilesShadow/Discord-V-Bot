import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Whitelist channel + archive flow regression', () => {
  const channels = read('src/modules/whitelist/whitelistChannels.ts');
  const approvalButton = read('src/modules/whitelist/whitelistApprovalButton.ts');
  const whitelistCommand = read('src/commands/dashboard/whitelist.ts');
  const commandHandler = read('src/commands/handler.ts');
  const dashboardRoute = read('src/dashboard/routes/v2/whitelist.ts');

  it('keeps /whitelist-antrag as the public member request command and explains exactly that command', () => {
    expect(commandHandler).toContain("whitelist: 'whitelist-antrag'");
    expect(channels).toContain('vEmbed(Colors.Info)');
    expect(channels).toContain(".setTitle('Whitelist')");
    expect(channels).toContain('1. Nutze `/whitelist-antrag` in diesem Kanal.');
    expect(channels).not.toContain('1. Nutze `/whitelist` in diesem Kanal.');
  });

  it('keeps member whitelist requests fail-closed to the configured info channel', () => {
    expect(whitelistCommand).toContain('if (i.channelId !== settings.whitelistChannelId)');
    expect(whitelistCommand).toContain('ausschliesslich in <#${settings.whitelistChannelId}> erlaubt');
  });

  it('keeps the approval request in the configured request channel with accept/deny buttons', () => {
    expect(channels).toContain('settings.whitelistRequestChannelId');
    expect(channels).toContain(".setCustomId(`wlreq:a:${args.requestId}`)");
    expect(channels).toContain(".setLabel('Annehmen')");
    expect(channels).toContain(".setCustomId(`wlreq:d:${args.requestId}`)");
    expect(channels).toContain(".setLabel('Ablehnen')");
  });

  it('routes Discord button decisions and dashboard decisions through the same archive output path', () => {
    expect(approvalButton).toContain("import { notifyRequesterDecision, postDecisionLog } from './whitelistChannels'");
    expect(approvalButton.split('postDecisionLog({').length - 1).toBe(2);
    expect(dashboardRoute).toContain('postDecisionLog({');
  });

  it('keeps the user decision notice temporary, points the user to support, and never auto-deletes the archive entry', () => {
    const noticeStart = channels.indexOf('async function postTemporaryDecisionNotice');
    const archiveStart = channels.indexOf('async function postPermanentDecisionArchive');
    const commonStart = channels.indexOf('export async function postDecisionLog');

    expect(noticeStart).toBeGreaterThanOrEqual(0);
    expect(archiveStart).toBeGreaterThan(noticeStart);
    expect(commonStart).toBeGreaterThan(archiveStart);

    const noticeBody = channels.slice(noticeStart, archiveStart);
    const archiveBody = channels.slice(archiveStart, commonStart);

    expect(noticeBody).toContain('DECISION_NOTICE_TTL_MS');
    expect(noticeBody).toContain('sent.delete()');
    expect(noticeBody).toContain('Bei Fragen oder für weitere Informationen wende dich bitte an den Support.');
    expect(noticeBody).not.toContain('Weitere Informationen findest du in deiner DM.');
    expect(archiveBody).not.toContain('.delete(');
    expect(archiveBody).toContain(".setFooter({ text: 'V-Bot • Whitelist • Archiv' })");
  });

  it('archives readable Discord names, requested player name, decision actor, date and time without raw-id fallback fields', () => {
    expect(channels).toContain('resolveDiscordDisplayName(args.guildId, args.requesterDiscordId)');
    expect(channels).toContain('resolveDiscordDisplayName(args.guildId, args.decidedByDiscordId)');
    expect(channels).toContain("{ name: 'Discord-Name', value: requesterName");
    expect(channels).toContain("{ name: 'Beantragter Spielername', value: `\\`${args.gameId}\\``");
    expect(channels).toContain("args.approved ? 'Genehmigt von' : 'Abgelehnt von'");
    expect(channels).toContain("{ name: 'Datum', value: when.date");
    expect(channels).toContain("{ name: 'Uhrzeit', value: when.time");
    expect(channels).toContain("timeZone: 'Europe/Berlin'");
    expect(channels).not.toContain("value: `<@${args.decidedByDiscordId}>`");
  });
});
