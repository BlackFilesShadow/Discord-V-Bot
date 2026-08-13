export {
  SENSITIVE_KEYS,
  PLACEHOLDER,
  isSensitiveKey,
  redactValue,
  redactObject,
  safeValue,
} from './redactorBase';
export type { RedactOptions } from './redactorBase';

export { redactText } from './redactorProtected';
