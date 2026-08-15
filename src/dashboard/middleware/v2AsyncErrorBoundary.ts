import type { NextFunction, Request, Response } from 'express';

/**
 * Letzte Error-Grenze innerhalb von /api/v2.
 *
 * Normale Fehler werden an den globalen Dashboard-Error-Handler delegiert.
 * Wenn ein Streaming-Endpoint bereits Response-Bytes gesendet hat, darf dort
 * keine zweite JSON-Fehlerantwort mehr geschrieben werden. In diesem Fall wird
 * die unvollstaendige Verbindung deterministisch beendet.
 */
export function v2AsyncErrorBoundary(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  next(error);
}
