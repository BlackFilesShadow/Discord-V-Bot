import {
  NON_DELEGABLE_SCOPES,
  PERMISSION_SCOPES,
  type PermissionScope,
} from '../../types/scope';

const VALID_PERMISSION_SCOPES = new Set<string>(PERMISSION_SCOPES as readonly string[]);

export function isDelegablePermissionScope(value: string): value is PermissionScope {
  return VALID_PERMISSION_SCOPES.has(value)
    && !NON_DELEGABLE_SCOPES.has(value as PermissionScope);
}

export function sanitizeDelegablePermissionScopes(raw: unknown): PermissionScope[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<PermissionScope>();
  for (const value of raw) {
    if (typeof value === 'string' && isDelegablePermissionScope(value)) {
      unique.add(value);
    }
  }
  return [...unique].sort();
}
