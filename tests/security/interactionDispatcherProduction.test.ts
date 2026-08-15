import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'events', 'interactionCreate.ts'), 'utf8');

function section(start: string, end?: string): string {
  const startAt = source.indexOf(start);
  expect(startAt).toBeGreaterThanOrEqual(0);
  const endAt = end ? source.indexOf(end, startAt + start.length) : source.length;
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('interactionCreate production invariants', () => {
  it('nutzt fuer Poll-Buttons ausschliesslich die kanonische atomare Toggle-Schicht', () => {
    expect(source).toContain('togglePollVote');
    const pollButton = section('export async function handlePollVoteButton', '/**\n * Giveaway-Button');
    expect(pollButton).toContain('await togglePollVote(');
    expect(pollButton).not.toContain('prisma.pollVote.delete(');
    expect(pollButton).not.toContain('prisma.pollVote.deleteMany(');
    expect(pollButton).not.toContain('prisma.pollVote.create(');
    expect(pollButton).not.toContain('totalVotes: { decrement:');
  });

  it('erzwingt manufacturerOnly zentral als ACTIVE + Flag + MANUFACTURER-Rolle', () => {
    const gate = section('else if (command.manufacturerOnly)', 'if (command.permissions');
    expect(gate).toContain("!dbUser.isManufacturer || dbUser.role !== 'MANUFACTURER'");
    expect(gate).toContain("dbUser.status !== 'ACTIVE'");
  });

  it('leitet neue Giveaway-Button-Teilnahmen durch enterGiveaway und nicht durch Direkt-Insert', () => {
    const giveawayButton = section('export async function handleGiveawayEnterButton', 'export async function handleTicketButton');
    expect(giveawayButton).toContain('await enterGiveaway(');
    expect(giveawayButton).not.toContain('prisma.giveawayEntry.create(');
  });

  it('verwendet fuer zentrale RateLimit-, DEV-, Permission-, Component- und Ticket-Wege Status-Embeds', () => {
    expect(source).toContain('export function interactionNotice');

    const componentRateLimit = section('if (isComponentInteraction)', "if ('isModalSubmit' in i");
    expect(componentRateLimit).toContain('embeds: [interactionNotice(');

    const commandRateLimits = section('if (!checkGlobalRateLimit', 'if (command.adminOnly || command.devOnly || command.manufacturerOnly)');
    expect(commandRateLimits).toContain("interactionNotice('warning', 'Command-Limit erreicht'");
    expect(commandRateLimits).toContain("interactionNotice('info', 'Command noch im Cooldown'");

    const permissionBlock = section('if (command.adminOnly || command.devOnly || command.manufacturerOnly)', 'const stopTimer = commandDurationHistogram.startTimer');
    expect(permissionBlock).toContain("interactionNotice('error', 'Developer-Zugriff verweigert'");
    expect(permissionBlock).toContain("interactionNotice('error', 'Server-Berechtigung fehlt'");

    const ticketButton = section('export async function handleTicketButton');
    expect(ticketButton).toContain('embeds: [interactionNotice(');
  });
});
