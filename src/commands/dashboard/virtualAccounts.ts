import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from 'discord.js';
import type { Command } from '../../types';
import { withGuildScope } from '../middleware/withGuildScope';
import {
  getVirtualAccountByName,
  listVirtualAccounts,
  type EconomyPocket,
  type VirtualAccountStatus,
} from '../../modules/economy/virtualAccounts';
import { ensureVirtualAccountFinance, listVirtualAccountFinanceMap } from '../../modules/economy/virtualAccountFinance';
import { safeDepositUserIntoVirtualAccount } from '../../modules/economy/virtualAccountMoneySafety';
import { publishVirtualAccountActivityLive } from '../../modules/economy/virtualAccountLiveUpdates';
import { getConfig } from '../../modules/economy/repository';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import { logAudit, logger } from '../../utils/logger';
import { Colors, vEmbed } from '../../utils/embedDesign';

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
    embeds: [vEmbed(Colors.Error).setTitle(title).setDescription(message).setFooter({ text: 'V-Bot Economy' })],
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
    .addIntegerOption(o => o.setName('betrag').setDescription('Betrag in deiner Server-Waehrung').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
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
      const visible = accounts.filter(a => a.status !== 'ARCHIVED').slice(0, 20);
      const embed = vEmbed(Colors.Info)
        .setTitle('🏦 Virtuelle Konten')
        .setFooter({ text: 'V-Bot Economy' });
      if (visible.length === 0) {
        embed.setDescription('Auf diesem Gameserver sind keine virtuellen Konten verfuegbar.');
      } else {
        const financeMap = await listVirtualAccountFinanceMap(scope.guildId, connId);
        const fields = [];
        for (const account of visible) {
          const finance = financeMap.get(account.id) ?? await ensureVirtualAccountFinance(scope.guildId, connId, account.id);
          fields.push({
            name: `${statusLabel(account.status)} · ${finance.accountEmoji} ${account.name}`,
            value: [
              `Wallet: **${fmt(account.balance)}** ${finance.currencyEmoji}`,
              `Bank: **${fmt(finance.bankBalance)}** ${finance.currencyEmoji}`,
              `Gesamt: **${fmt(account.balance + finance.bankBalance)}** ${finance.currencyEmoji}`,
              `Währung: ${finance.currencyName}`,
              `Typ: ${finance.accountPurpose === 'BANK_TREASURY' ? 'Serverbank' : account.kind}`,
              `Direkte Einzahlungen: ${account.acceptUserTransfers && account.status === 'ACTIVE' ? 'ja' : 'nein'}`,
              account.expiresAt ? `Ablauf: <t:${Math.floor(account.expiresAt.getTime() / 1000)}:R>` : 'Ablauf: unbegrenzt',
            ].join('\n'),
          });
        }
        embed.setDescription('Konten sind strikt an den ausgewaehlten Gameserver gebunden.').addFields(fields);
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
    const finance = await ensureVirtualAccountFinance(scope.guildId, connId, account.id);

    if (sub === 'info') {
      const embed = vEmbed(account.status === 'ACTIVE' ? Colors.Success : Colors.Warning)
        .setTitle(`${finance.accountEmoji} ${account.name}`)
        .addFields(
          { name: 'Status', value: statusLabel(account.status), inline: false },
          { name: 'Wallet', value: `${fmt(account.balance)} ${finance.currencyEmoji}`, inline: false },
          { name: 'Bankkonto', value: `${fmt(finance.bankBalance)} ${finance.currencyEmoji}`, inline: false },
          { name: 'Gesamt', value: `${fmt(account.balance + finance.bankBalance)} ${finance.currencyEmoji}`, inline: false },
          { name: 'Währung', value: `${finance.currencyName} ${finance.currencyEmoji}`, inline: false },
          { name: 'Typ', value: finance.accountPurpose === 'BANK_TREASURY' ? 'Serverbank' : account.kind, inline: false },
          { name: 'Direkte Einzahlungen', value: account.acceptUserTransfers && account.status === 'ACTIVE' ? 'Erlaubt' : 'Gesperrt', inline: false },
          { name: 'Ablauf', value: account.expiresAt ? `<t:${Math.floor(account.expiresAt.getTime() / 1000)}:F>` : 'Kein Ablauf', inline: false },
        )
        .setFooter({ text: 'V-Bot Economy' });
      if (finance.bannerUrl) embed.setImage(finance.bannerUrl);
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
      const playerAmount = BigInt(i.options.getInteger('betrag', true));
      const sourcePocket = (i.options.getString('quelle') ?? 'WALLET') as EconomyPocket;
      const reason = i.options.getString('grund') ?? 'Discord-Ueberweisung';
      try {
        const result = await safeDepositUserIntoVirtualAccount({
          idempotencyKey: `discord-virtual-pay:${i.id}`,
          guildId: scope.guildId,
          nitradoConnId: connId,
          accountId: account.id,
          userDiscordId: scope.actorDiscordId,
          playerAmount,
          sourcePocket,
          reason,
        });
        logAudit('ECON_VIRTUAL_ACCOUNT_PAY', 'ECONOMY', {
          guildId: scope.guildId,
          nitradoConnId: connId,
          userDiscordId: scope.actorDiscordId,
          accountId: account.id,
          playerAmount: result.playerDebited.toString(),
          accountAmount: result.accountCredited.toString(),
          sourcePocket,
          booked: result.booked,
        });
        const embed = vEmbed(Colors.Success)
          .setTitle(result.booked ? '✅ Ueberweisung erfolgreich' : '✅ Bereits verarbeitet')
          .setDescription(
            cfg.currencyName.toLocaleLowerCase('de-DE') === result.finance.currencyName.toLocaleLowerCase('de-DE')
              ? `**${fmt(result.accountCredited)}** ${result.finance.currencyEmoji} → **${account.name}**`
              : `Abgebucht: **${fmt(result.playerDebited)}** ${cfg.emoji}\nGutgeschrieben: **${fmt(result.accountCredited)}** ${result.finance.currencyEmoji} → **${account.name}**`,
          )
          .addFields(
            { name: 'Quelle', value: sourcePocket === 'WALLET' ? 'Wallet' : 'Bank', inline: false },
            { name: 'Neues Wallet des Kontos', value: `${fmt(result.account.balance)} ${result.finance.currencyEmoji}`, inline: false },
            { name: 'Grund', value: reason, inline: false },
          )
          .setFooter({ text: 'V-Bot Economy' });
        await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        if (result.booked) {
          try {
            await publishVirtualAccountActivityLive(i.client, scope.guildId, connId, account.id, {
              title: '💰 Einzahlung eingegangen', actorDiscordId: scope.actorDiscordId,
              amount: result.accountCredited, pocket: 'WALLET', status: '✅ Akzeptiert', reason,
            });
          } catch (syncError) {
            logger.error(`Virtual-Account Discord-Sync nach /virtual-account pay fehlgeschlagen (${account.id}):`, syncError as Error);
            await i.followUp({ content: 'Die Geldbuchung ist erfolgreich gespeichert. Discord-Archiv/Live-Sync konnte noch nicht aktualisiert werden.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
          }
        }
      } catch (error) {
        await replyError(i, 'Ueberweisung fehlgeschlagen', (error as Error).message);
      }
    }
  }),
};