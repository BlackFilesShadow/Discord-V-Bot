import { isKnownDayz129Identifier } from '../../ai/dayz129Catalog';
import { redactText as baseRedactText } from './redactorBase';
import type { RedactOptions } from './redactorBase';

const LONG_IDENTIFIER_RE = /\b[A-Za-z0-9_-]{20,64}={0,2}\b/g;
const SENTINEL_RE = /§DZ(\d+)§/g;

/**
 * Behaelt den bestehenden Datenschutzfilter vollstaendig bei, schuetzt aber
 * verifizierte DayZ-1.29-Identifier davor, als Console-ID/GUID fehlklassifiziert
 * zu werden.
 */
export function redactText(input: string, opts: RedactOptions = {}): string {
  if (!input) return input;

  const protectedValues: string[] = [];
  const prepared = input.replace(LONG_IDENTIFIER_RE, (value) => {
    if (!isKnownDayz129Identifier(value)) return value;
    const index = protectedValues.push(value) - 1;
    return `§DZ${index}§`;
  });

  const redacted = baseRedactText(prepared, opts);
  return redacted.replace(SENTINEL_RE, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    return protectedValues[index] ?? '';
  });
}
