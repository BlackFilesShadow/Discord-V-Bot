import { createHmac, timingSafeEqual } from 'node:crypto';
import { AdmEventType, GameplayFeedKind } from '@prisma/client';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { config } from '../../config';
import prisma from '../../database/prisma';
import { safeEmbedField } from '../../utils/embedSanitize';
import { vEmbed } from '../../utils/embedDesign';
import { resolveDelegatedPermissionContext } from '../permissions/access';

const CUSTOM_ID_PREFIX = 'flagshort:v1:';
const CORRELATION_WINDOW_MS = 10 * 60_000;
const SHORT_SESSION_SECONDS = 15 * 60;
const MAX_OTHER_SESSIONS = 8;
const MAX_OTHER_SESSION_CANDIDATES = MAX_OTHER_SESSIONS * 16;

function signature(eventId: string): string {
  return createHmac('sha256', config.security.encryptionKey)
    .update(`flag-activity\u0000${eventId}`)
    .digest('hex')
    .slice(0, 20);
}

export function buildFlagActivityCustomId(eventId: string): string {
  return `${CUSTOM_ID_PREFIX}${eventId}:${signature(eventId)}`;
}

export function verifyFlagActivityCustomId(customId: string): string | null {
  if (!customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(CUSTOM_ID_PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  const eventId = rest.slice(0, split);
  const supplied = rest.slice(split + 1);
  if (!/^c[a-z0-9]{24}$/.test(eventId) || !/^[a-f0-9]{20}$/.test(supplied)) return null;
  const expected = signature(eventId);
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b) ? eventId : null;
}

export interface HorizontalPosition {
  x: number;
  z: number;
}

/** DayZ-ADM liefert typischerweise X,Y,Z. Fuer Karten-/Distanzlogik ist Y die Hoehe. */
export function parseHorizontalPosition(raw: string | null): HorizontalPosition | null {
  if (!raw) return null;
  const values = raw
    .replace(/[<>]/g, '')
    .split(',')
    .map(part => Number(part.trim()));
  if (values.length < 2 || values.some(value => !Number.isFinite(value))) return null;
  return values.length >= 3
    ? { x: values[0], z: values[2] }
    : { x: values[0], z: values[1] };
}

export function horizontalDistanceMeters(a: string | null, b: string | null): number | null {
  const pa = parseHorizontalPosition(a);
  const pb = parseHorizontalPosition(b);
  if (!pa || !pb) return null;
  return Math.round(Math.hypot(pa.x - pb.x, pa.z - pb.z) * 10) / 10;
}

function discordTime(value: Date | null, style: 'F' | 'T' = 'T'): string {
  return value ? `<t:${Math.floor(value.getTime() / 1000)}:${style}>` : 'nicht ermittelbar';
}

function durationLabel(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return minutes > 0 ? `${minutes} Min. ${rest} Sek.` : `${rest} Sek.`;
}

function distanceLabel(distance: number | null): string {
  return distance === null ? 'Position zum Ereignis nicht ausreichend bekannt' : `ca. ${distance} m von der Flagge`;
}

async function hasFlagFeedPermission(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.user.id === config.discord.ownerId || interaction.guild.ownerId === interaction.user.id) return true;
  const delegated = await resolveDelegatedPermissionContext(interaction.guild, interaction.user.id);
  return delegated.permissions.has('killfeed.view')
    || delegated.permissions.has('killfeed.manage')
    || delegated.permissions.has('dashboard.access');
}

export type FlagActivitySessionRow = {
  id: string;
  gameId: string;
  playerName: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  durationSeconds: number;
  status: 'OPEN' | 'CLOSED';
};

type PositionRow = {
  actorGameId: string | null;
  actorPosition: string | null;
  occurredAt: Date | null;
};

function nearestPositions(rows: PositionRow[], eventAt: Date): Map<string, string> {
  const out = new Map<string, { delta: number; position: string }>();
  for (const row of rows) {
    if (!row.actorGameId || !row.actorPosition || !row.occurredAt) continue;
    const delta = Math.abs(row.occurredAt.getTime() - eventAt.getTime());
    const existing = out.get(row.actorGameId);
    if (!existing || delta < existing.delta) out.set(row.actorGameId, { delta, position: row.actorPosition });
  }
  return new Map(Array.from(out.entries()).map(([id, value]) => [id, value.position]));
}

