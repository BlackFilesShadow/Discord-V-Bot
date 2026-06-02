/**
 * Einheitliches Validierungs-Ergebnisformat (Spec §9).
 *
 * Wrappt die bestehenden Low-Level-Validatoren (validateJson/validateXml/
 * validateDayzXml) und liefert das in der Spezifikation definierte
 * `ValidationResult` inklusive Datei-Metadaten (sha256, Groesse, Zeilenanzahl),
 * Severity-Summary, Validierungsdauer und Vorschau (normalized/fixed).
 *
 * Es werden NIEMALS Secrets verarbeitet oder ausgegeben — nur der vom DEV
 * uebergebene Datei-/Textinhalt.
 */
import { createHash } from 'node:crypto';
import {
  validateJson, validateXml, validateDayzXml,
  type ValidatorResult, type DiagIssue,
} from './devValidators';

export type ValidationSeverity = 'error' | 'warning' | 'info' | 'suggestion';
export type ValidationType = 'json' | 'xml' | 'adm' | 'rpt' | 'dayz-config';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  explanation?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  path?: string;
  source?: string;
  suggestion?: string;
  fixable?: boolean;
  fixPreview?: string;
  confidence?: number;
}

export interface ValidationSummary {
  errors: number;
  warnings: number;
  info: number;
  suggestions: number;
}

export interface ValidationResult {
  ok: boolean;
  type: ValidationType;
  fileName?: string;
  sizeBytes?: number;
  sha256?: string;
  lineCount?: number;
  durationMs: number;
  issues: ValidationIssue[];
  summary: ValidationSummary;
  normalizedPreview?: string;
  fixedPreview?: string;
}

const PREVIEW_MAX = 20_000;

/** Entfernt BOM und normalisiert CRLF/CR -> LF. */
function normalizeText(input: string): string {
  let s = input;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n');
}

function countLines(input: string): number {
  if (input.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === 10) n++;
  }
  return n;
}

