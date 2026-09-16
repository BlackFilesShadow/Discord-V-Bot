import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Universal whitelist regression', () => {
  const channels = read('src/modules/whitelist/whitelistChannels.ts');
  const handler = read('src/modules/whitelist/whitelistApprovalButton.ts');
  const dispatcher = read('src/events/interactionCreateComposite.ts');

  it('renders a dedicated Universal Whitelist approval action', () => {
    expect(channels).toContain(".setCustomId(`wlreq:u:${args.requestId}`)");
    expect(channels).toContain(".setLabel('Universal Whitelist')");
  });

  it('routes the universal custom id through the production interaction dispatcher', () => {
    expect(dispatcher).toContain("i.customId.startsWith('wlreq:u:')");
    expect(dispatcher).toContain('return handleWhitelistApprovalButton(i)');
    expect(dispatcher).toContain("rateLimitedCounter.inc({ kind: 'component' })");
  });

  it('targets only active fully connected Nitrado gameservers in the request guild', () => {
    expect(handler).toContain("const isUniversal = btn.customId.startsWith('wlreq:u:')");
    expect(handler).toContain('prisma.nitradoConnection.findMany({');
    expect(handler).toContain('guildId: reqRow.guildId');
    expect(handler).toContain("status: 'ACTIVE'");
    expect(handler).toContain('nitradoServerId: { not: null }');
    expect(handler).toContain("orderBy: { slot: 'asc' }");
  });

  it('queues each target independently and preserves fail-closed request state when none can be queued', () => {
    expect(handler).toContain('return Promise.all(args.targets.map(async target =>');
    expect(handler).toContain('await enqueueWhitelistAdd(');
    expect(handler).toContain('if (succeeded.length === 0)');
    expect(handler).toContain("status: 'PENDING'");
    expect(handler).toContain("logAudit('WL_REQUEST_UNIVERSAL_FAILED'");
    expect(handler).toContain("logAudit('WL_REQUEST_UNIVERSAL_APPROVED'");
  });

  it('shows the Universal-Whitelist button only when 2+ active Gameserver sind verbunden, mit derselben Zaehlung wie der Handler selbst', () => {
    // Bei nur einem verbundenen Server ist Annehmen/Ablehnen bereits die
    // vollstaendige Aktion - der Button wuerde ohne diese Pruefung immer
    // erscheinen, auch wenn ein Fan-out auf "mehrere Server" gar nicht
    // moeglich ist. Selbstheilend, weil jede neue Anfrage die Zaehlung frisch
    // ausfuehrt (kein persistenter/veralteter Zustand).
    const embedFn = channels.slice(channels.indexOf('export async function postWhitelistApprovalEmbed'));
    expect(embedFn).toContain('const universalTargetCount = await prisma.nitradoConnection.count({');
    expect(embedFn).toContain("where: { guildId: args.guildId, status: 'ACTIVE', nitradoServerId: { not: null } }");
    expect(embedFn).toContain('if (universalTargetCount >= 2)');
    // Dieselbe Zaehl-Semantik (ACTIVE + nitradoServerId gesetzt) wie im
    // eigentlichen Fan-out-Handler, damit "Button sichtbar" und "Button
    // funktioniert" nie auseinanderlaufen.
    expect(handler).toContain("status: 'ACTIVE'");
    expect(handler).toContain('nitradoServerId: { not: null }');
  });
});