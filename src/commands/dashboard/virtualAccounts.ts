import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from 'discord.js';
import type { Command } from '../../types';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  getVirtualAccountByName,
  listVirtualAccounts,
  transferUserToVirtualAccount,
  type EconomyPocket,
  type VirtualAccountStatus,
} from '../../modules/economy/virtualAccounts';
import { getConfig } from '../../modules/economy/repository';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import { logAudit } from '../../utils/logger';

function addSlotOption(builder: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD));
}

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

function statusLabel(status: VirtualAccountStatus): string {
  if (status === 'ACTIVE') return '🟢 Aktiv';
  if (status === 'EXPIRED') return '🟡 Abgelaufen';
  return '⚫ Archiviert';
}

async function replyError(i: ChatInputCommandInteraction, title: string, message: string): Promise<void> {
  await i.reply({
    embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle(title).setDescription(message).setFooter({ text: 'V-Bot Economy' })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

const builder = new SlashCommandBuilder()
  .setName('virtual-account')
  .setDescription('Virtuelle Economy-Konten anzeigen und Geld dorthin ueberweisen.')
  .addSubcommand(sc => addSlotOption(sc
    .setName('list')
    .setDescription('Zeigt die virtuellen Konten dieses Gameservers.')))
  .addSubcommand(sc => addSlotOption(sc
    .setName('info')
    .setDescription('Zeigt ein virtuelles Konto im Detail.')
    .addStringOption(o => o.setName('name').setDescription('Exakter Kontoname').setRequired(true).setMaxLength(80))))
  .addSubcommand(sc => addSlotOption(sc
    .setName('pay')
    .setDescription('Ueberweist Geld auf ein aktives virtuelles Konto.')
    .addStringOption(o => o.setName('name').setDescription('Exakter Kontoname').setRequired(true).setMaxLength(80))
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption(o => o.setName('quelle').setDescription('Wallet oder Bank').setRequired(false)
      .addChoices({ name: 'Wallet', value: 'WALLET' }, { name: 'Bank', value: 'BANK' }))
    .addStringOption(o => o.setName('grund').setDescription('Optionaler Grund').setRequired(false).setMaxLength(100))));

export const virtualAccountCommand: Command = {
  data: builder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const connId = scope.nitradoConnId!;
    const sub = i.options.getSubcommand();
    const cfg = await getConfig(scope.guildId, connId);

    if (sub === 'list') {
      const accounts = await listVirtualAccounts(scope.guildId, connId, false);
      const visible = accounts.filter(a => a.status !== 'ARCHIVED');
      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🏦 Virtuelle Konten')
        .setFooter({ text: 'V-Bot Economy' });
      if (visible.length === 0) {
        embed.setDescription('Auf diesem Gameserver sind keine virtuellen Konten verfuegbar.');
      } else {
        embed.setDescription('Konten sind strikt an den ausgewaehlten Gameserver gebunden.')
          .addFields(visible.slice(0, 20).map(account => ({
            name: `${statusLabel(account.status)} · ${account.name}`,
            value: [
              `**${fmt(account.balance)}** ${cfg.emoji}`,
              `Typ: ${account.kind}`,
              `Direkte Einzahlungen: ${account.acceptUserTransfers && account.status === 'ACTIVE' ? 'ja' : 'nein'}`,
              account.expiresAt ? `Ablauf: <t:${Math.floor(account.expiresAt.getTime() / 1000)}:R>` : 'Ablauf: unbegrenzt',
            ].join(' · '),
          })));
      }
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    const name = i.options.getString('name', true);
    const account = await getVirtualAccountByName(scope.guildId, connId, name);
    if (!account || account.status === 'ARCHIVED') {
      await replyError(i, 'Konto nicht gefunden', 'Auf diesem Gameserver existiert kein sichtbares virtuelles Konto mit diesem Namen.');
      return;
    }

    if (sub === 'info') {
      const embed = new EmbedBuilder()
        .setColor(account.status === 'ACTIVE' ? 0x2ECC71 : 0xF1C40F)
        .setTitle(`🏦 ${account.name}`)
        .addFields(
          { name: 'Status', value: statusLabel(account.status), inline: true },
          { name: 'Kontostand', value: `${fmt(account.balance)} ${cfg.emoji}`, inline: true },
          { name: 'Typ', value: account.kind, inline: true },
          { name: 'Direkte Einzahlungen', value: account.acceptUserTransfers && account.status === 'ACTIVE' ? 'Erlaubt' : 'Gesperrt', inline: true },
          { name: 'Ablauf', value: account.expiresAt ? `<t:${Math.floor(account.expiresAt.getTime() / 1000)}:F>` : 'Kein Ablauf', inline: true },
        )
        .setFooter({ text: 'V-Bot Economy' });
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'pay') {
      if (account.kind !== 'CUSTOM') {
        await replyError(i, 'Systemkonto geschützt', 'Lotterie- und Markt-Systemkonten koennen nur durch ihre jeweilige Fachfunktion Geld bewegen.');
        return;
      }
      if (account.status !== 'ACTIVE') {
        await replyError(i, 'Ueberweisung abgelehnt', 'Dieses virtuelle Konto ist nicht mehr aktiv.');
        return;
      }
      if (!account.acceptUserTransfers) {
        await replyError(i, 'Ueberweisung abgelehnt', 'Dieses Konto nimmt keine direkten User-Ueberweisungen an.');
        return;
      }
      const amount = BigInt(i.options.getInteger('betrag', true));
      const sourcePocket = (i.options.getString('quelle') ?? 'WALLET') as EconomyPocket;
      const reason = i.options.getString('grund') ?? 'Discord-Ueberweisung';
      try {
        const result = await transferUserToVirtualAccount({
          idempotencyKey: `discord-virtual-pay:${i.id}`,
          guildId: scope.guildId,
          nitradoConnId: connId,
          fromUserId: scope.actorDiscordId,
          virtualAccountId: account.id,
          amount,
          sourcePocket,
          reason,
        });
        logAudit('ECON_VIRTUAL_ACCOUNT_PAY', 'ECONOMY', {
          guildId: scope.guildId,
          nitradoConnId: connId,
          userDiscordId: scope.actorDiscordId,
          accountId: account.id,
          amount: amount.toString(),
          sourcePocket,
          booked: result.booked,
        });
        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle(result.booked ? '✅ Ueberweisung erfolgreich' : '✅ Bereits verarbeitet')
          .setDescription(`**${fmt(amount)}** ${cfg.emoji} → **${account.name}**`)
          .addFields(
            { name: 'Quelle', value: sourcePocket === 'WALLET' ? 'Wallet' : 'Bank', inline: true },
            { name: 'Neuer Kontostand', value: `${fmt(result.account.balance)} ${cfg.emoji}`, inline: true },
            { name: 'Grund', value: reason, inline: false },
          )
          .setFooter({ text: 'V-Bot Economy' });
        await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch (error) {
        await replyError(i, 'Ueberweisung fehlgeschlagen', (error as Error).message);
      }
    }
  }),
};