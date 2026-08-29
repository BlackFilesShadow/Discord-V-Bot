/**
 * Factions: pro Guild eindeutige Liste (Discord-only, slot-unabhaengig).
 *
 * GET    /                     Liste mit Member-Counts
 * POST   /                     body: voll (siehe validateBody)
 * PATCH  /:id                  body: Subset (Partial-Update)
 * DELETE /:id                  cascadiert FactionMember + Embed wird entfernt
 * POST   /:id/republish        Embed neu posten/aktualisieren
 * POST   /:id/members          body: { userDiscordId, role? }
 * DELETE /:id/members/:userDiscordId
 *
 * High-End Embed-Integration:
 *  - Beim Create wird sofort ein Embed im konfigurierten Kanal gepostet.
 *  - Bei jeder Aenderung (Felder ODER Mitglieder) wird das Embed aktualisiert.
 *  - Bei Channel-Wechsel oder Delete wird das alte Embed entfernt.
 *  - Embed-Channel-Existenz wird vorab geprueft -> klare Fehlermeldung.
 *  - Keine serveruebergreifende Sichtbarkeit: alle Queries scopen via guildId.
 */
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';
import { postFactionEmbed, unpostFactionEmbed, postFactionList, unpostFactionList, assignFactionRole, removeFactionRole, syncFactionRoleAll } from '../../../modules/factions/factionEmbed';
import { asGuildId } from '../../../types/scope';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../../../config';
import { isBlockedHost, safeAxiosGet } from '../../../utils/ssrf';

export const factionsRouter = Router({ mergeParams: true });

const URL_RE = /^https:\/\/[^\s<>"]{4,2000}$/i;
const LOCAL_PATH_RE = /^\/uploads\/factions\/(\d{17,20})\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.(jpe?g|png|webp|gif))$/i;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const VALID_POLICY = new Set(['OPEN', 'REQUEST', 'CLOSED']);
const VALID_STATUS = new Set(['ACTIVE', 'RECRUITING', 'INACTIVE', 'ARCHIVED']);
const VALID_ROLES = new Set(['LEADER', 'TREASURER', 'MEMBER', 'PENDING']);

const DESCRIPTION_MAX = 1000;

const UPLOADS_BASE = config.upload.factionsDir;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_KIND = new Set(['flag', 'banner', 'media']);
type AssetKind = 'flag' | 'banner' | 'media';

const upload = multer({
  // memoryStorage wird für die Magic-Number-Prüfung und das anschließende
  // Schreiben auf Platte benötigt. RAM-Obergrenze pro Request = fileSize.
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 12 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Nur JPG/PNG/WEBP/GIF erlaubt. Videos sind fuer Discord-Embed-Bilder nicht zulaessig.'));
  },
});

const uploadSingleFile: RequestHandler = (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: `Datei zu gross (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`,
        code: 'ASSET_TOO_LARGE',
      });
      return;
    }
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Upload fehlgeschlagen.',
      code: 'ASSET_UPLOAD_REJECTED',
    });
  });
};

function extFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png':  return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif':  return '.gif';
    default: return '.bin';
  }
}

/**
 * Magic-Number-Pruefung: verhindert Mime-Spoofing. Die Video-Faelle bleiben
 * ausschliesslich fuer Rueckwaertskompatibilitaet bestehender Unit-Tests/Alt-Daten
 * erkennbar; neue Uploads lassen nur die vier Bild-MIME-Typen durch.
 */
export function verifyMagicNumber(mime: string, buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const hex = (start: number, len: number) => buf.subarray(start, start + len).toString('hex').toLowerCase();
  const ascii = (start: number, len: number) => buf.subarray(start, start + len).toString('ascii');

  switch (mime) {
    case 'image/jpeg':
      return hex(0, 3) === 'ffd8ff';
    case 'image/png':
      return hex(0, 8) === '89504e470d0a1a0a';
    case 'image/gif':
      return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
    case 'video/webm':
      return hex(0, 4) === '1a45dfa3';
    case 'video/mp4':
    case 'video/quicktime': {
      const box = ascii(4, 4);
      if (box === 'ftyp') return true;
      if (mime === 'video/quicktime') return ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(box);
      return false;
    }
    default:
      return false;
  }
}

function detectImage(buf: Buffer): { mime: string; ext: string } | null {
  for (const mime of ALLOWED_MIME) {
    if (verifyMagicNumber(mime, buf)) return { mime, ext: extFor(mime) };
  }
  return null;
}

function isAcceptableAssetRef(s: string): boolean {
  if (LOCAL_PATH_RE.test(s)) return true;
  if (!URL_RE.test(s)) return false;
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (isBlockedHost(u.hostname)) return false;
  return true;
}

class AssetValidationError extends Error {}

