import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  snapshotChannels,
  snapshotRules,
  isViewableByEveryone,
} from '../../src/modules/ai/guildAwareness';

function makeChannel(opts: {
  name: string;
  type?: ChannelType;
  position?: number;
  viewableByEveryone: boolean | 'no-overwrites';
  topic?: string;
}) {
  const permsResult = opts.viewableByEveryone === 'no-overwrites'
    ? undefined
    : { has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel && opts.viewableByEveryone === true };
  return {
    name: opts.name,
    type: opts.type ?? ChannelType.GuildText,
    position: opts.position ?? 0,
    topic: opts.topic,
    permissionsFor: permsResult ? () => permsResult : undefined,
  };
}

function makeGuild(channels: ReturnType<typeof makeChannel>[], rulesChannel: ReturnType<typeof makeChannel> | null = null) {
  const cache = new Map(channels.map((c, i) => [`ch-${i}`, c]));
  return {
    id: 'guild-1',
    roles: { everyone: { id: 'guild-1' } },
    channels: { cache },
    rulesChannel,
  } as never;
}

describe('isViewableByEveryone', () => {
  it('gibt true zurueck, wenn @everyone ViewChannel hat', () => {
    const guild = makeGuild([]);
    const ch = makeChannel({ name: 'public', viewableByEveryone: true });
    expect(isViewableByEveryone(guild, ch as never)).toBe(true);
  });

  it('gibt false zurueck, wenn @everyone ViewChannel fehlt', () => {
    const guild = makeGuild([]);
    const ch = makeChannel({ name: 'mod-only', viewableByEveryone: false });
    expect(isViewableByEveryone(guild, ch as never)).toBe(false);
  });

  it('gibt true zurueck fuer Channel-Typen ohne Overwrite-Konzept (kein permissionsFor)', () => {
    const guild = makeGuild([]);
    const ch = makeChannel({ name: 'category', viewableByEveryone: 'no-overwrites' });
    expect(isViewableByEveryone(guild, ch as never)).toBe(true);
  });

  it('ist fail-closed, wenn permissionsFor wirft', () => {
    const guild = makeGuild([]);
    const ch = { name: 'broken', permissionsFor: () => { throw new Error('boom'); } };
    expect(isViewableByEveryone(guild, ch as never)).toBe(false);
  });
});

describe('snapshotChannels (Regressionsschutz: private Kanalnamen duerfen nicht in den AI-Kontext gelangen)', () => {
  it('nimmt oeffentliche Kanaele auf und filtert fuer @everyone unsichtbare Kanaele heraus', () => {
    const publicCh = makeChannel({ name: 'allgemein', viewableByEveryone: true, position: 0 });
    const modCh = makeChannel({ name: 'mod-intern', viewableByEveryone: false, position: 1 });
    const guild = makeGuild([publicCh, modCh]);

    const snapshot = snapshotChannels(guild);

    expect(snapshot.map((c) => c.name)).toEqual(['allgemein']);
    expect(snapshot.map((c) => c.name)).not.toContain('mod-intern');
  });
});

describe('snapshotRules (Regressionsschutz: fruehere HIGH-Fund - permissionsFor-Check)', () => {
  it('nimmt den konfigurierten Regel-Channel nur auf, wenn @everyone ihn sehen kann', async () => {
    const rulesCh = makeChannel({ name: 'regeln', viewableByEveryone: true, topic: 'Sei nett.' });
    const guild = makeGuild([rulesCh], rulesCh);

    const text = await snapshotRules(guild);

    expect(text).toContain('Sei nett.');
  });

  it('ignoriert den konfigurierten Regel-Channel, wenn @everyone ihn NICHT sehen kann', async () => {
    const rulesCh = makeChannel({ name: 'mod-regeln', viewableByEveryone: false, topic: 'GEHEIM: Admin-Verfahren' });
    const guild = makeGuild([rulesCh], rulesCh);

    const text = await snapshotRules(guild);

    expect(text).toBeNull();
  });

  it('ignoriert Namens-Treffer der Fallback-Suche ("regel"/"rules"), wenn der Kanal nicht oeffentlich sichtbar ist', async () => {
    const hiddenRulesLike = makeChannel({ name: 'staff-rules', viewableByEveryone: false, topic: 'GEHEIM' });
    const guild = makeGuild([hiddenRulesLike], null);

    const text = await snapshotRules(guild);

    expect(text).toBeNull();
  });

  it('nimmt einen oeffentlich sichtbaren Fallback-Kanal mit "rules" im Namen auf', async () => {
    const publicRulesLike = makeChannel({ name: 'server-rules', viewableByEveryone: true, topic: 'Oeffentliche Regeln' });
    const guild = makeGuild([publicRulesLike], null);

    const text = await snapshotRules(guild);

    expect(text).toContain('Oeffentliche Regeln');
  });
});
