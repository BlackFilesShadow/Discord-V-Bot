import fs from 'fs';
import path from 'path';
import { ApplicationCommandOptionType, SlashCommandBuilder } from 'discord.js';
import { normalizeServerAliasOptionsForDeploy } from '../../src/commands/handler';
import { resolveRequestedServerSelection } from '../../src/commands/middleware/withGuildScope';
import { linkNeedsEconomyRepair } from '../../src/modules/linking/linkEconomyReconcile';
import type { ScopeCandidate } from '../../src/modules/nitrado/gameServerScope';
import type { NitradoConnId } from '../../src/types/scope';

const ROOT = path.resolve(__dirname, '../..');

function candidate(id: string, slot: number, alias: string, status: ScopeCandidate['status'] = 'ACTIVE'): ScopeCandidate {
  return { id: id as NitradoConnId, slot, alias, status };
}

describe('Link/Economy + zentrale Gameserver-Alias-Auswahl', () => {
  it('publiziert historische slot-Optionen zentral als Alias-Autocomplete-String', () => {
    const json = new SlashCommandBuilder()
      .setName('probe')
      .setDescription('probe')
      .addIntegerOption(option => option
        .setName('slot')
        .setDescription('legacy slot')
        .setMinValue(1)
        .setMaxValue(4))
      .toJSON();

    const normalized = normalizeServerAliasOptionsForDeploy(json);
    const slot = normalized.options?.find(option => option.name === 'slot');

    expect(slot?.type).toBe(ApplicationCommandOptionType.String);
    expect(slot && 'autocomplete' in slot ? slot.autocomplete : undefined).toBe(true);
    expect(slot?.description).toBe('Gameserver ueber Alias auswaehlen');
    expect('min_value' in (slot ?? {})).toBe(false);
    expect('max_value' in (slot ?? {})).toBe(false);
  });

  it('normalisiert slot auch innerhalb verschachtelter Subcommands', () => {
    const json = {
      name: 'probe',
      description: 'probe',
      type: 1,
      options: [{
        type: 1,
        name: 'sub',
        description: 'sub',
        options: [{ type: ApplicationCommandOptionType.Integer, name: 'slot', description: 'slot', min_value: 1, max_value: 4 }],
      }],
    } as ReturnType<SlashCommandBuilder['toJSON']>;

    const normalized = normalizeServerAliasOptionsForDeploy(json);
    const slot = normalized.options?.[0] && 'options' in normalized.options[0]
      ? normalized.options[0].options?.find(option => option.name === 'slot')
      : undefined;

    expect(slot?.type).toBe(ApplicationCommandOptionType.String);
    expect(slot && 'autocomplete' in slot ? slot.autocomplete : undefined).toBe(true);
  });

  it('laesst den echten Slash-Command /slot als Chat-Input stehen und normalisiert nur seine slot-Option', () => {
    const json = new SlashCommandBuilder()
      .setName('slot')
      .setDescription('Casino Slot')
      .addIntegerOption(option => option
        .setName('einsatz')
        .setDescription('Einsatz')
        .setRequired(true)
        .setMinValue(1))
      .addIntegerOption(option => option
        .setName('slot')
        .setDescription('legacy slot')
        .setMinValue(1)
        .setMaxValue(4))
      .toJSON();

    const normalized = normalizeServerAliasOptionsForDeploy(json);
    const einsatz = normalized.options?.find(option => option.name === 'einsatz');
    const serverSlot = normalized.options?.find(option => option.name === 'slot');

    expect(normalized.name).toBe('slot');
    expect(normalized.type).toBe(1);
    expect(normalized.description).toBe('Casino Slot');
    expect('autocomplete' in normalized).toBe(false);
    expect(einsatz?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(serverSlot?.type).toBe(ApplicationCommandOptionType.String);
    expect(serverSlot && 'autocomplete' in serverSlot ? serverSlot.autocomplete : undefined).toBe(true);
  });

  it('loest Connection-ID, Alias und numerischen Legacy-Slot deterministisch auf', () => {
    const targets: ScopeCandidate[] = [
      candidate('conn-a', 1, 'Chernarus'),
      candidate('conn-b', 2, 'Livonia'),
    ];

    expect(resolveRequestedServerSelection(targets, 'conn-b')).toEqual({ kind: 'SELECTED', id: 'conn-b' });
    expect(resolveRequestedServerSelection(targets, 'livonia')).toEqual({ kind: 'SELECTED', id: 'conn-b' });
    expect(resolveRequestedServerSelection(targets, '2')).toEqual({ kind: 'SELECTED', id: 'conn-b' });
    expect(resolveRequestedServerSelection(targets, 1)).toEqual({ kind: 'SELECTED', id: 'conn-a' });
  });

  it('weist doppelte manuelle Aliase fail-closed ab', () => {
    const targets: ScopeCandidate[] = [
      candidate('conn-a', 1, 'DayZ'),
      candidate('conn-b', 2, 'DayZ'),
    ];
    expect(resolveRequestedServerSelection(targets, 'dayz')).toEqual({ kind: 'AMBIGUOUS_ALIAS' });
  });

  it('repariert nur fehlende, veraltete oder noch nicht fertig ausgewertete Economy-Link-States', () => {
    const verifiedLink = {
      userDiscordId: 'user-a',
      identityHash: 'hash-a',
      verifiedAt: new Date('2026-08-29T00:00:00.000Z'),
    };
    const healthy = {
      userDiscordId: verifiedLink.userDiscordId,
      identityHash: 'hash-a',
      unlinkedAt: null,
      startBalanceEligible: false,
    };

    expect(linkNeedsEconomyRepair(verifiedLink, healthy)).toBe(false);
    expect(linkNeedsEconomyRepair(verifiedLink, undefined)).toBe(true);
    expect(linkNeedsEconomyRepair(verifiedLink, { ...healthy, unlinkedAt: new Date() })).toBe(true);
    expect(linkNeedsEconomyRepair(verifiedLink, { ...healthy, identityHash: 'hash-b' })).toBe(true);
    expect(linkNeedsEconomyRepair(verifiedLink, { ...healthy, startBalanceEligible: true })).toBe(true);
    expect(linkNeedsEconomyRepair({ ...verifiedLink, identityHash: null }, undefined)).toBe(false);
  });

  it('verbindet normalen Link und Force-Link mit dem kanonischen Economy-Hook und selbstheilendem Reconcile', () => {
    const linking = fs.readFileSync(path.join(ROOT, 'src/commands/dashboard/linking.ts'), 'utf8');
    const privileged = fs.readFileSync(path.join(ROOT, 'src/commands/dashboard/privileged.ts'), 'utf8');
    const cron = fs.readFileSync(path.join(ROOT, 'src/modules/nitrado/adm/admPostProcessCron.ts'), 'utf8');
    const rewards = fs.readFileSync(path.join(ROOT, 'src/modules/linking/linkRewards.ts'), 'utf8');

    expect(linking).toContain('await applySuccessfulLinkEconomyEffects({');
    expect(privileged).toContain('startBalance = await applySuccessfulLinkEconomyEffects({');
    expect(cron).toContain('await applySuccessfulLinkEconomyEffects({');
    expect(cron).toContain('await reconcileVerifiedLinkEconomyEffects(');
    expect(rewards).toContain('await activateLinkRewardState(');
    expect(rewards).toContain('return grantStartBalanceForLink(');
    expect(rewards).toContain('economyLinkRewardState.findUnique');
  });

  it('zeigt link-info die vollstaendige aufgeloeste GUID ohne Kuerzung an', () => {
    const linking = fs.readFileSync(path.join(ROOT, 'src/commands/dashboard/linking.ts'), 'utf8');
    const service = fs.readFileSync(path.join(ROOT, 'src/modules/linking/linkService.ts'), 'utf8');

    expect(linking).toContain("`GUID: \\`${row.gameId ?? 'nicht auflösbar'}\\``");
    expect(linking).not.toContain('row.gameId.slice(');
    expect(linking).not.toContain('row.gameId?.slice(');
    expect(service).toContain('gameId: session?.gameId ?? null');
  });

  it('bezeichnet den Multi-Provider-Aufruf nicht als eigenen LLM-Provider', () => {
    const knowledge = fs.readFileSync(path.join(ROOT, 'src/modules/ai/guildKnowledge.ts'), 'utf8');

    expect(knowledge).toContain('AI-Provider-Antwort zu kurz');
    expect(knowledge).toContain('AI-Provider-Aufruf fehlgeschlagen');
    expect(knowledge).toContain('const providerResponse = await callAI(');
    expect(knowledge).not.toContain('LLM-Antwort zu kurz');
    expect(knowledge).not.toContain('LLM-Call fehlgeschlagen');
    expect(knowledge).not.toContain('const llm = await callAI(');
  });
});
