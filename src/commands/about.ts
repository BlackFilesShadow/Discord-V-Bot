import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { config } from '../config';
import { Colors, vEmbed } from '../utils/embedDesign';
import { BOT_DEVELOPER } from '../modules/ai/botIdentity';

function uploadLimitMiB(): number {
  return Math.max(1, Math.floor(config.upload.maxFileSizeBytes / 1024 / 1024));
}

function currentAboutText(): string {
  return [
    '**V-Bot Prime** ist der Community-, DayZ-/Nitrado- und Automations-Bot dieses Projekts.',
    '',
    '🤖 **AI & Wissen** — Multi-Provider-AI, Server-Kontext, Live-Recherche bei aktuellen Faktfragen und DayZ-1.29-Grounding.',
    '🛡️ **Community** — Moderation, XP/Level, Giveaways, Polls, Tickets, Feedback und persoenliche Erinnerungen.',
    '🎮 **DayZ / Nitrado** — mehrere Gameserver pro Guild, Whitelist, echte Nitrado-Server-Bans inkl. automatischem Ablauf zeitlicher Bans, Fraktionen und Spielidentitaets-Linking.',
    '💰 **Economy & Casino** — servergescoppte Wallet/Bank, Zahlungen, Transfers und Casino-Spiele.',
    `📦 **Hersteller** — /upload und /mypackages bleiben bewusst Discord-Slash-Funktionen; bis zu 10 Dateien pro Upload, aktuell ${uploadLimitMiB()} MiB pro Datei laut Server-Konfiguration.`,
    '🖥️ **Administration** — Bot-Admin- und DEV-Werkzeuge werden im Web-Dashboard verwaltet und nicht mehr als normale Discord-Slash-Commands bereitgestellt.',
    '',
    `Entwickler: **${BOT_DEVELOPER}** · Den aktuellen Discord-Command-Stand findest du jederzeit mit **/help**.`,
  ].join('\n');
}

const aboutCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('stell-dich-vor')
    .setDescription('Stellt V-Bot und seine aktuell verfuegbaren Bereiche vor'),
  async execute(interaction: ChatInputCommandInteraction) {
    const embed = vEmbed(Colors.Info)
      .setTitle('🤖 V-Bot Prime — aktueller Funktionsstand')
      .setDescription(currentAboutText())
      .setFooter({ text: 'V-Bot • Live-Funktionsuebersicht' });
    await interaction.reply({ embeds: [embed], ephemeral: false });
  },
};

export default aboutCommand;
