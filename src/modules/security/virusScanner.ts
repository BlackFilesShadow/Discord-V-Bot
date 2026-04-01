import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { logger, logAudit } from '../../utils/logger';

const execAsync = promisify(exec);

/**
 * Virenscan-Integration (Sektion 2):
 * - ClamAV-Anbindung (wenn verfügbar)
 * - Heuristischer Fallback-Scan
 * - Quarantäne bei Verdacht
 */

export interface ScanResult {
  clean: boolean;
  engine: 'clamav' | 'heuristic';
  threats: string[];
  details?: string;
}

// ClamAV-Verfügbarkeit cachen
let clamAvailable: boolean | null = null;

/**
 * Prüft ob ClamAV (clamscan) verfügbar ist.
 */
async function isClamAvAvailable(): Promise<boolean> {
  if (clamAvailable !== null) return clamAvailable;

  try {
    await execAsync('which clamscan');
    clamAvailable = true;
  } catch {
    clamAvailable = false;
    logger.warn('ClamAV nicht installiert – verwende heuristischen Fallback-Scanner');
  }
  return clamAvailable;
}

/**
 * Datei mit ClamAV scannen.
 */
async function scanWithClamAv(filePath: string): Promise<ScanResult> {
  try {
    const { stdout, stderr } = await execAsync(`clamscan --no-summary "${filePath}"`, {
      timeout: 60000,
    });

    const output = stdout + stderr;
    const isInfected = output.includes('FOUND');

    const threats: string[] = [];
    if (isInfected) {
      const matches = output.match(/: (.+) FOUND/g);
      if (matches) {
        for (const match of matches) {
          const threat = match.replace(/^: /, '').replace(/ FOUND$/, '');
          threats.push(threat);
        }
      }
    }

    return {
      clean: !isInfected,
      engine: 'clamav',
      threats,
      details: output.trim(),
    };
  } catch (error: any) {
    // ClamAV gibt Exit-Code 1 bei Fund zurück
    if (error.code === 1 && error.stdout) {
      const threats: string[] = [];
      const matches = error.stdout.match(/: (.+) FOUND/g);
      if (matches) {
        for (const match of matches) {
          threats.push(match.replace(/^: /, '').replace(/ FOUND$/, ''));
        }
      }
      return { clean: false, engine: 'clamav', threats, details: error.stdout };
    }
    throw error;
  }
}

/**
 * Heuristischer Scan für XML/JSON-Dateien.
 * Prüft auf verdächtige Muster: eingebettete Scripts, Shell-Befehle,
 * Base64-kodierte Payloads, File-Inclusions.
 */
async function heuristicScan(filePath: string): Promise<ScanResult> {
  const content = await fs.readFile(filePath, 'utf-8');
  const threats: string[] = [];

  // Verdächtige Muster
  const patterns: [RegExp, string][] = [
    [/<script[\s>]/i, 'Eingebettetes Script-Tag'],
    [/javascript:/i, 'JavaScript-URI-Schema'],
    [/on(load|error|click|mouseover)\s*=/i, 'Event-Handler-Attribut'],
    [/eval\s*\(/i, 'eval()-Aufruf'],
    [/exec\s*\(/i, 'exec()-Aufruf'],
    [/child_process/i, 'child_process-Referenz'],
    [/require\s*\(\s*['"](?:fs|child_process|os|net|http|https)/i, 'Node.js-Modul-Import'],
    [/\b(?:rm\s+-rf|chmod\s+777|wget\s+|curl\s+.*\|\s*(?:bash|sh))/i, 'Shell-Befehl'],
    [/<!ENTITY\s+/i, 'XML Entity (XXE-Risiko)'],
    [/<!DOCTYPE\s+[^>]*\[/i, 'XML DOCTYPE mit interner Subset (XXE)'],
    [/SYSTEM\s+["'](?:file|https?|ftp):\/\//i, 'Externe SYSTEM Entity'],
    [/\\u0000|%00/i, 'Null-Byte-Injection'],
    [/\.\.\//g, 'Path-Traversal (../)'],
  ];

  for (const [pattern, description] of patterns) {
    if (pattern.test(content)) {
      threats.push(description);
    }
  }

  // Base64-kodierte Payloads > 500 Zeichen (potenziell eingebettetes Binary)
  const base64Matches = content.match(/[A-Za-z0-9+/]{500,}={0,2}/g);
  if (base64Matches && base64Matches.length > 0) {
    threats.push(`Verdächtige Base64-Daten (${base64Matches.length} Block(s), längster: ${base64Matches[0].length} Zeichen)`);
  }

  return {
    clean: threats.length === 0,
    engine: 'heuristic',
    threats,
    details: threats.length > 0
      ? `Heuristischer Scan: ${threats.length} verdächtige Muster gefunden`
      : 'Keine verdächtigen Muster gefunden',
  };
}

/**
 * Vollständiger Virenscan einer Datei.
 * Verwendet ClamAV wenn verfügbar, sonst heuristischen Fallback.
 */
export async function scanFile(filePath: string, userId?: string): Promise<ScanResult> {
  try {
    let result: ScanResult;

    if (await isClamAvAvailable()) {
      result = await scanWithClamAv(filePath);
    } else {
      result = await heuristicScan(filePath);
    }

    // Ergebnis loggen
    logAudit(result.clean ? 'VIRUS_SCAN_CLEAN' : 'VIRUS_SCAN_THREAT', 'SECURITY', {
      filePath: path.basename(filePath),
      engine: result.engine,
      clean: result.clean,
      threats: result.threats,
      userId,
    });

    return result;
  } catch (error) {
    logger.error('Virenscan-Fehler:', error);
    // Bei Scan-Fehler: konservativ als verdächtig markieren
    return {
      clean: false,
      engine: 'heuristic',
      threats: ['Scan-Fehler: Datei konnte nicht gescannt werden'],
      details: String(error),
    };
  }
}
