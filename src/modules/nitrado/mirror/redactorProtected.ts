import { isKnownDayz129Identifier } from '../../ai/dayz129Catalog';
import { redactText as baseRedactText } from './redactorBase';
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

  const withProtectedCfgKeys = input.replace(CFG_ASSIGNMENT_KEY_RE, (value) => {
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
