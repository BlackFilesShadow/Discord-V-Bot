/**
 * Nitrado Write-Protection Guard (Spec §12).
 *
 * Schreibende Nitrado-Aktionen (Whitelist-Push, Datei-Schreiben, Server
 * Start/Stop/Restart, Config-Schreiben, Restore/Reset) duerfen NICHT einfach
 * durchlaufen, wenn der Schreibschutz aktiv ist (NITRADO_WRITE_PROTECTION=true,
 * Standard).
 *
 * Aktiv = die Aktion braucht:
 *   - explizite Permission (nitrado.write fuer normale, nitrado.danger fuer
 *     gefaehrliche Aktionen — am Routen-Layer via requireGuildPermission gesetzt)
 *   - einen Confirm-Flag im Body  (`confirm: true`)
 *   - ein Reason-Feld im Body     (`reason: "<nicht leer>"`)
 *   - Audit-Log (wird zentral hier geschrieben)
 *
 * Diese Middleware wird NACH requireGuildPermission(...) in den Stack gehaengt.
 * Sie liest niemals Token/Secrets und gibt sie nie aus.
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config';
import { logAuditDb } from '../../utils/logger';

export interface NitradoWriteOptions {
  /** true = gefaehrliche Aktion (Restart/Stop/Delete/File-Write/Config-Write). Nur Dokumentation/Audit-Label. */
  danger?: boolean;
  /** Audit-Action-Name, z. B. 'NITRADO_WHITELIST_PUSH'. */
  action: string;
}

/**
 * Body-Erwartung fuer geschuetzte Schreibaktionen.
 * Confirm/Reason werden NUR geprueft, wenn Schreibschutz aktiv ist.
 */
export function requireNitradoWrite(opts: NitradoWriteOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const protectionOn = config.nitrado.writeProtection;

    // Reason immer extrahieren (auch fuer Audit, wenn Schutz aus ist).
    const reasonRaw = req.body?.reason;
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    const confirm = req.body?.confirm === true || req.body?.confirm === 'true';

    if (protectionOn) {
      if (!confirm) {
        res.status(412).json({
          error: 'Nitrado Schreibschutz ist aktiv. Diese Aktion verändert Daten auf Nitrado und benötigt zusätzliche Bestätigung.',
          code: 'NITRADO_WRITE_PROTECTED',
          requires: { confirm: true, reason: true },
          danger: opts.danger === true,
        });
        return;
      }
      if (reason.length < 3) {
        res.status(412).json({
          error: 'Begründung (reason) erforderlich für schreibende Nitrado-Aktionen.',
          code: 'NITRADO_WRITE_REASON_REQUIRED',
          requires: { confirm: true, reason: true },
          danger: opts.danger === true,
        });
        return;
      }
    }

    // Audit fuer jede schreibende Nitrado-Aktion (egal ob Schutz an/aus).
    logAuditDb(opts.action, 'NITRADO', {
      actorUserId: req.auth?.userId ?? null,
      guildId: req.guildScope?.guildId ?? null,
      details: {
        danger: opts.danger === true,
        writeProtection: protectionOn,
        reason: reason || null,
      },
      ip: req.ip ?? null,
      userAgent: String(req.headers['user-agent'] ?? '') || null,
    });

    next();
  };
}

/**
 * Inline-Variante fuer Routen, die nur in bestimmten Faellen schreiben
 * (z. B. Whitelist-Sync nur bei mode=apply + direction=push/merge).
 *
 * Gibt `true` zurueck, wenn die Aktion fortgesetzt werden darf. Bei `false`
 * wurde bereits eine 412-Antwort gesendet — der Handler muss dann `return`.
 * Schreibt bei Erfolg ein Audit-Log.
 */
export function ensureNitradoWriteAllowed(
  req: Request,
  res: Response,
  opts: NitradoWriteOptions,
): boolean {
  const protectionOn = config.nitrado.writeProtection;
  const reasonRaw = req.body?.reason;
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  const confirm = req.body?.confirm === true || req.body?.confirm === 'true';

  if (protectionOn) {
    if (!confirm) {
      res.status(412).json({
        error: 'Nitrado Schreibschutz ist aktiv. Diese Aktion verändert Daten auf Nitrado und benötigt zusätzliche Bestätigung.',
        code: 'NITRADO_WRITE_PROTECTED',
        requires: { confirm: true, reason: true },
        danger: opts.danger === true,
      });
      return false;
    }
    if (reason.length < 3) {
      res.status(412).json({
        error: 'Begründung (reason) erforderlich für schreibende Nitrado-Aktionen.',
        code: 'NITRADO_WRITE_REASON_REQUIRED',
        requires: { confirm: true, reason: true },
        danger: opts.danger === true,
      });
      return false;
    }
  }

  logAuditDb(opts.action, 'NITRADO', {
    actorUserId: req.auth?.userId ?? null,
    guildId: req.guildScope?.guildId ?? null,
    details: {
      danger: opts.danger === true,
      writeProtection: protectionOn,
      reason: reason || null,
    },
    ip: req.ip ?? null,
    userAgent: String(req.headers['user-agent'] ?? '') || null,
  });
  return true;
}

/**
 * Read-only Status-Objekt fuer Dashboard/DEV-Anzeige.
 * Enthaelt NIEMALS Secrets.
 */
export function nitradoWriteProtectionStatus(): {
  writeProtection: boolean;
  scopes: { view: string; manage: string; write: string; danger: string };
} {
  return {
    writeProtection: config.nitrado.writeProtection,
    scopes: {
      view: 'nitrado.view',
      manage: 'nitrado.manage',
      write: 'nitrado.write',
      danger: 'nitrado.danger',
    },
  };
}