interface MaterializedAsset {
  url: string | null;
  createdPath?: string;
  draftPath?: string;
}

function assetField(kind: AssetKind): 'flagUrl' | 'bannerUrl' | 'mediaUrl' {
  return kind === 'flag' ? 'flagUrl' : kind === 'banner' ? 'bannerUrl' : 'mediaUrl';
}

function ownedLocalPath(url: string | null | undefined, guildId: string, factionId: string): string | null {
  if (!url) return null;
  const m = LOCAL_PATH_RE.exec(url);
  if (!m || m[1] !== guildId || m[2] !== factionId) return null;
  const full = path.resolve(UPLOADS_BASE, guildId, factionId, m[3]);
  const root = path.resolve(UPLOADS_BASE, guildId, factionId);
  return full.startsWith(`${root}${path.sep}`) ? full : null;
}

async function writePermanentAsset(
  guildId: string,
  factionId: string,
  kind: AssetKind,
  buffer: Buffer,
  ext: string,
): Promise<{ url: string; fullPath: string }> {
  const dir = path.resolve(UPLOADS_BASE, guildId, factionId);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${kind}-${randomUUID()}${ext}`;
  const fullPath = path.resolve(dir, filename);
  if (!fullPath.startsWith(`${dir}${path.sep}`)) throw new AssetValidationError('Ungueltiger Asset-Pfad.');
  await fs.writeFile(fullPath, buffer, { flag: 'wx' });
  return { url: `/uploads/factions/${guildId}/${factionId}/${filename}`, fullPath };
}

async function materializeAssetRef(
  guildId: string,
  factionId: string,
  kind: AssetKind,
  value: string | null,
): Promise<MaterializedAsset> {
  if (!value) return { url: null };

  const local = LOCAL_PATH_RE.exec(value);
  if (local) {
    const [, assetGuildId, ownerId, filename] = local;
    if (assetGuildId !== guildId) throw new AssetValidationError('Asset gehoert zu einer anderen Guild.');
    if (!(filename.startsWith(`${kind}-`) || filename.startsWith(`${kind}.`))) {
      throw new AssetValidationError(`Asset passt nicht zum Typ ${kind}.`);
    }
    if (ownerId !== '_drafts' && ownerId !== factionId) {
      throw new AssetValidationError('Asset gehoert zu einer anderen Fraktion.');
    }

    const sourceDir = path.resolve(UPLOADS_BASE, guildId, ownerId);
    const sourcePath = path.resolve(sourceDir, filename);
    if (!sourcePath.startsWith(`${sourceDir}${path.sep}`)) throw new AssetValidationError('Ungueltiger Asset-Pfad.');
    const buffer = await fs.readFile(sourcePath).catch(() => null);
    if (!buffer) throw new AssetValidationError('Asset-Datei wurde nicht gefunden. Bitte erneut hochladen.');
    const detected = detectImage(buffer);
    if (!detected) throw new AssetValidationError('Asset ist kein gueltiges JPG/PNG/WEBP/GIF.');
    if (buffer.length > MAX_UPLOAD_BYTES) throw new AssetValidationError('Asset ist groesser als 25 MB.');

    if (ownerId === factionId) return { url: value };
    const stored = await writePermanentAsset(guildId, factionId, kind, buffer, detected.ext);
    return { url: stored.url, createdPath: stored.fullPath, draftPath: sourcePath };
  }

  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AssetValidationError('Asset-URL ist ungueltig.'); }
  if (parsed.protocol !== 'https:') throw new AssetValidationError('Externe Assets muessen HTTPS verwenden.');
  if (isBlockedHost(parsed.hostname)) throw new AssetValidationError('Asset-URL verweist auf ein nicht oeffentliches Ziel.');

  try {
    const response = await safeAxiosGet(value, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_UPLOAD_BYTES,
      maxBodyLength: MAX_UPLOAD_BYTES,
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
    }, 'faction-asset');
    const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data as ArrayBuffer);
    if (buffer.length > MAX_UPLOAD_BYTES) throw new AssetValidationError('Asset ist groesser als 25 MB.');
    const detected = detectImage(buffer);
    if (!detected) throw new AssetValidationError('Externe URL liefert kein gueltiges JPG/PNG/WEBP/GIF.');
    const stored = await writePermanentAsset(guildId, factionId, kind, buffer, detected.ext);
    return { url: stored.url, createdPath: stored.fullPath };
  } catch (e) {
    if (e instanceof AssetValidationError) throw e;
    throw new AssetValidationError(`Externes Asset konnte nicht sicher geladen werden: ${(e as Error).message}`);
  }
}

async function materializeAssetFields(
  data: Record<string, unknown>,
  guildId: string,
  factionId: string,
): Promise<{ patch: Record<string, string | null>; createdPaths: string[]; draftPaths: string[] }> {
  const patch: Record<string, string | null> = {};
  const createdPaths: string[] = [];
  const draftPaths: string[] = [];
  try {
    for (const kind of ['flag', 'banner', 'media'] as const) {
      const field = assetField(kind);
      if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
      const out = await materializeAssetRef(guildId, factionId, kind, (data[field] as string | null | undefined) ?? null);
      patch[field] = out.url;
      if (out.createdPath) createdPaths.push(out.createdPath);
      if (out.draftPath) draftPaths.push(out.draftPath);
    }
    return { patch, createdPaths, draftPaths };
  } catch (e) {
    await Promise.all(createdPaths.map(p => fs.unlink(p).catch(() => {})));
    throw e;
  }
}

async function cleanupPaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map(p => fs.unlink(p).catch(() => {})));
}

function assetErrorResponse(res: Parameters<RequestHandler>[1], e: unknown): boolean {
  if (!(e instanceof AssetValidationError)) return false;
  res.status(400).json({ error: e.message, code: 'INVALID_FACTION_ASSET' });
  return true;
}

interface FactionBody {
  name?: string;
  flagUrl?: string;
  bannerUrl?: string | null;
  mediaUrl?: string | null;
  description?: string | null;
  color?: string | null;
  leaderDiscordId?: string | null;
  deputyDiscordId?: string | null;
  treasurerDiscordId?: string | null;
  embedChannelId?: string | null;
  roleId?: string | null;
  joinPolicy?: string;
  status?: string;
  isActive?: boolean;
}

function validateBody(b: FactionBody, partial: boolean): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};

  if (b.name !== undefined) {
    if (typeof b.name !== 'string') return { ok: false, error: 'name muss String sein.' };
    const n = b.name.trim();
    if (n.length < 2 || n.length > 60) return { ok: false, error: 'name 2..60 Zeichen.' };
    data.name = n;
  } else if (!partial) return { ok: false, error: 'name fehlt.' };

  if (b.flagUrl !== undefined) {
    if (b.flagUrl === null || b.flagUrl === '') data.flagUrl = null;
    else if (typeof b.flagUrl === 'string' && isAcceptableAssetRef(b.flagUrl)) data.flagUrl = b.flagUrl;
    else return { ok: false, error: 'flagUrl muss HTTPS-URL oder Upload-Pfad sein.' };
  }

  for (const k of ['bannerUrl', 'mediaUrl'] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null || b[k] === '') data[k] = null;
      else if (typeof b[k] === 'string' && isAcceptableAssetRef(b[k] as string)) data[k] = b[k];
      else return { ok: false, error: `${k} muss HTTPS-URL oder Upload-Pfad sein.` };
    }
  }

  if (b.description !== undefined) {
    if (b.description === null || b.description === '') data.description = null;
    else if (typeof b.description === 'string') {
      const d = b.description.trim();
      if (d.length > DESCRIPTION_MAX) return { ok: false, error: `description max. ${DESCRIPTION_MAX} Zeichen.` };
      data.description = d;
    } else return { ok: false, error: 'description ungueltig.' };
  }

  if (b.color !== undefined) {
    if (b.color === null || b.color === '') data.color = null;
    else if (typeof b.color === 'string' && HEX_RE.test(b.color)) {
      data.color = b.color.startsWith('#') ? b.color : `#${b.color}`;
    } else return { ok: false, error: 'color muss Hex sein (z.B. #dc2626).' };
  }

  for (const k of ['leaderDiscordId', 'deputyDiscordId', 'treasurerDiscordId', 'embedChannelId', 'roleId'] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null || b[k] === '') data[k] = null;
      else if (typeof b[k] === 'string' && SNOWFLAKE_RE.test(b[k] as string)) data[k] = b[k];
      else return { ok: false, error: `${k} ungueltig (Discord-Snowflake erwartet).` };
    }
  }

  if (b.joinPolicy !== undefined) {
    if (typeof b.joinPolicy !== 'string' || !VALID_POLICY.has(b.joinPolicy)) return { ok: false, error: 'joinPolicy ungueltig.' };
    data.joinPolicy = b.joinPolicy;
  }

  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !VALID_STATUS.has(b.status)) return { ok: false, error: 'status ungueltig.' };
    data.status = b.status;
  }

  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') return { ok: false, error: 'isActive muss bool sein.' };
    data.isActive = b.isActive;
  }

  if (partial && Object.keys(data).length === 0) return { ok: false, error: 'Keine gueltigen Felder.' };
  return { ok: true, data };
}

