import crypto from 'node:crypto';

export interface AiToolStepUpBinding {
  actorDiscordId: string;
  guildId: string;
  nitradoConnId: string | null;
  toolName: string;
  argumentsDigest: string;
}

export type AiToolStepUpConfirmationSource = 'DISCORD_INTERACTION' | 'DASHBOARD_REAUTH' | 'WEBAUTHN';

export interface AiToolStepUpIssueRequest {
  binding: AiToolStepUpBinding;
  /** Must come from a trusted interaction/reauth controller, never the LLM. */
  confirmedByUser: true;
  source: AiToolStepUpConfirmationSource;
  ttlMs?: number;
}

interface GrantPayload extends AiToolStepUpBinding {
  v: 1;
  nonce: string;
  source: AiToolStepUpConfirmationSource;
  issuedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 90_000;
const MAX_TTL_MS = 5 * 60_000;
const MIN_SECRET_BYTES = 32;

function safeEqual(a: string, b: string): boolean {
  const ah = Buffer.from(a);
  const bh = Buffer.from(b);
  return ah.length === bh.length && crypto.timingSafeEqual(ah, bh);
}

function normalizeBinding(binding: AiToolStepUpBinding): AiToolStepUpBinding | null {
  const actorDiscordId = String(binding.actorDiscordId || '').trim();
  const guildId = String(binding.guildId || '').trim();
  const nitradoConnId = binding.nitradoConnId == null ? null : String(binding.nitradoConnId).trim();
  const toolName = String(binding.toolName || '').trim();
  const argumentsDigest = String(binding.argumentsDigest || '').trim().toLowerCase();
  if (!/^\d{17,20}$/.test(actorDiscordId)) return null;
  if (!/^\d{17,20}$/.test(guildId)) return null;
  if (nitradoConnId !== null && !/^c[a-z0-9]{24}$/.test(nitradoConnId)) return null;
  if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(toolName)) return null;
  if (!/^[a-f0-9]{64}$/.test(argumentsDigest)) return null;
  return { actorDiscordId, guildId, nitradoConnId, toolName, argumentsDigest };
}

function bindingMatches(a: AiToolStepUpBinding, b: AiToolStepUpBinding): boolean {
  return a.actorDiscordId === b.actorDiscordId
    && a.guildId === b.guildId
    && a.nitradoConnId === b.nitradoConnId
    && a.toolName === b.toolName
    && a.argumentsDigest === b.argumentsDigest;
}

/**
 * Server-side AI tool step-up grants.
 *
 * Tokens are HMAC-signed, short lived, bound to exact actor/Guild/Gameserver/
 * tool/arguments and consumed once. The LLM must never receive the signing
 * secret and must never call `issue`; issuance belongs to a trusted explicit
 * confirmation or re-auth controller.
 */
export class AiToolStepUpService {
  private readonly consumedNonces = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error('AI tool step-up secret must contain at least 32 bytes.');
    }
  }

  issue(request: AiToolStepUpIssueRequest): string {
    if (request.confirmedByUser !== true) throw new Error('Explicit user confirmation is required.');
    const binding = normalizeBinding(request.binding);
    if (!binding) throw new Error('Invalid AI tool step-up binding.');

    const issuedAt = this.now();
    const ttlMs = Math.min(MAX_TTL_MS, Math.max(1_000, request.ttlMs ?? DEFAULT_TTL_MS));
    const payload: GrantPayload = {
      v: 1,
      nonce: crypto.randomBytes(18).toString('base64url'),
      source: request.source,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      ...binding,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  verifyAndConsume(token: string, expectedBinding: AiToolStepUpBinding): boolean {
    this.pruneConsumed();
    const expected = normalizeBinding(expectedBinding);
    if (!expected) return false;

    const [body, signature, extra] = String(token || '').split('.');
    if (!body || !signature || extra !== undefined) return false;
    const expectedSignature = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    if (!safeEqual(signature, expectedSignature)) return false;

    let payload: GrantPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as GrantPayload;
    } catch {
      return false;
    }
    if (payload.v !== 1 || typeof payload.nonce !== 'string' || !payload.nonce) return false;
    if (!Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)) return false;
    if (payload.expiresAt <= this.now() || payload.issuedAt > this.now() + 5_000) return false;
    if (payload.expiresAt - payload.issuedAt > MAX_TTL_MS) return false;
    if (this.consumedNonces.has(payload.nonce)) return false;

    const actual = normalizeBinding(payload);
    if (!actual || !bindingMatches(actual, expected)) return false;

    this.consumedNonces.set(payload.nonce, payload.expiresAt);
    return true;
  }

  private pruneConsumed(): void {
    const now = this.now();
    for (const [nonce, expiresAt] of this.consumedNonces) {
      if (expiresAt <= now) this.consumedNonces.delete(nonce);
    }
  }
}
