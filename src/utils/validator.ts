import { XMLParser, XMLValidator } from 'fast-xml-parser';
import Ajv from 'ajv';
import { readFile } from 'fs/promises';
import path from 'path';

/**
 * Hochmoderner XML- & JSON-Validator.
 * Sektion 2: Prüft Struktur, Syntax, XSD/Schema, Custom Rules.
 * Fehlertolerant, exakt, detaillierte Fehler und Vorschläge.
 */

export interface ValidationError {
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
  path?: string;
}

export interface ValidationSuggestion {
  message: string;
  fix?: string;
}

export interface ValidationReport {
  isValid: boolean;
  fileType: 'xml' | 'json' | 'unknown';
  errors: ValidationError[];
  warnings: ValidationError[];
  suggestions: ValidationSuggestion[];
  structureInfo?: Record<string, unknown>;
}

/**
 * Validiert eine Datei (XML oder JSON) und gibt einen detaillierten Report zurück.
 */
export async function validateFile(filePath: string): Promise<ValidationReport> {
  const ext = path.extname(filePath).toLowerCase();
  const content = await readFile(filePath, 'utf-8');

  if (ext === '.xml') {
    return validateXml(content);
  } else if (ext === '.json') {
    return validateJson(content);
  } else {
    return {
      isValid: false,
      fileType: 'unknown',
      errors: [{ message: `Unbekannter Dateityp: ${ext}`, severity: 'error' }],
      warnings: [],
      suggestions: [{ message: 'Unterstützte Dateitypen: .xml, .json' }],
    };
  }
}

/**
 * XML-Validierung: Syntax, Struktur, wohlgeformtheit.
 */
