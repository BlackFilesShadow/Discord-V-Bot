export {
  SENSITIVE_KEYS,
  PLACEHOLDER,
  isSensitiveKey,
  safeValue,
} from './redactorBase';
export type { RedactOptions } from './redactorBase';

// redactText/redactValue/redactObject kommen bewusst aus redactorProtected,
// nicht aus redactorBase: nur dort laeuft die Allowlist fuer verifizierte
// DayZ-1.29-Identifier und sichere serverDZ.cfg-Schluessel mit, damit JSON-
// (redactObject) und Datei-Pfad (redactText) identisch maskieren.
export { redactText, redactValue, redactObject } from './redactorProtected';
