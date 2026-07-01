import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { logger } from '../../utils/logger';
import {
  answerQuestion,
  analyzeSentiment,
  detectToxicity,
  translateText,
} from '../../modules/ai/aiHandler';

/**
 * /ai – Test- und Nutzungsschnittstelle für AI-Features.
 * Subcommands: ask, sentiment, toxicity, translate
 */
export const aiCommand: Command = {
  // P0: Per-User Cooldown 30s. Schuetzt Provider-Quoten + Cost vor
  // Spam (jeder Aufruf trifft Groq/Gemini/OpenAI). Wird vom zentralen
  // Cooldown-Handler in src/utils/cooldown.ts erzwungen (key=userId+cmd).
  cooldown: 30,
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('AI-Features (Groq → Gemini Fallback)')
    .addSubcommand(sc =>
      sc.setName('ask')
        .setDescription('Stelle eine Wissensfrage')
        .addStringOption(o => o.setName('frage').setDescription('Deine Frage').setRequired(true).setMaxLength(2000)))
    .addSubcommand(sc =>
      sc.setName('sentiment')
        .setDescription('Analysiere Sentiment eines Textes')
        .addStringOption(o => o.setName('text').setDescription('Text').setRequired(true).setMaxLength(2000)))
    .addSubcommand(sc =>
      sc.setName('toxicity')
        .setDescription('Prüfe Text auf Toxizität')
        .addStringOption(o => o.setName('text').setDescription('Text').setRequired(true).setMaxLength(2000)))
    .addSubcommand(sc =>
      sc.setName('translate')
        .setDescription('Übersetze einen Text')
        .addStringOption(o => o.setName('text').setDescription('Text').setRequired(true).setMaxLength(2000))
        .addStringOption(o => o.setName('sprache').setDescription('Zielsprache (z.B. en, de, fr)').setRequired(false).setMaxLength(20))),

  execute: async (interaction: ChatInputCommandInteraction) => {
    // Ephemeral: AI-Antworten + Fehler nur fuer den Aufrufer sichtbar
    // (kein Public-Spam, keine ungewollte Info-Weitergabe).
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const start = Date.now();

    // Provider-Fehlertexte NIE roh an den Nutzer geben (koennen interne
    // Details/Endpoints enthalten). Intern loggen, generisch antworten.
    const aiErr = (detail: string | undefined): string => {
      logger.warn(`/ai ${sub} fehlgeschlagen: ${detail ?? 'unbekannt'}`);
      return '❌ Die KI-Anfrage ist fehlgeschlagen. Bitte versuche es später erneut.';
    };

    try {
      let title = '';
      let body = '';

      if (sub === 'ask') {
        const q = interaction.options.getString('frage', true);
        const r = await answerQuestion(q, { mode: 'oneshot' });
        title = '🤖  AI-Antwort';
        body = r.success ? r.result || '_(leer)_' : aiErr(r.error);
      } else if (sub === 'sentiment') {
        const t = interaction.options.getString('text', true);
        const r = await analyzeSentiment(t);
        title = '📊  Sentiment-Analyse';
        body = r.success
          ? `**Label:** ${r.label}\n**Score:** ${r.score}\n\`\`\`json\n${JSON.stringify(r.details, null, 2).slice(0, 1500)}\n\`\`\``
          : aiErr(r.error);
      } else if (sub === 'toxicity') {
        const t = interaction.options.getString('text', true);
        const r = await detectToxicity(t);
        title = '🚨  Toxicity-Check';
        body = r.success
          ? `**Status:** ${r.label}\n**Score:** ${r.score}\n\`\`\`json\n${JSON.stringify(r.details, null, 2).slice(0, 1500)}\n\`\`\``
          : aiErr(r.error);
      } else if (sub === 'translate') {
        const t = interaction.options.getString('text', true);
        const lang = interaction.options.getString('sprache') || 'de';
        const r = await translateText(t, lang);
        title = `🌐  Übersetzung → ${lang}`;
        body = r.success ? r.result || '_(leer)_' : aiErr(r.error);
      }

      const embed = vEmbed(Colors.Info)
        .setTitle(title)
        .setDescription(body.slice(0, 4000))
        .setFooter({ text: `${Date.now() - start}ms` });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error(`/ai ${sub} Ausnahme`, err as Error);
      const embed = vEmbed(Colors.Error)
        .setTitle('❌  AI-Fehler')
        .setDescription('Die KI-Anfrage ist fehlgeschlagen. Bitte versuche es später erneut.');
      await interaction.editReply({ embeds: [embed] });
    }
  },
};

export default aiCommand;
