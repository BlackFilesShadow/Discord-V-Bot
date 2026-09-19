import { isKnownDayz129Identifier } from '../../ai/dayz129Catalog';
import {
  redactText as baseRedactText,
  redactValue as baseRedactValue,
  redactObject as baseRedactObject,
} from './redactorBase';
import type { RedactOptions } from './redactorBase';

const LONG_IDENTIFIER_RE = /\b[A-Za-z0-9_-]{20,64}={0,2}\b/g;
const CFG_ASSIGNMENT_KEY_RE = /\b([A-Za-z][A-Za-z0-9_]{1,63})(?==)/g;
const SENTINEL_RE = /§DZ(\d+)§/g;

// Diese Schluessel sind reine, nicht-sensitive DayZ-Runtime-Feldnamen. Der
// Base-Redactor darf lange camelCase-Schluessel direkt vor "=" nicht als
// Base64-/Console-ID fehlklassifizieren. Werte bleiben unveraendert durch den
// vollstaendigen Base-Redactor geschuetzt.
const SAFE_DAYZ_CFG_ASSIGNMENT_KEYS = new Set([
  'maxplayers',
  'verifysignatures',
  'forcesamebuild',
  'disablevon',
  'voncodecquality',
  'disable3rdperson',
  'disablecrosshair',
  'serverpersontype',
  'servertime',
  'servertimeacceleration',
  'servernighttimeacceleration',
  'serverdatetime',
  'serverdatetimetype',
  'instancesid',
  'guaranteedupdates',
  'loginqueueconcurrentplayers',
  'loginqueuemaxplayers',
  'storehouselifetime',
  'storageautofix',
  'enablecfggameplayfile',
  'template',
]);

/**
 * Behaelt den bestehenden Datenschutzfilter vollstaendig bei, schuetzt aber
 * verifizierte DayZ-1.29-Identifier und explizit nicht-sensitive
 * serverDZ.cfg-Schluessel davor, als Console-ID/GUID fehlklassifiziert zu werden.
 */
export function redactText(input: string, opts: RedactOptions = {}): string {
  if (!input) return input;

  const protectedValues: string[] = [];
  const protect = (value: string): string => {
    const index = protectedValues.push(value) - 1;
    return `§DZ${index}§`;
  };

  // Vom Aufrufer bereits verifizierte Identifier (z.B. Subjects/Identifier
  // aus einem scope-geprueften Hallucination-Guard-Bundle) zuerst schuetzen -
  // unabhaengig vom Vanilla-Katalog. Sonst maskiert die GUID-/Console-ID-
  // Heuristik unten jeden modifizierten/nicht-vanilla Classname (>=20 Zeichen,
  // enthaelt "_"/"-") zu "[GUID]", obwohl der Guard selbst spaeter noch gegen
  // den echten, ungeschwaerzten Wert prueft - das Modell saehe dann nie den
  // echten Namen. Laengste zuerst, damit ein kuerzerer Identifier keinen
  // laengeren, ihn enthaltenden Identifier vorzeitig zerschneidet.
  let withProtectedIdentifiers = input;
  const sortedProtected = [...(opts.protectedIdentifiers ?? [])]
    .filter((id) => id && id.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const id of sortedProtected) {
    if (!withProtectedIdentifiers.includes(id)) continue;
    withProtectedIdentifiers = withProtectedIdentifiers.split(id).join(protect(id));
  }

  const withProtectedCfgKeys = withProtectedIdentifiers.replace(CFG_ASSIGNMENT_KEY_RE, (value) => {
    if (!SAFE_DAYZ_CFG_ASSIGNMENT_KEYS.has(value.toLowerCase())) return value;
    return protect(value);
  });

  const prepared = withProtectedCfgKeys.replace(LONG_IDENTIFIER_RE, (value) => {
    if (!isKnownDayz129Identifier(value)) return value;
    return protect(value);
  });

  const redacted = baseRedactText(prepared, opts);
  return redacted.replace(SENTINEL_RE, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    return protectedValues[index] ?? '';
  });
}

/**
 * redactValue()/redactObject() aus redactorBase nutzen intern denselben
 * einfachen Basis-redactText und kennen die hier definierte Allowlist
 * (verifizierte DayZ-1.29-Identifier, sichere serverDZ.cfg-Schluessel) nicht.
 * Ohne diese Weiterleitung maskiert derselbe Wert je nach Pfad unterschiedlich
 * stark: settings/serviceMeta-JSON (redactObject) strenger als eine rohe Datei
 * (die diesen redactText direkt nutzt). Diese Wrapper injizieren denselben
 * geschuetzten Text-Redactor, damit beide Pfade identisch maskieren.
 */
export function redactValue(key: string, value: unknown, opts: RedactOptions = {}): unknown {
  return baseRedactValue(key, value, { ...opts, textRedactor: redactText });
}

export function redactObject(obj: Record<string, unknown>, opts: RedactOptions = {}): Record<string, unknown> {
  return baseRedactObject(obj, { ...opts, textRedactor: redactText });
}
