# Security Exception: deepmerge-ts (HIGH)

**Date:** 2026-08-22  
**Status:** OPEN — time-bounded exception  
**Advisory:** GHSA-ggr8-5vv4-36mx (stack exhaustion on recursive merge)  
**Path:** `prisma@7.9.1` → `@prisma/config@7.9.1` → `deepmerge-ts@7.1.5`

## Why not force-fixed

`npm audit fix --force` would install `prisma@6.12.0` (major downgrade) and break Prisma 7 client/config contracts used by this repository.

No Prisma 7.x release newer than 7.9.1 currently removes the transitive HIGH without a breaking force path (checked 2026-08-22: `npm view prisma version` = 7.9.1).

## Risk assessment

- Affects Prisma CLI config merge, not the Discord/Nitrado runtime hot path.
- Exploit requires attacker-controlled recursive object graphs fed into Prisma config merge (not exposed to end users of the bot).
- Residual risk: local/CI developer tooling / malicious package config.

## Required follow-up

1. Re-check `npm audit` on every dependency bump of `prisma`.
2. When Prisma publishes a fix line on 7.x, apply controlled upgrade + full migrate/client verification.
3. Exception expires after 90 days or next Prisma minor, whichever first — re-open as BLOCKER if still unfixed and Prisma exposes merge to untrusted input.

## Commands (evidence)

```
npm audit --audit-level=high
npm ls deepmerge-ts
```
