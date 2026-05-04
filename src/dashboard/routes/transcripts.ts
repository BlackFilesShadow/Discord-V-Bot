import { Router, type Request, type Response } from 'express';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * Public Web-Transcript-Route fuer geschlossene Tickets.
 *
 * - GET /transcripts/:id  -> liefert das gerenderte HTML-Transcript
 * - KEINE Auth: Zugriff per UUID-v4 (TicketInstance.id ist unguessable).
 * - Antwortet 410 wenn Ticket existiert aber kein Transcript mehr da ist
 *   (z.B. nach Aufraeumen alter Daten).
 *
 * Sicherheits-Header:
 *  - X-Robots-Tag: noindex, nofollow
 *  - Referrer-Policy: no-referrer
 *  - Content-Security-Policy: default-src 'self'; img-src https: data:; ...
 *    (Transcript ist self-contained mit Inline-CSS — kein externes Asset noetig.)
 *  - Cache-Control: privat, kein Long-Cache (Reason kann nachtraeglich editiert werden).
 */
export const transcriptsRouter = Router();

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

transcriptsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  if (!UUID_V4_RE.test(id)) {
    res.status(400).type('text/plain').send('Invalid transcript ID.');
    return;
  }
  try {
    const inst = await prisma.ticketInstance.findUnique({
      where: { id },
      select: { id: true, status: true, transcriptHtml: true, transcriptCreatedAt: true },
    });
    if (!inst) {
      res.status(404).type('text/plain').send('Transcript not found.');
      return;
    }
    if (!inst.transcriptHtml) {
      res.status(410).type('text/plain').send('Transcript not available.');
      return;
    }
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy',
      "default-src 'self'; style-src 'unsafe-inline'; img-src https: data:; "
      + "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    res.set('Cache-Control', 'private, max-age=60');
    res.type('text/html; charset=utf-8').send(inst.transcriptHtml);
  } catch (e) {
    logger.error('transcripts route error:', e as Error);
    res.status(500).type('text/plain').send('Internal Error');
  }
});