function sessionDistanceToEventMs(session: FlagActivitySessionRow, eventAt: Date): number {
  const eventMs = eventAt.getTime();
  const connectedMs = session.connectedAt?.getTime() ?? null;
  const disconnectedMs = session.disconnectedAt?.getTime() ?? null;

  if (connectedMs !== null && connectedMs > eventMs) return connectedMs - eventMs;
  if (disconnectedMs !== null && disconnectedMs < eventMs) return eventMs - disconnectedMs;
  return 0;
}

function isMoreRelevantSession(
  candidate: FlagActivitySessionRow,
  current: FlagActivitySessionRow,
  eventAt: Date,
): boolean {
  const candidateDistance = sessionDistanceToEventMs(candidate, eventAt);
  const currentDistance = sessionDistanceToEventMs(current, eventAt);
  if (candidateDistance !== currentDistance) return candidateDistance < currentDistance;

  const candidateConnected = candidate.connectedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const currentConnected = current.connectedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (candidateConnected !== currentConnected) return candidateConnected > currentConnected;

  return candidate.id.localeCompare(current.id) < 0;
}

/**
 * Pro DayZ-Spieler darf im Korrelations-Embed hoechstens eine Session auftauchen.
 * Die stabile Identitaet ist gameId, nicht Session-ID oder sichtbarer Spielername.
 */
export function selectRelevantFlagSessions(
  candidates: FlagActivitySessionRow[],
  eventAt: Date,
  directGameId: string | null,
  limit = MAX_OTHER_SESSIONS,
): FlagActivitySessionRow[] {
  const byGameId = new Map<string, FlagActivitySessionRow>();

  for (const session of candidates) {
    if (directGameId && session.gameId === directGameId) continue;
    if (session.status !== 'CLOSED' || !session.disconnectedAt) continue;
    if (session.durationSeconds > SHORT_SESSION_SECONDS) continue;

    const current = byGameId.get(session.gameId);
    if (!current || isMoreRelevantSession(session, current, eventAt)) {
      byGameId.set(session.gameId, session);
    }
  }

  return Array.from(byGameId.values())
    .sort((a, b) => {
      const distanceDelta = sessionDistanceToEventMs(a, eventAt) - sessionDistanceToEventMs(b, eventAt);
      if (distanceDelta !== 0) return distanceDelta;

      const durationDelta = a.durationSeconds - b.durationSeconds;
      if (durationDelta !== 0) return durationDelta;

      const aConnected = a.connectedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bConnected = b.connectedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (aConnected !== bConnected) return bConnected - aConnected;
      return a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, limit));
}

export function formatFlagSessionDetails(
  session: FlagActivitySessionRow,
  eventAt: Date,
  flagPosition: string | null,
  nearestPosition: string | null,
): string {
  if (session.status === 'OPEN' || !session.disconnectedAt) {
    const elapsed = session.connectedAt
      ? Math.max(0, Math.round((Date.now() - session.connectedAt.getTime()) / 1000))
      : 0;
    return [
      `Online gekommen: ${discordTime(session.connectedAt)}`,
      `Flaggenereignis: ${discordTime(eventAt)}`,
      `Status: **noch online**${elapsed ? ` (bisher ${durationLabel(elapsed)})` : ''}`,
      'Kurzzeit-Bewertung erst nach Disconnect möglich.',
      distanceLabel(horizontalDistanceMeters(nearestPosition, flagPosition)),
    ].join('\n');
  }

  const eventMs = eventAt.getTime();
  const connectedMs = session.connectedAt?.getTime() ?? null;
  const disconnectedMs = session.disconnectedAt.getTime();
  const sessionEndedBeforeEvent = disconnectedMs < eventMs;

  const relationLines = sessionEndedBeforeEvent
    ? [`Disconnect → Flagge: ${durationLabel((eventMs - disconnectedMs) / 1000)}`]
    : [
        connectedMs === null
          ? null
          : `Connect → Flagge: ${durationLabel((eventMs - connectedMs) / 1000)}`,
        `Flagge → Disconnect: ${durationLabel((disconnectedMs - eventMs) / 1000)}`,
      ];

  return [
    `Online gekommen: ${discordTime(session.connectedAt)}`,
    `Flaggenereignis: ${discordTime(eventAt)}`,
    `Offline gegangen: ${discordTime(session.disconnectedAt)}`,
    `Gesamte Session: **${durationLabel(session.durationSeconds)}**`,
    ...relationLines,
    distanceLabel(horizontalDistanceMeters(nearestPosition, flagPosition)),
  ].filter(Boolean).join('\n');
}