async function ensureChannelInGuild(channelId: string, guildId: string): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return null; // kein Bot-Client (z.B. Tests) -> ueberspringen
  const v = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ]);
  return v.ok ? null : v.reason;
}

async function refreshEmbed(factionId: string, guildId: string, actorUserId: string, action: string): Promise<void> {
  const client = tryGetDashboardClient();
  if (!client) return;
  await postFactionEmbed(client, factionId).catch(err => {
    logAuditDb('FACTION_EMBED_FAILED', 'FACTION', {
      actorUserId, guildId,
      details: { factionId, action, error: (err as Error).message },
    });
  });
}

async function refreshList(guildId: string, actorUserId: string, action: string): Promise<void> {
  const client = tryGetDashboardClient();
  if (!client) return;
  await postFactionList(client, guildId).catch(err => {
    logAuditDb('FACTION_LIST_FAILED', 'FACTION', {
      actorUserId, guildId,
      details: { action, error: (err as Error).message },
    });
  });
}

/**
 * Effektiver Embed-Channel: faction.embedChannelId override SystemConfig.factionChannelId.
 */
async function effectiveEmbedChannel(faction: { embedChannelId: string | null; guildId: string }): Promise<string | null> {
  if (faction.embedChannelId) return faction.embedChannelId;
   
  const cfg = await prisma.factionSystemConfig.findUnique({
    where: { guildId: faction.guildId },
    select: { factionChannelId: true },
  });
  return cfg?.factionChannelId ?? null;
}

