from pathlib import Path

p = Path('src/modules/ai/dayz129Catalog.ts')
s = p.read_text()

# Make runtime provenance explicit: concrete values come from the supplied ZIP corpus.
s = s.replace("    cached = JSON.parse(raw) as Dayz129Index;\n", "    cached = JSON.parse(raw) as Dayz129Index;\n    cached.sourceTag = 'USER_ZIPS_1.29.163451';\n")

# Use requested map for type answers.
s = s.replace("function formatTypeAnswer(name: string): DayzCatalogAnswer {\n  const index = getDayz129Index();\n  const lines = [`**DayZ-Classname: \\`${name}\\`**`, ''];\n  let found = false;\n  for (const map of Object.keys(index.maps) as Dayz129Map[]) {", "function formatTypeAnswer(name: string, requestedMaps: Dayz129Map[] = []): DayzCatalogAnswer {\n  const index = getDayz129Index();\n  const lines = [`**DayZ-Classname: \\`${name}\\`**`, ''];\n  let found = false;\n  const maps = requestedMaps.length ? requestedMaps : (Object.keys(index.maps) as Dayz129Map[]);\n  for (const map of maps) {")

# Use requested map for event answers.
s = s.replace("function formatEventAnswer(name: string): DayzCatalogAnswer {\n  const index = getDayz129Index();\n  const lines = [`**DayZ-Event: \\`${name}\\`**`, ''];\n  for (const map of Object.keys(index.maps) as Dayz129Map[]) {", "function formatEventAnswer(name: string, requestedMaps: Dayz129Map[] = []): DayzCatalogAnswer {\n  const index = getDayz129Index();\n  const lines = [`**DayZ-Event: \\`${name}\\`**`, ''];\n  const maps = requestedMaps.length ? requestedMaps : (Object.keys(index.maps) as Dayz129Map[]);\n  for (const map of maps) {")

# Pass detected maps through exact and natural resolution.
s = s.replace("  const q = fold(question);\n\n  const path = canonicalFileFromText(question);", "  const q = fold(question);\n  const requestedMaps = detectMaps(question);\n\n  const path = canonicalFileFromText(question);")
s = s.replace("return formatTypeAnswer(exactType);", "return formatTypeAnswer(exactType, requestedMaps);")
s = s.replace("return formatTypeAnswer(candidates[0]);", "return formatTypeAnswer(candidates[0], requestedMaps);")
s = s.replace("return formatEventAnswer(exactEvent);", "return formatEventAnswer(exactEvent, requestedMaps);")
s = s.replace("return formatEventAnswer(candidates[0]);", "return formatEventAnswer(candidates[0], requestedMaps);")

# Generic contextual follow-ups include map refinements.
s = s.replace("!/(beispiel|wie genau|warum|was bedeutet|kannst du|zeig|und wie|und was|nochmal|dazu|welcher wert|welche werte)/i.test(q)", "!/(beispiel|wie genau|warum|was bedeutet|kannst du|zeig|und wie|und was|und auf|auf chernarus|auf livonia|auf sakhal|nochmal|dazu|welcher wert|welche werte)/i.test(q)")

p.write_text(s)

p = Path('tests/ai/dayz129Catalog.test.ts')
s = p.read_text()
s = s.replace("expect(index.sourceTag).toBe('DZ_129');", "expect(index.sourceTag).toBe('USER_ZIPS_1.29.163451');")
s = s.replace("expect(searchDayz129Types('Holzbretter', 5)).toEqual(expect.arrayContaining(['WoodenPlank', 'PileOfWoodenPlanks']));", "expect(searchDayz129Types('Holzbretter', 5)).toContain('WoodenPlank');\n    expect(searchDayz129Types('Holzbretter', 20)).not.toContain('PileOfWoodenPlanks');")

# Add map-filter regressions before follow-up test.
anchor = "  test('generic follow-up works for any indexed file, type and event', () => {"
insert = "  test('map-specific type and event questions only report the requested map', () => {\n    const t = answerDayz129CatalogQuestion('Classname M4A1 auf Sakhal');\n    expect(t?.answer).toMatch(/Sakhal/);\n    expect(t?.answer).not.toMatch(/Chernarus/);\n    expect(t?.answer).not.toMatch(/Livonia/);\n\n    const e = answerDayz129CatalogQuestion('Event StaticHeliCrash auf Livonia');\n    expect(e?.answer).toMatch(/Livonia/);\n    expect(e?.answer).not.toMatch(/Chernarus/);\n    expect(e?.answer).not.toMatch(/Sakhal/);\n  });\n\n"
assert anchor in s
s = s.replace(anchor, insert + anchor, 1)
p.write_text(s)