export async function handleFlagActivityButton(interaction: ButtonInteraction): Promise<void> {
  const eventId = verifyFlagActivityCustomId(interaction.customId);
  if (!eventId || !interaction.guildId || !interaction.guild || !interaction.channelId) {
    await interaction.reply({ content: 'Ungültige oder abgelaufene Flaggen-Interaktion.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!(await hasFlagFeedPermission(interaction))) {
    await interaction.reply({ content: 'Dir fehlt die Berechtigung, Flaggen-Aktivitäten auszuwerten.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Der signierte Event-Verweis reicht nicht allein: Er muss genau zu der
  // gespeicherten SENT-Delivery dieser Discord-Nachricht und dieses Channels
  // gehoeren. Erst daraus wird der Gameserver-Scope bestimmt. Kopierte Buttons
  // aus anderen Nachrichten/Channels/Guilds scheitern fail-closed.
  const delivery = await prisma.gameplayFeedDelivery.findFirst({
    where: {
      admEventId: eventId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
      status: 'SENT',
    },
    select: { configId: true, nitradoConnId: true },
  });
  if (!delivery) {
    await interaction.editReply({ content: 'Die Flaggen-Interaktion gehört nicht zu dieser Feed-Nachricht.' });
    return;
  }

  const feedConfig = await prisma.gameplayFeedConfig.findFirst({
    where: {
      id: delivery.configId,
      guildId: interaction.guildId,
      nitradoConnId: delivery.nitradoConnId,
      kind: GameplayFeedKind.FLAG,
    },
    select: { id: true },
  });
  if (!feedConfig) {
    await interaction.editReply({ content: 'Der zugehörige Flaggen-Feed ist nicht mehr vorhanden.' });
    return;
  }

  const event = await prisma.flagActivityEvent.findFirst({
    where: {
      id: eventId,
      guildId: interaction.guildId,
      nitradoConnId: delivery.nitradoConnId,
    },
  });
  if (!event) {
    await interaction.editReply({ content: 'Das Flaggenereignis ist in diesem Gameserver-Scope nicht vorhanden.' });
    return;
  }

  const connection = await prisma.nitradoConnection.findFirst({
    where: { id: event.nitradoConnId, guildId: event.guildId },
    select: { alias: true },
  });
  const embed = vEmbed(event.action === 'RAISED' ? 0x22c55e : 0xeab308)
    .setTitle('🔎 Flaggen-Aktivität')
    .setDescription(`${event.action === 'RAISED' ? '🚩 Flagge hoch' : '🏳️ Flagge runter'} · ${safeEmbedField(connection?.alias || 'DayZ-Server', 128)}`)
    .addFields(
      { name: 'Ereigniszeit', value: discordTime(event.occurredAt, 'F'), inline: false },
      { name: 'Flaggen-Koordinaten', value: safeEmbedField(event.flagPosition || 'nicht ermittelbar', 256), inline: false },
    );

  if (!event.occurredAt) {
    embed.addFields({
      name: '🎯 Direkt im ADM geloggter Spieler',
      value: `${safeEmbedField(event.actorName || 'Unbekannt', 256)}\nZeitkorrelation nicht möglich, da der ADM-Zeitstempel nicht auflösbar war.`,
      inline: false,
    });
    embed.setFooter({ text: 'Zeitliche/räumliche Korrelation ist kein Beweis für die Absicht eines Spielers.' });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const eventAt = event.occurredAt;
  const before = new Date(eventAt.getTime() - CORRELATION_WINDOW_MS);
  const after = new Date(eventAt.getTime() + CORRELATION_WINDOW_MS);

  const [directSession, nearbySessions] = await Promise.all([
    event.actorGameId
      ? prisma.playerSession.findFirst({
          where: {
            guildId: event.guildId,
            nitradoConnId: event.nitradoConnId,
            gameId: event.actorGameId,
            connectedAt: { lte: eventAt },
            OR: [{ disconnectedAt: null }, { disconnectedAt: { gte: eventAt } }],
          },
          orderBy: { connectedAt: 'desc' },
        })
      : Promise.resolve(null),
    prisma.playerSession.findMany({
      where: {
        guildId: event.guildId,
        nitradoConnId: event.nitradoConnId,
        ...(event.actorGameId ? { gameId: { not: event.actorGameId } } : {}),
        connectedAt: { gte: before, lte: eventAt },
        disconnectedAt: { gte: before },
        durationSeconds: { lte: SHORT_SESSION_SECONDS },
        status: 'CLOSED',
      },
      orderBy: [{ connectedAt: 'desc' }, { id: 'asc' }],
      take: MAX_OTHER_SESSION_CANDIDATES,
    }),
  ]);

  const direct = directSession as FlagActivitySessionRow | null;
  const shortOthers = selectRelevantFlagSessions(
    nearbySessions as FlagActivitySessionRow[],
    eventAt,
    event.actorGameId,
  );
  const sessions = direct ? [direct, ...shortOthers] : shortOthers;

  const gameIds = Array.from(new Set(sessions.map(session => session.gameId)));
  const positionRows = gameIds.length === 0 ? [] : await prisma.admEvent.findMany({
    where: {
      guildId: event.guildId,
      nitradoConnId: event.nitradoConnId,
      eventType: AdmEventType.PLAYER_POSITION,
      actorGameId: { in: gameIds },
      occurredAt: { gte: before, lte: after },
    },
    select: { actorGameId: true, actorPosition: true, occurredAt: true },
    orderBy: { occurredAt: 'asc' },
  });
  const nearest = nearestPositions(positionRows, eventAt);

  const directPosition = event.actorPosition || (direct ? nearest.get(direct.gameId) : null) || null;
  embed.addFields({
    name: '🎯 Direkt im ADM geloggter Spieler',
    value: safeEmbedField([
      `**${event.actorName || direct?.playerName || 'Unbekannt'}**`,
      direct
        ? formatFlagSessionDetails(direct, eventAt, event.flagPosition, directPosition)
        : `Aktion: ${event.action === 'RAISED' ? 'Flagge hochgezogen' : 'Flagge heruntergelassen'}\n${distanceLabel(horizontalDistanceMeters(directPosition, event.flagPosition))}\nKeine passende PlayerSession zum Ereignis gefunden.`,
    ].join('\n'), 1024),
    inline: false,
  });

  if (shortOthers.length === 0) {
    embed.addFields({
      name: 'Weitere Kurzzeit-Sessions',
      value: 'Keine weiteren abgeschlossenen Sessions ≤ 15 Minuten im 10-Minuten-Zeitfenster vor der Flaggenaktion erkannt.',
      inline: false,
    });
  } else {
    for (const session of shortOthers) {
      embed.addFields({
        name: `⚠️ Kurzzeit-Session · ${safeEmbedField(session.playerName || 'Unbekannter Spieler', 200)}`,
        value: safeEmbedField(formatFlagSessionDetails(
          session,
          eventAt,
          event.flagPosition,
          nearest.get(session.gameId) ?? null,
        ), 1024),
        inline: false,
      });
    }
  }

  embed.setFooter({ text: 'Zeitliche/räumliche Korrelation ist kein Beweis für die Absicht eines Spielers.' });
  await interaction.editReply({ embeds: [embed] });
}