factionsRouter.get('/', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const rows = await prisma.faction.findMany({
    where: { guildId: scope.guildId },
    include: {
      _count: { select: { members: true } },
      members: { select: { userDiscordId: true, role: true, joinedAt: true }, orderBy: { joinedAt: 'asc' } },
    },
    orderBy: { name: 'asc' },
  });
  res.json({
    factions: rows.map(f => ({
      id: f.id,
      name: f.name,
      flagUrl: f.flagUrl,
      bannerUrl: f.bannerUrl,
      mediaUrl: f.mediaUrl,
      description: f.description,
      color: f.color,
      leaderDiscordId: f.leaderDiscordId,
      deputyDiscordId: f.deputyDiscordId,
      treasurerDiscordId: f.treasurerDiscordId,
      embedChannelId: f.embedChannelId,
      embedMessageId: f.embedMessageId,
      roleId: f.roleId,
      joinPolicy: f.joinPolicy,
      status: f.status,
      isActive: f.isActive,
      memberCount: f._count.members,
      members: f.members.map(m => ({ userDiscordId: m.userDiscordId, role: m.role, joinedAt: m.joinedAt.toISOString() })),
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    })),
  });
});

factionsRouter.post('/', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;

  const v = validateBody(req.body ?? {}, false);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const embedChannelId = v.data.embedChannelId as string | null | undefined;
  if (embedChannelId) {
    const err = await ensureChannelInGuild(embedChannelId, scope.guildId);
    if (err) { res.status(400).json({ error: err }); return; }
  }

  let f;
  try {
    f = await prisma.faction.create({
      data: {
        guildId: scope.guildId,
        name: v.data.name as string,
        flagUrl: null,
        bannerUrl: null,
        mediaUrl: null,
        description: (v.data.description as string | null | undefined) ?? null,
        color: (v.data.color as string | null | undefined) ?? null,
        leaderDiscordId: (v.data.leaderDiscordId as string | null | undefined) ?? null,
        deputyDiscordId: (v.data.deputyDiscordId as string | null | undefined) ?? null,
        treasurerDiscordId: (v.data.treasurerDiscordId as string | null | undefined) ?? null,
        embedChannelId: (v.data.embedChannelId as string | null | undefined) ?? null,
        roleId: (v.data.roleId as string | null | undefined) ?? null,
        joinPolicy: (v.data.joinPolicy as string | undefined) ?? 'REQUEST',
        status: (v.data.status as string | undefined) ?? 'ACTIVE',
        isActive: (v.data.isActive as boolean | undefined) ?? true,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Fraktion mit diesem Namen existiert schon.' }); return;
    }
    throw e;
  }

  let assets: Awaited<ReturnType<typeof materializeAssetFields>> | null = null;
  try {
    assets = await materializeAssetFields(v.data, scope.guildId, f.id);
    if (Object.keys(assets.patch).length > 0) {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id wurde gerade im Guild-Scope erzeugt.
      f = await prisma.faction.update({ where: { id: f.id }, data: assets.patch });
    }
    await cleanupPaths(assets.draftPaths);
  } catch (e) {
    if (assets) await cleanupPaths(assets.createdPaths);
    await fs.rm(path.resolve(UPLOADS_BASE, scope.guildId, f.id), { recursive: true, force: true }).catch(() => {});
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Rollback der unmittelbar zuvor erzeugten Faction.
    await prisma.faction.delete({ where: { id: f.id } }).catch(() => {});
    if (assetErrorResponse(res, e)) return;
    throw e;
  }

  logAuditDb('FACTION_CREATED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { factionId: f.id, name: f.name },
  });
  const effectiveCh = await effectiveEmbedChannel({ embedChannelId: f.embedChannelId, guildId: scope.guildId });
  if (effectiveCh) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'create');
  if (f.roleId) {
    const cli = tryGetDashboardClient();
    if (cli) {
      for (const uid of [f.leaderDiscordId, f.deputyDiscordId, f.treasurerDiscordId]) {
        if (uid) await assignFactionRole(cli, scope.guildId, uid, f.roleId);
      }
    }
  }
  await refreshList(scope.guildId, req.auth!.userId, 'faction-created');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.status(201).json({ id: f.id, name: f.name });
});

