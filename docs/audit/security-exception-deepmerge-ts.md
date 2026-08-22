# Security Exception: deepmerge-ts (HIGH) — CLOSED via override

**Date opened:** 2026-08-22  
**Date closed:** 2026-08-22  
**Status:** CLOSED — technical mitigation applied (npm overrides)  
**Advisory:** GHSA-ggr8-5vv4-36mx (stack exhaustion on recursive merge)  
**Former path:** `prisma@7.9.1` → `@prisma/config@7.9.1` → `deepmerge-ts@7.1.5`  
**Mitigated path:** same Prisma line with `overrides.deepmerge-ts = 8.0.2`

## Why force-fix was rejected

`npm audit fix --force` would install `prisma@6.12.0` (major downgrade) and break Prisma 7 client/config contracts used by this repository.

## Applied fix (non-force)

```json
"overrides": {
  "deepmerge-ts": "8.0.2"
}
```

Evidence (2026-08-22):

- `npm ls deepmerge-ts` → `deepmerge-ts@8.0.2 overridden`
- `npm audit --audit-level=high` → `found 0 vulnerabilities`
- `npm audit --omit=dev --audit-level=high` → `found 0 vulnerabilities`
- `npx prisma validate` + `npx prisma generate` succeed on Prisma 7.9.1

## Residual notes

- Override must remain until upstream `@prisma/config` depends on `deepmerge-ts@>=8`.
- Do not remove the override without re-running root high audit.
- Dashboard **dev** tree may still report vite/esbuild issues under full (non-omit) audit; production `omit=dev` remains the release gate.

## Commands (evidence)

```
npm ls deepmerge-ts
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npx prisma validate
npx prisma generate
```
