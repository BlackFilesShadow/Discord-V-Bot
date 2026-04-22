import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
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
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('AI-Features (Groq → Gemini Fallback)')
    .addSubcommand(sc =>
      sc.setName('ask')
        .setDescription('Stelle eine Wissensfrage')
        .addStringOption(o => o.setName('frage').setDescription('Deine Frage').setRequired(true)))
    .addSubcommand(sc =>
      sc.setName('sentiment')
        .setDescription('Analysiere Sentiment eines Textes')
        .addStringOption(o => o.setName('text').setDescription('Text').setRequired(true)))
    .addSubcommand(sc =>
      sc.setName('toxicity')
        .setDescription('Prüfe Text auf Toxizität')
        .addStringOption(o => o.setName('text').setDescription('Text').setRequired(true)))
    .addSubcommand(sc =>
      sc.setName('translate')
        .setDescription('Übersetze einen Text')
        .addStringOption(o => o.setName('text').setDescription('Text').setRequired(true))
        .addStringOption(o => o.setName('sprache').setDescription('Zielsprache (z.B. en, de, fr)').setRequired(false))),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    const start = Date.now();

    try {
      let title = '';
      let body = '';

      if (sub === 'ask') {
        const q = interaction.options.getString('frage', true);
        const r = await answerQuestion(q);
        title = '🤖  AI-Antwort';
        body = r.success ? r.result || '_(leer)_' : `❌ ${r.error}`;
      } else if (sub === 'sentiment') {
        const t = interaction.options.getString('text', true);
        const r = await analyzeSentiment(t);
        title = '📊  Sentiment-Analyse';
        body = r.success
          ? `**Label:** ${r.label}\n**Score:** ${r.score}\n\`\`\`json\n${JSON.stringify(r.details, null, 2).slice(0, 1500)}\n\`\`\``
          : `❌ ${r.error}`;
      } else if (sub === 'toxicity') {
        const t = interaction.options.getString('text', true);
        const r = await detectToxicity(t);
        title = '🚨  Toxicity-Check';
        body = r.success
          ? `**Status:** ${r.label}\n**Score:** ${r.score}\n\`\`\`json\n${JSON.stringify(r.details, null, 2).slice(0, 1500)}\n\`\`\``
          : `❌ ${r.error}`;
      } else if (sub === 'translate') {
        const t = interaction.options.getString('text', true);
        const lang = interaction.options.getString('sprache') || 'de';
        const r = await translateText(t, lang);
        title = `🌐  Übersetzung → ${lang}`;
        body = r.success ? r.result || '_(leer)_' : `❌ ${r.error}`;
      }

      const embed = vEmbed(Colors.Info)
        .setTitle(title)
        .setDescription(body.slice(0, 4000))
        .setFooter({ text: `${Date.now() - start}ms` });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      const embed = vEmbed(Colors.Error)
        .setTitle('❌  AI-Fehler')
        .setDescription(String(err).slice(0, 2000));
      await interaction.editReply({ embeds: [embed] });
    }
  },
};

export default aiCommand;