factionsRouter.patch('/:id', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

  const v = validateBody(req.body ?? {}, true);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const newEmbedCh = v.data.embedChannelId as string | null | undefined;
  const willChangeChannel = v.data.embedChannelId !== undefined && newEmbedCh !== existing.embedChannelId;

  if (willChangeChannel && newEmbedCh) {
    const err = await ensureChannelInGuild(newEmbedCh, scope.guildId);
    if (err) { res.status(400).json({ error: err }); return; }
  }

  let assets: Awaited<ReturnType<typeof materializeAssetFields>>;
  try {
    assets = await materializeAssetFields(v.data, scope.guildId, existing.id);
  } catch (e) {
    if (assetErrorResponse(res, e)) return;
    throw e;
  }

  if (willChangeChannel && existing.embedMessageId) {
    const client = tryGetDashboardClient();
    if (client) await unpostFactionEmbed(client, existing.id).catch(() => {});
  }

  try {
    const nextData = { ...v.data, ...assets.patch };
    // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
    const updated = await prisma.faction.update({ where: { id: existing.id }, data: nextData });
    await cleanupPaths(assets.draftPaths);
    for (const kind of ['flag', 'banner', 'media'] as const) {
      const field = assetField(kind);
      if (!Object.prototype.hasOwnProperty.call(assets.patch, field)) continue;
      const before = existing[field];
      const after = assets.patch[field];
      if (before && before !== after) {
        const oldPath = ownedLocalPath(before, scope.guildId, existing.id);
        if (oldPath) await fs.unlink(oldPath).catch(() => {});
      }
    }
    logAuditDb('FACTION_UPDATED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { factionId: id, fields: Object.keys(nextData) },
    });
    if (v.data.roleId !== undefined && existing.roleId !== updated.roleId) {
      const cli = tryGetDashboardClient();
      if (cli) {
        if (existing.roleId) {
          // eslint-disable-next-line local/no-unscoped-prisma-query -- updated.id intern verifiziert.
          const mems = await prisma.factionMember.findMany({ where: { factionId: updated.id }, select: { userDiscordId: true } });
          const all = new Set<string>(mems.map(m => m.userDiscordId));
          for (const uid of [existing.leaderDiscordId, existing.deputyDiscordId, existing.treasurerDiscordId]) if (uid) all.add(uid);
          for (const uid of all) await removeFactionRole(cli, scope.guildId, uid, existing.roleId);
        }
        if (updated.roleId) await syncFactionRoleAll(cli, updated.id);
      }
    } else if (updated.roleId) {
      const cli = tryGetDashboardClient();
      if (cli) {
        for (const uid of [updated.leaderDiscordId, updated.deputyDiscordId, updated.treasurerDiscordId]) {
          if (uid) await assignFactionRole(cli, scope.guildId, uid, updated.roleId);
        }
      }
    }
    const effectiveCh = await effectiveEmbedChannel({ embedChannelId: updated.embedChannelId, guildId: scope.guildId });
    if (effectiveCh) await refreshEmbed(updated.id, scope.guildId, req.auth!.userId, 'update');
    await refreshList(scope.guildId, req.auth!.userId, 'faction-updated');
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: id } });
    res.json({ ok: true });
  } catch (e) {
    await cleanupPaths(assets.createdPaths);
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Fraktion mit diesem Namen existiert schon.' }); return;
    }
    throw e;
  }
});

