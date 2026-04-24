import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { config } from '../../config';
import prisma from '../../database/prisma';
import {
  ALL_PROVIDERS,
  ProviderName,
  getStats,
  getRankedProviders,
  probeProvider,
  getAllCooldowns,
  clearCooldown,
} from '../../modules/ai/providerStats';

async function isAdminOrOwner(discordId: string): Promise<boolean> {
  if (config.discord.ownerId && config.discord.ownerId === discordId) return true;
  const u = await prisma.user.findUnique({ where: { discordId }, select: { role: true } });
  if (!u) return false;
  return ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(u.role);
}

function fmtDate(d: Date | null): string {
  if (!d) return '-';
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Berlin',
  }).format(d);
}

const adminAiModelsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-aimodels')
    .setDescription('AI-Provider-Health, Reihenfolge und Live-Probe')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Persistente Provider-Statistik (success rate, latenz)'),
    )
    .addSubcommand((sub) =>
      sub.setName('order').setDescription('Aktuelle adaptive Provider-Reihenfolge'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('probe')
        .setDescription('Live-Ping an einen Provider mit Latenz-Messung')
        .addStringOption((o) =>
          o
            .setName('provider')
            .setDescription('Welcher Provider')
            .setRequired(true)
            .addChoices(
              { name: 'groq', value: 'groq' },
              { name: 'cerebras', value: 'cerebras' },
              { name: 'openrouter', value: 'openrouter' },
              { name: 'gemini', value: 'gemini' },
              { name: 'openai', value: 'openai' },
              { name: 'alle', value: 'all' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Statistik fuer einen Provider zuruecksetzen')
        .addStringOption((o) =>
          o
            .setName('provider')
            .setDescription('Welcher Provider (oder alle)')
            .setRequired(true)
            .addChoices(
              { name: 'groq', value: 'groq' },
              { name: 'cerebras', value: 'cerebras' },
              { name: 'openrouter', value: 'openrouter' },
              { name: 'gemini', value: 'gemini' },
              { name: 'openai', value: 'openai' },
              { name: 'alle', value: 'all' },
            ),
        ),
    ) as SlashCommandBuilder,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });
    if (!(await isAdminOrOwner(interaction.user.id))) {
      await interaction.editReply({
        embeds: [vEmbed(Colors.Error).setTitle('❌ Keine Berechtigung').setDescription('Nur Owner oder Admin.')],
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      const stats = await getStats();
      const cooldowns = new Map(getAllCooldowns().map((c) => [c.provider, c]));
      const lines = stats.map((s) => {
        const cfg = s.configured ? '✅' : '⚪';
        const total = s.successCount + s.failureCount + s.rateLimitCount;
        const rate = total > 0 ? `${Math.round(s.successRate * 100)}%` : '—';
        const avg = s.avgLatencyMs > 0 ? `${s.avgLatencyMs}ms` : '—';
        const cd = cooldowns.get(s.provider);
        const cdStr = cd ? ` ⏳${Math.ceil(cd.remainingMs / 1000)}s` : '';
        return `${cfg} \`${s.provider.padEnd(10)}\` ${rate.padStart(4)} | ${avg.padStart(7)} | ✓${s.successCount} ✗${s.failureCount} ⏱${s.rateLimitCount}${cdStr} | last ok: ${fmtDate(s.lastSuccessAt)}`;
      });
      await interaction.editReply({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle('🤖 AI-Provider Status')
            .setDescription(['```', ...lines, '```'].join('\n').slice(0, 4000))
            .setFooter({ text: 'success-rate | avg-latenz | ✓ok ✗fail ⏱429 ⏳cooldown' }),
        ],
      });
      return;
    }

    if (sub === 'order') {
      const ranked = await getRankedProviders();
      const stats = await getStats();
      const statMap = new Map(stats.map((s) => [s.provider, s]));
      const lines = ranked.map((p, i) => {
        const s = statMap.get(p);
        const rate = s && (s.successCount + s.failureCount + s.rateLimitCount) > 0
          ? `${Math.round(s.successRate * 100)}%` : 'neu';
        const avg = s && s.avgLatencyMs > 0 ? `${s.avgLatencyMs}ms` : '—';
        return `${i + 1}. \`${p}\` (${rate}, ${avg})`;
      });
      await interaction.editReply({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle('📊 Adaptive Provider-Reihenfolge')
            .setDescription(lines.join('\n') || 'Keine konfigurierten Provider.')
            .setFooter({ text: `Primary (Konfig): ${config.ai.provider}` }),
        ],
      });
      return;
    }

    if (sub === 'probe') {
      const target = interaction.options.getString('provider', true);
      const targets: ProviderName[] = target === 'all' ? ALL_PROVIDERS : [target as ProviderName];
      const results: string[] = [];
      for (const p of targets) {
        const r = await probeProvider(p);
        results.push(
          r.ok
            ? `✅ \`${p.padEnd(10)}\` ${String(r.latencyMs).padStart(5)}ms — "${(r.reply || '').replace(/\n/g, ' ').slice(0, 40)}"`
            : `❌ \`${p.padEnd(10)}\` ${String(r.latencyMs).padStart(5)}ms — ${r.error}`,
        );
      }
      await interaction.editReply({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle('🔬 Provider-Probe')
            .setDescription(['```', ...results, '```'].join('\n').slice(0, 4000)),
        ],
      });
      return;
    }

    if (sub === 'reset') {
      const target = interaction.options.getString('provider', true);
      if (target === 'all') {
        await prisma.aiProviderStat.deleteMany({});
        for (const p of ALL_PROVIDERS) clearCooldown(p);
      } else {
        await prisma.aiProviderStat.deleteMany({ where: { provider: target } });
        clearCooldown(target as ProviderName);
      }
      await interaction.editReply({
        embeds: [
          vEmbed(Colors.Success)
            .setTitle('🧹 Statistik zurueckgesetzt')
            .setDescription(target === 'all' ? 'Alle Provider-Stats + Cooldowns geloescht.' : `Stats + Cooldown fuer \`${target}\` geloescht.`),
        ],
      });
      return;
    }
  },
};

export default adminAiModelsCommand;
