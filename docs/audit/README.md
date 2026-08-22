# Masterplan audit artifacts

`stage-matrix-1-67.json` is the single canonical source for stage IDs,
statuses, evidence SHAs, notes, and residual findings.

The following files are derived and must not be edited manually:

- `scoreboard-1-67.csv`
- `masterplan-audit-summary.json`
- `MASTERPLAN-AUDIT-FINAL-REPORT.md`

Run `npm run audit:sync` after an evidence-backed change to the canonical
matrix. Run `npm run audit:check` to verify exact byte-for-byte consistency.
Both commands use UTF-8 without BOM and LF line endings.

The `_gen-stage-matrix.ps1`, `_step3_update_matrix.ps1`, and
`_step4_update_matrix.ps1` files are retained as historical audit evidence but
are intentionally disabled because they encode obsolete schemas and freeze
SHAs. `_step6_aggregate.ps1` delegates to the canonical Node generator.

Status policy:

- `VERIFIED` requires technical evidence and no remaining finding.
- `PARTIAL`, `FAILED`, and `BLOCKED` require at least one explicit finding.
- Re-pinning a SHA or editing documentation alone cannot promote a stage.
- `VERIFIED + PARTIAL + FAILED + BLOCKED` must always equal 67.