factionsRouter.post('/:id/republish', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  const effChR = await effectiveEmbedChannel({ embedChannelId: existing.embedChannelId, guildId: scope.guildId });
  if (!effChR) { res.status(400).json({ error: 'Kein Embed-Channel konfiguriert (weder Faction- noch System-Channel).' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  try {
    const r = await postFactionEmbed(client, id);
    await refreshList(scope.guildId, req.auth!.userId, 'republish');
    logAuditDb('FACTION_EMBED_REPUBLISHED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: id, messageId: r.messageId },
    });
    res.json({ messageId: r.messageId });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

factionsRouter.delete('/:id', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

  if (existing.embedMessageId) {
    const client = tryGetDashboardClient();
    if (client) await unpostFactionEmbed(client, existing.id).catch(() => {});
  }

  if (existing.roleId) {
    const cli = tryGetDashboardClient();
    if (cli) {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id intern verifiziert.
      const mems = await prisma.factionMember.findMany({ where: { factionId: existing.id }, select: { userDiscordId: true } });
      const all = new Set<string>(mems.map(m => m.userDiscordId));
      for (const uid of [existing.leaderDiscordId, existing.deputyDiscordId, existing.treasurerDiscordId]) if (uid) all.add(uid);
      for (const uid of all) await removeFactionRole(cli, scope.guildId, uid, existing.roleId);
    }
  }

  const factionDir = path.join(UPLOADS_BASE, scope.guildId, existing.id);
  await fs.rm(factionDir, { recursive: true, force: true }).catch(() => {});

  // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
  await prisma.faction.delete({ where: { id: existing.id } });
  logAuditDb('FACTION_DELETED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: id, name: existing.name },
  });
  await refreshList(scope.guildId, req.auth!.userId, 'faction-deleted');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: id } });
  res.json({ ok: true });
});

/**
 * Draft-Upload (ohne Faction-ID): die Datei wird nach erfolgreichem Create/Patch
 * in den permanenten Guild/Faction-Pfad uebernommen. Nur echte Bilder/GIFs.
 */
factionsRouter.post(
  '/upload',
  requireGuildPermission('factions.manage'),
  uploadSingleFile,
  async (req, res) => {
    const scope = req.guildScope!;
    const kind = String(req.query.kind ?? '').toLowerCase();
    if (!ALLOWED_KIND.has(kind)) {
      res.status(400).json({ error: 'kind muss flag|banner|media sein.' });
      return;
    }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'Keine Datei.', code: 'ASSET_FILE_MISSING' }); return; }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      res.status(400).json({ error: 'Nur JPG/PNG/WEBP/GIF erlaubt.', code: 'UNSUPPORTED_ASSET_TYPE' });
      return;
    }
    if (!verifyMagicNumber(file.mimetype, file.buffer)) {
      res.status(400).json({ error: 'Dateiinhalt passt nicht zum MIME-Type.', code: 'INVALID_ASSET_CONTENT' });
      return;
    }
    const ext = extFor(file.mimetype);
    const dir = path.join(UPLOADS_BASE, scope.guildId, '_drafts');
    await fs.mkdir(dir, { recursive: true });

    try {
      const entries = await fs.readdir(dir);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.unlink(path.join(dir, entry)).catch(() => {});
      }
    } catch { /* best-effort cleanup */ }

    const filename = `${kind}-${randomUUID()}${ext}`;
    await fs.writeFile(path.join(dir, filename), file.buffer, { flag: 'wx' });
    const publicUrl = `/uploads/factions/${scope.guildId}/_drafts/${filename}`;
    logAuditDb('FACTION_ASSET_UPLOADED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { kind, draft: true, mime: file.mimetype, size: file.size },
    });
    res.json({ url: publicUrl });
  },
);

factionsRouter.post(
  '/:id/upload',
  requireGuildPermission('factions.manage'),
  uploadSingleFile,
  async (req, res) => {
    const scope = req.guildScope!;
    const id = String(req.params.id);
    const kind = String(req.query.kind ?? '').toLowerCase();
    if (!ALLOWED_KIND.has(kind)) {
      res.status(400).json({ error: 'kind muss flag|banner|media sein.' });
      return;
    }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'Keine Datei.', code: 'ASSET_FILE_MISSING' }); return; }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      res.status(400).json({ error: 'Nur JPG/PNG/WEBP/GIF erlaubt.', code: 'UNSUPPORTED_ASSET_TYPE' });
      return;
    }
    if (!verifyMagicNumber(file.mimetype, file.buffer)) {
      res.status(400).json({ error: 'Dateiinhalt passt nicht zum MIME-Type.', code: 'INVALID_ASSET_CONTENT' });
      return;
    }

    const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
    if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

    const typedKind = kind as AssetKind;
    const detected = detectImage(file.buffer);
    if (!detected) { res.status(400).json({ error: 'Ungueltiger Bildinhalt.', code: 'INVALID_ASSET_CONTENT' }); return; }
    const stored = await writePermanentAsset(scope.guildId, existing.id, typedKind, file.buffer, detected.ext);
    const field = assetField(typedKind);
    const previous = existing[field];

    try {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
      await prisma.faction.update({ where: { id: existing.id }, data: { [field]: stored.url } });
    } catch (e) {
      await fs.unlink(stored.fullPath).catch(() => {});
      throw e;
    }
    const oldPath = ownedLocalPath(previous, scope.guildId, existing.id);
    if (oldPath && oldPath !== stored.fullPath) await fs.unlink(oldPath).catch(() => {});

    logAuditDb('FACTION_ASSET_UPLOADED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { factionId: existing.id, kind, mime: detected.mime, size: file.size },
    });
    const effCh3 = await effectiveEmbedChannel({ embedChannelId: existing.embedChannelId, guildId: scope.guildId });
    if (effCh3) await refreshEmbed(existing.id, scope.guildId, req.auth!.userId, `upload-${kind}`);
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: existing.id } });
    res.json({ url: stored.url });
  },
);

