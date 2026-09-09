from pathlib import Path

# Full-suite compatibility for intentional capacity changes. These assertions
# verify the hardened semantics instead of the removed population prefixes / old
# Prisma object-query spelling.

whitelist_test = Path('tests/modules/nitradoWhitelistIntent.test.ts')
text = whitelist_test.read_text(encoding='utf-8')
old = """    expect(deletionRequestFindMany).toHaveBeenCalledWith({
      where: {
        requestType: 'PARTIAL_DELETION',
        status: 'IN_PROGRESS',
        details: { path: ['guildId'], equals: GUILD },
      },
      select: { discordId: true, details: true },
      take: 500,
    });"""
new = """    expect(deletionRequestFindMany).toHaveBeenCalledWith({
      where: {
        requestType: 'PARTIAL_DELETION',
        status: 'IN_PROGRESS',
        details: { path: ['guildId'], equals: GUILD },
      },
      select: { discordId: true, details: true },
    });"""
if new not in text:
    if old not in text:
        raise SystemExit('whitelist intent stale take:500 assertion anchor missing')
    text = text.replace(old, new, 1)
whitelist_test.write_text(text, encoding='utf-8')

runtime_test = Path('tests/runtime/gameplayFeedActivationPacingGate.test.ts')
text = runtime_test.read_text(encoding='utf-8')
old = "    expect(runtime).toContain('sourceFile: latestCursor.fileIdentity');"
new = "    expect(runtime).toContain('AND \"sourceFile\" = ${latestCursor.fileIdentity}');"
if new not in text:
    if old not in text:
        raise SystemExit('gameplay feed stale sourceFile assertion anchor missing')
    text = text.replace(old, new, 1)
runtime_test.write_text(text, encoding='utf-8')