function clampPreview(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}\n… (gekuerzt)` : s;
}

/**
 * Best-Effort Fehlercode aus der Diagnose-Nachricht ableiten. Die Low-Level-
 * Validatoren liefern (noch) keine Codes; wir erzeugen stabile, semantische
 * Codes fuer Filter/Export.
 */
function deriveCode(type: ValidationType, msg: string): string {
  const m = msg.toLowerCase();
  if (type === 'json') {
    if (m.includes('leere')) return 'JSON_EMPTY';
    if (m.includes('unexpected') || m.includes('token')) return 'JSON_SYNTAX';
    if (m.includes('position') || m.includes('column')) return 'JSON_SYNTAX';
    return 'JSON_PARSE';
  }
  // XML / DayZ
  if (m.includes('leere')) return 'XML_EMPTY';
  if (m.includes('root-element')) return 'XML_NO_ROOT';
  if (m.includes('unbalanc') || m.includes('nicht geschlossen')) return 'XML_UNCLOSED';
  if (m.includes('verschachtelung')) return 'XML_NESTING';
  if (m.includes('attribut') && m.includes('quote')) return 'XML_ATTR_QUOTE';
  if (m.includes('name-attribut') || m.includes('kein name')) return 'DAYZ_NAME_MISSING';
  if (m.includes('doppelter') || m.includes('doppelte')) return 'DAYZ_DUPLICATE';
  if (m.includes('negativ')) return 'DAYZ_NEGATIVE';
  if (m.includes('> nominal') || m.includes('> max') || m.includes('< min')) return 'DAYZ_RANGE';
  if (m.includes('fehlt')) return 'DAYZ_MISSING_FIELD';
  if (m.includes('keine zahl') || m.includes('gueltige zahl')) return 'DAYZ_TYPE_MISMATCH';
  if (m.includes('keine')) return 'XML_EMPTY_COLLECTION';
  return 'XML_STRUCTURE';
}

/** Mappt eine Low-Level-DiagIssue auf die Spec-ValidationIssue. */
function mapIssue(type: ValidationType, iss: DiagIssue, fixable: boolean, fixPreview?: string): ValidationIssue {
  return {
    severity: iss.severity, // 'error' | 'warning' (info/suggestion entstehen separat)
    code: deriveCode(type, iss.message),
    message: iss.message,
    explanation: iss.hint,
    line: iss.pos?.line,
    column: iss.pos?.column,
    suggestion: iss.hint,
    fixable: fixable && iss.severity === 'error' ? true : undefined,
    fixPreview: fixable ? fixPreview : undefined,
  };
}

function summarize(issues: ValidationIssue[]): ValidationSummary {
  const s: ValidationSummary = { errors: 0, warnings: 0, info: 0, suggestions: 0 };
  for (const i of issues) {
    if (i.severity === 'error') s.errors++;
    else if (i.severity === 'warning') s.warnings++;
    else if (i.severity === 'info') s.info++;
    else if (i.severity === 'suggestion') s.suggestions++;
  }
  return s;
}

export interface BuildOptions {
  content: string;
  fileName?: string;
}

interface ValidatorRun {
  type: ValidationType;
  base: ValidatorResult;
}

function runValidator(kind: 'json' | 'xml', content: string, fileName?: string): ValidatorRun {
  if (kind === 'json') {
    return { type: 'json', base: validateJson(content) };
  }
  // XML: DayZ-spezifisch falls erkannt, sonst generisch.
  const dayz = validateDayzXml(content, fileName);
  if (dayz.kind !== 'generic') {
    return { type: 'dayz-config', base: dayz };
  }
  return { type: 'xml', base: validateXml(content) };
}

/**
 * Erzeugt das einheitliche ValidationResult fuer JSON oder XML.
 */
export function buildValidationResult(kind: 'json' | 'xml', opts: BuildOptions): ValidationResult {
  const start = Date.now();
  const { content, fileName } = opts;

  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const lineCount = countLines(content);
  const normalized = normalizeText(content);

  const { type, base } = runValidator(kind, content, fileName);

  const fixable = !!base.suggestedFix;
  const issues = base.issues.map(i => mapIssue(type, i, fixable, base.suggestedFix));

  // Wenn ein Auto-Fix existiert, als (zusaetzliche) SUGGESTION ausweisen.
  if (fixable) {
    issues.push({
      severity: 'suggestion',
      code: type === 'json' ? 'JSON_AUTOFIX' : 'XML_AUTOFIX',
      message: 'Automatische Korrektur verfügbar.',
      explanation: 'Ein bereinigter Inhalt kann übernommen werden (siehe fixedPreview).',
      fixable: true,
    });
  }

  const summary = summarize(issues);

  return {
    ok: base.ok,
    type,
    fileName,
    sizeBytes,
    sha256,
    lineCount,
    durationMs: Date.now() - start,
    issues,
    summary,
    normalizedPreview: clampPreview(normalized !== content ? normalized : undefined),
    fixedPreview: clampPreview(base.suggestedFix),
  };
}

/**
 * Export-Helfer: erzeugt aus einem ValidationResult einen Text- oder
 * Markdown-Report. (JSON-Export = JSON.stringify clientseitig.)
 * Enthaelt KEINE Secrets — nur die Diagnose selbst.
 */
export function renderValidationReport(result: ValidationResult, format: 'text' | 'markdown'): string {
  const lines: string[] = [];
  const sev = (s: ValidationSeverity): string => s.toUpperCase();

  if (format === 'markdown') {
    lines.push(`# Validierungsbericht — ${result.type.toUpperCase()}`);
    lines.push('');
    if (result.fileName) lines.push(`- **Datei:** ${result.fileName}`);
    if (result.sizeBytes != null) lines.push(`- **Größe:** ${result.sizeBytes} Bytes`);
    if (result.lineCount != null) lines.push(`- **Zeilen:** ${result.lineCount}`);
    if (result.sha256) lines.push(`- **SHA256:** \`${result.sha256}\``);
    lines.push(`- **Dauer:** ${result.durationMs} ms`);
    lines.push(`- **Ergebnis:** ${result.ok ? '✅ gültig' : '❌ ungültig'}`);
    lines.push(`- **Summary:** ${result.summary.errors} Fehler · ${result.summary.warnings} Warnungen · ${result.summary.info} Info · ${result.summary.suggestions} Vorschläge`);
    lines.push('');
    lines.push('## Befunde');
    if (result.issues.length === 0) {
      lines.push('Keine Befunde.');
    } else {
      for (const i of result.issues) {
        const loc = i.line != null ? ` (Zeile ${i.line}${i.column != null ? `, Spalte ${i.column}` : ''})` : '';
        lines.push(`- **[${sev(i.severity)}] ${i.code}**${loc}: ${i.message}`);
        if (i.suggestion) lines.push(`  - Vorschlag: ${i.suggestion}`);
      }
    }
    return lines.join('\n');
  }

  // text
  lines.push(`Validierungsbericht — ${result.type.toUpperCase()}`);
  if (result.fileName) lines.push(`Datei: ${result.fileName}`);
  if (result.sizeBytes != null) lines.push(`Groesse: ${result.sizeBytes} Bytes`);
  if (result.lineCount != null) lines.push(`Zeilen: ${result.lineCount}`);
  if (result.sha256) lines.push(`SHA256: ${result.sha256}`);
  lines.push(`Dauer: ${result.durationMs} ms`);
  lines.push(`Ergebnis: ${result.ok ? 'gueltig' : 'ungueltig'}`);
  lines.push(`Summary: ${result.summary.errors} Fehler, ${result.summary.warnings} Warnungen, ${result.summary.info} Info, ${result.summary.suggestions} Vorschlaege`);
  lines.push('');
  lines.push('Befunde:');
  if (result.issues.length === 0) {
    lines.push('  (keine)');
  } else {
    for (const i of result.issues) {
      const loc = i.line != null ? ` [Zeile ${i.line}${i.column != null ? `, Spalte ${i.column}` : ''}]` : '';
      lines.push(`  [${sev(i.severity)}] ${i.code}${loc}: ${i.message}`);
      if (i.suggestion) lines.push(`      -> ${i.suggestion}`);
    }
  }
  return lines.join('\n');
}