factionsRouter.delete('/:id/asset', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const kind = String(req.query.kind ?? '').toLowerCase();
  if (!ALLOWED_KIND.has(kind)) { res.status(400).json({ error: 'kind muss flag|banner|media sein.' }); return; }
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  const field = assetField(kind as AssetKind);
  const current = existing[field];

  const full = ownedLocalPath(current, scope.guildId, existing.id);
  if (full) await fs.unlink(full).catch(() => {});

  // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
  await prisma.faction.update({ where: { id: existing.id }, data: { [field]: null } });
  logAuditDb('FACTION_ASSET_REMOVED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: existing.id, kind },
  });
  const effCh4 = await effectiveEmbedChannel({ embedChannelId: existing.embedChannelId, guildId: scope.guildId });
  if (effCh4) await refreshEmbed(existing.id, scope.guildId, req.auth!.userId, `remove-${kind}`);
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: existing.id } });
  res.json({ ok: true });
});

factionsRouter.post('/:id/members', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const { userDiscordId, role } = req.body ?? {};
  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const r = typeof role === 'string' && VALID_ROLES.has(role) ? role : 'MEMBER';

  const f = await prisma.faction.findFirst({ where: { id: String(req.params.id), guildId: scope.guildId } });
  if (!f) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

  // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id wurde oben mit guildId-Scope verifiziert; FactionMember erbt Scope via FK
  await prisma.factionMember.upsert({
    where: { factionId_userDiscordId: { factionId: f.id, userDiscordId: target } },
    create: { factionId: f.id, userDiscordId: target, role: r },
    update: { role: r },
  });
  logAuditDb('FACTION_MEMBER_ADDED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: f.id, target, role: r } });
  if (f.roleId) {
    const cli = tryGetDashboardClient();
    if (cli) await assignFactionRole(cli, scope.guildId, target, f.roleId);
  }
  const effCh = await effectiveEmbedChannel({ embedChannelId: f.embedChannelId, guildId: scope.guildId });
  if (effCh) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'member-added');
  await refreshList(scope.guildId, req.auth!.userId, 'member-added');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.status(201).json({ ok: true });
});

factionsRouter.delete('/:id/members/:userDiscordId', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const f = await prisma.faction.findFirst({ where: { id: String(req.params.id), guildId: scope.guildId } });
  if (!f) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id wurde oben mit guildId-Scope verifiziert; FactionMember erbt Scope via FK
  const out = await prisma.factionMember.deleteMany({ where: { factionId: f.id, userDiscordId: target } });
  if (out.count === 0) { res.status(404).json({ error: 'Member nicht gefunden.' }); return; }
  logAuditDb('FACTION_MEMBER_REMOVED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: f.id, target } });
  if (f.roleId) {
    const cli = tryGetDashboardClient();
    if (cli) await removeFactionRole(cli, scope.guildId, target, f.roleId);
  }
  const effCh2 = await effectiveEmbedChannel({ embedChannelId: f.embedChannelId, guildId: scope.guildId });
  if (effCh2) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'member-removed');
  await refreshList(scope.guildId, req.auth!.userId, 'member-removed');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.json({ ok: true });
});

// ============================================================================
// System-Config (Guild-weit): zentraler Sammel-Channel + Liste
// ============================================================================

factionsRouter.get('/system-config', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const cfg = await prisma.factionSystemConfig.findUnique({ where: { guildId: scope.guildId } });
  res.json({
    factionChannelId: cfg?.factionChannelId ?? null,
    listMessageId: cfg?.listMessageId ?? null,
    updatedAt: cfg ? cfg.updatedAt.toISOString() : null,
  });
});

