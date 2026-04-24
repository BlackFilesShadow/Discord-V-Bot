import { Router, Request, Response, raw } from 'express';
import type { Client } from 'discord.js';
import { deliverWebhookPayload } from '../../modules/feeds/webhookReceiver';
import { logger } from '../../utils/logger';

/**
 * Public Webhook-Endpunkt (KEINE Session-Auth).
 *
 * Eingehende externe Systeme posten an:
 *   POST /webhooks/feed/:feedId
 *   Header: X-V-Webhook-Signature: sha256=<hex>
 *           ODER X-V-Webhook-Token: <secret>
 *   Body:   application/json (siehe webhookReceiver.WebhookPayload)
 *
 * Die Authentifizierung erfolgt ausschliesslich ueber das Feed.webhookSecret
 * (HMAC-SHA256 ueber den raw body, alternativ konstanter Token-Vergleich).
 */

let injectedClient: Client | null = null;

export function setWebhookClient(client: Client): void {
  injectedClient = client;
}

export const webhookRouter = Router();

// Raw-Body-Parser nur fuer diesen Router (HMAC braucht das ungeparste JSON).
webhookRouter.post(
  '/feed/:feedId',
  raw({ type: 'application/json', limit: '512kb' }),
  async (req: Request, res: Response) => {
    if (!injectedClient) {
      res.status(503).json({ error: 'Bot nicht bereit.' });
      return;
    }
    const feedId = String(req.params.feedId ?? '');
    if (!/^[0-9a-f-]{8,40}$/i.test(feedId)) {
      res.status(400).json({ error: 'feedId Format ungueltig.' });
      return;
    }
    const rawBody = (req.body as Buffer | undefined)?.toString('utf8') ?? '';
    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      res.status(400).json({ error: 'JSON-Parse-Fehler.' });
      return;
    }
    try {
      const result = await deliverWebhookPayload(injectedClient, feedId, rawBody, parsed, req.headers as Record<string, string | string[] | undefined>);
      if (!result.ok) {
        res.status(result.status).json({ error: result.reason ?? 'Fehler' });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      logger.error(`Webhook-Endpoint /webhooks/feed/${feedId}: ${String(e)}`);
      res.status(500).json({ error: 'Interner Fehler.' });
    }
  },
);