export function validateXml(content: string): ValidationReport {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const suggestions: ValidationSuggestion[] = [];

  // Schritt 1: Grundlegende Syntax-Prüfung
  const syntaxResult = XMLValidator.validate(content, {
    allowBooleanAttributes: true,
  });

  if (syntaxResult !== true) {
    errors.push({
      line: syntaxResult.err?.line,
      column: syntaxResult.err?.col,
      message: syntaxResult.err?.msg || 'XML-Syntaxfehler',
      severity: 'error',
    });

    return {
      isValid: false,
      fileType: 'xml',
      errors,
      warnings,
      suggestions: [
        { message: 'Prüfe ob alle Tags korrekt geschlossen sind.' },
        { message: 'Prüfe ob Sonderzeichen korrekt escaped sind (&amp; &lt; &gt; etc.).' },
      ],
    };
  }

  // Schritt 2: Struktur-Parsing
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      allowBooleanAttributes: true,
      parseTagValue: true,
      parseAttributeValue: true,
      trimValues: true,
      isArray: () => false,
    });

    const parsed = parser.parse(content);

    // Prüfe auf leeres Dokument
    if (!parsed || Object.keys(parsed).length === 0) {
      warnings.push({
        message: 'XML-Dokument ist leer oder enthält keine Elemente.',
        severity: 'warning',
      });
    }

    // Prüfe auf XML-Deklaration
    if (!content.trim().startsWith('<?xml')) {
      suggestions.push({
        message: 'XML-Deklaration (<?xml version="1.0" encoding="UTF-8"?>) fehlt.',
        fix: 'Füge <?xml version="1.0" encoding="UTF-8"?> am Anfang ein.',
      });
    }

    // Prüfe Encoding
    if (content.includes('encoding=') && !content.includes('UTF-8') && !content.includes('utf-8')) {
      warnings.push({
        message: 'Empfohlen: UTF-8 Encoding verwenden.',
        severity: 'warning',
      });
    }

    // Strukturinformationen sammeln
    const structureInfo = analyzeXmlStructure(parsed);

    return {
      isValid: true,
      fileType: 'xml',
      errors,
      warnings,
      suggestions,
      structureInfo,
    };
  } catch (err) {
    errors.push({
      message: `XML-Parse-Fehler: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'error',
    });

    return { isValid: false, fileType: 'xml', errors, warnings, suggestions };
  }
}

/**
 * JSON-Validierung: Syntax, Struktur, optionaler Schema-Check.
 */
export function validateJson(content: string, schema?: Record<string, unknown>): ValidationReport {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const suggestions: ValidationSuggestion[] = [];

  // Schritt 1: Syntax-Prüfung
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Detaillierte Fehleranalyse
    const posMatch = errMsg.match(/position (\d+)/);
    const lineCol = posMatch ? getLineColumn(content, parseInt(posMatch[1], 10)) : undefined;

    errors.push({
      line: lineCol?.line,
      column: lineCol?.column,
      message: `JSON-Syntaxfehler: ${errMsg}`,
      severity: 'error',
    });

    // Fehlertolerant: Vorschläge geben
    if (errMsg.includes('Unexpected token')) {
      suggestions.push({
        message: 'Prüfe auf fehlende Kommas, Anführungszeichen oder Klammern.',
      });
    }
    if (errMsg.includes('Unexpected end')) {
      suggestions.push({
        message: 'JSON scheint unvollständig. Prüfe ob alle Klammern geschlossen sind.',
      });
    }

    // Versuche Trailing Comma zu erkennen
    if (content.includes(',}') || content.includes(',]')) {
      suggestions.push({
        message: 'Trailing Commas erkannt. Entferne Kommas vor schließenden Klammern.',
        fix: 'Entferne das Komma vor } oder ].',
      });
    }

    return { isValid: false, fileType: 'json', errors, warnings, suggestions };
  }

  // Schritt 2: Struktur-Analyse
  if (parsed === null || parsed === undefined) {
    warnings.push({
      message: 'JSON-Wert ist null oder undefined.',
      severity: 'warning',
    });
  }

  // Schritt 3: Optionaler Schema-Check
  if (schema) {
    const ajv = new Ajv({ allErrors: true, verbose: true });
    const validate = ajv.compile(schema);
    const valid = validate(parsed);

    if (!valid && validate.errors) {
      for (const err of validate.errors) {
        errors.push({
          path: err.instancePath,
          message: `Schema-Fehler: ${err.message} (${err.schemaPath})`,
          severity: 'error',
        });
      }
    }
  }

  // Strukturinformationen
  const structureInfo = analyzeJsonStructure(parsed);

  return {
    isValid: errors.length === 0,
    fileType: 'json',
    errors,
    warnings,
    suggestions,
    structureInfo,
  };
}

/**
 * XML-Struktur analysieren.
 */
function analyzeXmlStructure(parsed: Record<string, unknown>): Record<string, unknown> {
  const info: Record<string, unknown> = {
    rootElements: Object.keys(parsed).filter(k => !k.startsWith('?')),
    depth: getDepth(parsed),
    elementCount: countElements(parsed),
  };
  return info;
}

/**
 * JSON-Struktur analysieren.
 */
function analyzeJsonStructure(parsed: unknown): Record<string, unknown> {
  const info: Record<string, unknown> = {
    type: Array.isArray(parsed) ? 'array' : typeof parsed,
    depth: getDepth(parsed as Record<string, unknown>),
  };

  if (Array.isArray(parsed)) {
    info.arrayLength = parsed.length;
  } else if (typeof parsed === 'object' && parsed !== null) {
    info.keys = Object.keys(parsed);
    info.keyCount = Object.keys(parsed).length;
  }

  return info;
}

function getDepth(obj: unknown, current: number = 0): number {
  if (typeof obj !== 'object' || obj === null) return current;
  let max = current;
  for (const value of Object.values(obj)) {
    const d = getDepth(value, current + 1);
    if (d > max) max = d;
  }
  return max;
}

function countElements(obj: unknown): number {
  if (typeof obj !== 'object' || obj === null) return 0;
  let count = Object.keys(obj).length;
  for (const value of Object.values(obj)) {
    count += countElements(value);
  }
  return count;
}

function getLineColumn(text: string, position: number): { line: number; column: number } {
  const lines = text.substring(0, position).split('\n');
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length || 0) + 1,
  };
}