factionsRouter.put('/system-config', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const body = (req.body ?? {}) as { factionChannelId?: string | null };
  let newChId: string | null;
  if (body.factionChannelId === null || body.factionChannelId === '') newChId = null;
  else if (typeof body.factionChannelId === 'string' && SNOWFLAKE_RE.test(body.factionChannelId)) newChId = body.factionChannelId;
  else { res.status(400).json({ error: 'factionChannelId muss Snowflake oder null sein.' }); return; }

  if (newChId) {
    const err = await ensureChannelInGuild(newChId, scope.guildId);
    if (err) { res.status(400).json({ error: err }); return; }
  }

  const before = await prisma.factionSystemConfig.findUnique({ where: { guildId: scope.guildId } });
  const oldChannelId = before?.factionChannelId ?? null;
  const channelChanged = oldChannelId !== newChId;

  if (channelChanged && oldChannelId) {
    const client = tryGetDashboardClient();
    if (client) {
      await unpostFactionList(client, scope.guildId).catch(() => {});
      const orphanFactions = await prisma.faction.findMany({
        where: { guildId: scope.guildId, embedChannelId: null, embedMessageId: { not: null } },
        select: { id: true },
      });
      for (const of of orphanFactions) await unpostFactionEmbed(client, of.id).catch(() => {});
    }
  }

  const updated = await prisma.factionSystemConfig.upsert({
    where: { guildId: scope.guildId },
    create: { guildId: scope.guildId, factionChannelId: newChId, listMessageId: null },
    update: { factionChannelId: newChId, ...(channelChanged ? { listMessageId: null } : {}) },
  });
  logAuditDb('FACTION_SYSTEM_CONFIG_UPDATED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { factionChannelId: newChId, channelChanged },
  });

  if (newChId) {
    const client = tryGetDashboardClient();
    if (client) {
      const fallbackFactions = await prisma.faction.findMany({
        where: { guildId: scope.guildId, embedChannelId: null },
        select: { id: true },
      });
      for (const ff of fallbackFactions) {
        await postFactionEmbed(client, ff.id).catch(err => {
          logAuditDb('FACTION_EMBED_FAILED', 'FACTION', {
            actorUserId: req.auth!.userId, guildId: scope.guildId,
            details: { factionId: ff.id, action: 'system-config-rebroadcast', error: (err as Error).message },
          });
        });
      }
      await refreshList(scope.guildId, req.auth!.userId, 'system-config-changed');
    }
  }

  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: 'system-config' } });
  res.json({ factionChannelId: updated.factionChannelId, listMessageId: updated.listMessageId, updatedAt: updated.updatedAt.toISOString() });
});

// ============================================================================
// Lookups: Channels + Members (factions.manage scope, NICHT Owner-only)
// ============================================================================

factionsRouter.get('/lookups/channels', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const client = tryGetDashboardClient();
  if (!client) { res.json({ channels: [] }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }
  const TEXT_TYPES = new Set([0, 5, 15]);
  const channels = guild.channels.cache
    .filter(ch => TEXT_TYPES.has(ch.type as number))
    .map(ch => ({ id: ch.id, name: ch.name ?? '', type: ch.type as number, parentId: (ch as { parentId?: string | null }).parentId ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ channels });
});

factionsRouter.get('/lookups/members', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const client = tryGetDashboardClient();
  if (!client) { res.json({ members: [] }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }

  let members;
  if (q.length >= 2) members = await guild.members.fetch({ query: q, limit: 25 }).catch(() => null);
  else members = guild.members.cache;
  if (!members) { res.json({ members: [] }); return; }

  const list = Array.from(members.values()).slice(0, 25).map(m => ({
    id: m.id,
    username: m.user.username,
    globalName: m.user.globalName ?? null,
    displayName: m.displayName,
    avatarUrl: m.user.displayAvatarURL({ size: 64 }),
    bot: m.user.bot,
  }));
  res.json({ members: list });
});

factionsRouter.get('/lookups/members/:userId', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const userId = String(req.params.userId);
  if (!SNOWFLAKE_RE.test(userId)) { res.status(400).json({ error: 'userId ungueltig.' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.json({ id: userId, username: null, displayName: null, avatarUrl: null }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }
  const m = await guild.members.fetch(userId).catch(() => null);
  if (!m) { res.json({ id: userId, username: null, displayName: null, avatarUrl: null }); return; }
  res.json({
    id: m.id,
    username: m.user.username,
    globalName: m.user.globalName ?? null,
    displayName: m.displayName,
    avatarUrl: m.user.displayAvatarURL({ size: 64 }),
    bot: m.user.bot,
  });
});

factionsRouter.get('/lookups/roles', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const client = tryGetDashboardClient();
  if (!client) { res.json({ roles: [] }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }
  const me = guild.members.me;
  const myTop = me?.roles.highest.position ?? 0;
  const roles = guild.roles.cache
    .filter(r => !r.managed && r.id !== guild.id)
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, assignable: r.position < myTop }))
    .sort((a, b) => b.position - a.position);
  res.json({ roles });
});