from pathlib import Path

# ---- nitradoHelp.ts ----
p = Path('src/modules/ai/nitradoHelp.ts')
s = p.read_text()

marker = "const DAYZ_ENGINE_TOPICS: HelpTopic[] = [\n"
if 'const EVENTS_XML_DIRECT_ANSWER' not in s:
    block = r'''const EVENTS_XML_DIRECT_ANSWER = [
  'Die Datei heisst **`events.xml`** (Plural; `Event.xml` ist nur eine haeufige Kurz-/Fehlschreibweise). `db/events.xml` definiert dynamische Events der DayZ Central Economy, z. B. Fahrzeuge, Tiere, Infected und statische Events wie Helikopter-Wracks.',
  '',
  'Typische Event-Felder sind `nominal`, `min`, `max`, `lifetime`, `restock`, `saferadius`, `distanceradius`, `cleanupradius`, `flags`, `position`, `limit`, `active` und `children`. Die vorgesehenen Weltpositionen eines Events werden davon getrennt in `cfgeventspawns.xml` beschrieben.',
  '',
  '**Echtes Chernarus-1.29-Beispiel:** `StaticHeliCrash` hat in Bohemias DZ_129-Referenz `nominal=3`, `lifetime=2100`, `restock=0`, `saferadius=1000`, `distanceradius=1000`, `cleanupradius=1000`, `position=fixed`, `limit=child` und `active=1`. Als Child ist `Wreck_UH1Y` mit `lootmin=10`, `lootmax=15`, `min=1` und `max=3` hinterlegt.',
  '',
  'Wichtig: `events.xml` ist **nicht** die Datei fuer frei erfundene Start-/Endzeitplaene, Regenphasen oder zeitgesteuerte Zombie-Wellen. Solche Aussagen duerfen nicht aus dem Dateinamen abgeleitet werden.',
].join('\\n');

'''
    assert marker in s
    s = s.replace(marker, block + marker, 1)

if "id: 'events-xml'" not in s:
    topic = r'''  {
    id: 'events-xml',
    title: 'DayZ 1.29 – events.xml',
    triggers: ['events.xml', 'event.xml', 'event xml', 'eventxml', 'event-datei', 'event datei'],
    body: [
      '`db/events.xml` ist die Konfiguration fuer dynamische Central-Economy-Events.',
      'Belegte Eventarten umfassen unter anderem Fahrzeuge, Tiere, Infected und statische Events. Die Datei beschreibt WAS unter welchen Eventregeln erzeugt wird; `cfgeventspawns.xml` beschreibt die vorgesehenen Positionen.',
      'Belegte Felder sind unter anderem `nominal`, `min`, `max`, `lifetime`, `restock`, `saferadius`, `distanceradius`, `cleanupradius`, `flags`, `position`, `limit`, `active` und `children`.',
      'Nicht als Zeitplan-Datei erklaeren: keine erfundenen Start-/Endzeitfelder, Wetterphasen oder automatisch geplanten Zombie-Wellen hinzudichten.',
      'Chernarus DZ_129 `StaticHeliCrash`: nominal=3, lifetime=2100, restock=0, Radien=1000, position=fixed, limit=child, active=1; Child `Wreck_UH1Y` mit lootmin=10, lootmax=15, min=1, max=3.',
    ].join('\\n'),
    directAnswer: EVENTS_XML_DIRECT_ANSWER,
  },
'''
    assert marker in s
    s = s.replace(marker, marker + topic, 1)

s = s.replace(r"/\b(types|events|globals|messages|economy)\.xml\b/", r"/\b(types|events?|globals|messages|economy)\.xml\b/")

old = "export function isNitradoOrDayZHelpQuestion(question: string): boolean {\n  if (!question) return false;\n  if (isNitradoSpecificQuestion(question)) return true;\n  if (buildDayzKnowledgeContext(question).found) return true;"
new = "export function isNitradoOrDayZHelpQuestion(question: string): boolean {\n  if (!question) return false;\n  if (isNitradoSpecificQuestion(question)) return true;\n  if (looksLikeDayZFileQuestion(question)) return true;\n  if (buildDayzKnowledgeContext(question).found) return true;"
assert old in s
s = s.replace(old, new, 1)

if 'export function enrichDayzTechnicalFollowUp' not in s:
    insert_before = "export const KNOWN_DAYZ_HALLUCINATED_IDENTIFIERS = [\n"
    helper = r'''export function enrichDayzTechnicalFollowUp(question: string, previousAssistantText?: string | null): string {
  if (!question || !previousAssistantText) return question;
  const q = normalize(question).trim();
  if (q.length > 140 || !/(beispiel|wie genau|warum genau|was bedeutet das|kannst du das|kannst du mir|zeig mir|zeig das|und wie|und was|nochmal|dazu)/i.test(q)) return question;

  const match = previousAssistantText.match(/\b(?:events?|types|globals|messages|economy)\.xml\b|\b(?:cfg[a-z0-9_]+|mapgroup[a-z0-9_]+|mapcluster[a-z0-9_]+)\.(?:xml|json)\b|\bserverdz\.cfg\b|\binit\.c\b/i);
  if (!match) return question;
  let topic = match[0];
  if (/^event\.xml$/i.test(topic)) topic = 'events.xml';
  return `${topic}: ${question}`;
}

'''
    assert insert_before in s
    s = s.replace(insert_before, helper + insert_before, 1)

if 'function isEventsXmlQuestion' not in s:
    old_build_fn = "function isBuildAnywhereQuestion(question: string): boolean {\n  return /bauen\\s*\\+|bauen plus|build[ -]?anywhere|basebuilding|bauplatzierung|bauen aktivieren|bau aktivieren/.test(normalize(question));\n}\n"
    new_build_fn = old_build_fn + "\nfunction isEventsXmlQuestion(question: string): boolean {\n  return /\\bevents?\\.xml\\b|\\bevent\\s+xml\\b|\\beventxml\\b/.test(normalize(question));\n}\n"
    assert old_build_fn in s
    s = s.replace(old_build_fn, new_build_fn, 1)

old_fb = "export function buildDayzTechnicalFallback(question: string, violations: string[] = []): string {\n  if (isBuildAnywhereQuestion(question)) return BUILD_ANYWHERE_DIRECT_ANSWER;"
new_fb = "export function buildDayzTechnicalFallback(question: string, violations: string[] = []): string {\n  if (isBuildAnywhereQuestion(question)) return BUILD_ANYWHERE_DIRECT_ANSWER;\n  if (isEventsXmlQuestion(question)) return EVENTS_XML_DIRECT_ANSWER;"
assert old_fb in s
s = s.replace(old_fb, new_fb, 1)
p.write_text(s)

# ---- dayzKnowledge.ts ----
p = Path('src/modules/ai/dayzKnowledge.ts')
s = p.read_text()
old = "id: 'events.xml', aliases: ['events.xml', 'eventsxml', 'dynamische events', 'dynamic event', 'event spawn'],"
new = "id: 'events.xml', aliases: ['events.xml', 'event.xml', 'event xml', 'eventxml', 'eventsxml', 'dynamische events', 'dynamic event', 'event spawn'],"
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# ---- aiHandler.ts ----
p = Path('src/modules/ai/aiHandler.ts')
s = p.read_text()
if 'export interface AiResponse {' not in s:
    s = s.replace('interface AiResponse {', 'export interface AiResponse {', 1)
if "rateLimitSource?: 'user' | 'provider';" not in s:
    old = "  error?: string;\n}"
    new = "  error?: string;\n  rateLimitSource?: 'user' | 'provider';\n  retryAfterSeconds?: number;\n}"
    assert old in s
    s = s.replace(old, new, 1)
old = "        return { success: false, error: 'RATE_LIMIT' };"
if old in s:
    new = "        return {\n          success: false,\n          error: 'RATE_LIMIT',\n          rateLimitSource: 'user',\n          retryAfterSeconds: Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)),\n        };"
    s = s.replace(old, new, 1)
provider_old = "      return { success: false, error: 'RATE_LIMIT' };\n    }\n    return { success: false, error: 'AI nicht verfügbar.' };"
assert provider_old in s
s = s.replace(provider_old, "      return { success: false, error: 'RATE_LIMIT', rateLimitSource: 'provider' };\n    }\n    return { success: false, error: 'AI nicht verfügbar.' };", 1)
p.write_text(s)

# ---- rateLimiter.ts ----
p = Path('src/utils/rateLimiter.ts')
s = p.read_text()
old = "  ai: { windowMs: 60_000, maxRequests: 10 },"
assert old in s
s = s.replace(old, "  ai: { windowMs: 60_000, maxRequests: 20 },", 1)
p.write_text(s)

# ---- messageCreate.ts ----
p = Path('src/events/messageCreate.ts')
s = p.read_text()
import_anchor = "import { answerQuestion } from '../modules/ai/aiHandler';\n"
if "enrichDayzTechnicalFollowUp" not in s:
    assert import_anchor in s
    s = s.replace(import_anchor, import_anchor + "import { enrichDayzTechnicalFollowUp } from '../modules/ai/nitradoHelp';\n", 1)
old = "          // Letzte ~15 Nachrichten als Konversations-Kontext (inkl. Bot-Antworten,\n"
if "let aiQuestion = question;" not in s:
    assert old in s
    s = s.replace(old, "          let aiQuestion = question;\n\n" + old, 1)
old = "            const recent = await msg.channel.messages.fetch({ limit: 15, before: msg.id });\n            const me = msg.client.user?.id;\n            const ctxLines = Array.from(recent.values())"
new = "            const recent = await msg.channel.messages.fetch({ limit: 15, before: msg.id });\n            const me = msg.client.user?.id;\n            if (me) {\n              const previousBot = Array.from(recent.values()).find(m => m.author.id === me && (m.content?.trim()?.length ?? 0) > 0);\n              aiQuestion = enrichDayzTechnicalFollowUp(question, previousBot?.content);\n              if (aiQuestion !== question) logger.info(`[DayZ-Grounding] Folgefrage kontextualisiert: ${aiQuestion.slice(0, 120)}`);\n            }\n            const ctxLines = Array.from(recent.values())"
assert old in s
s = s.replace(old, new, 1)
old = "            question,\n          });\n          const mergedContext"
assert old in s
s = s.replace(old, "            question: aiQuestion,\n          });\n          const mergedContext", 1)
old = "          const r = await answerQuestion(question, {"
assert old in s
s = s.replace(old, "          const r = await answerQuestion(aiQuestion, {", 1)
old = "                  responseText = '⏳ Mein KI-Kontingent ist gerade ausgeschöpft. Bitte versuch es in ein paar Minuten nochmal.';"
assert old in s
s = s.replace(old, "                  responseText = r.rateLimitSource === 'user'\n                    ? `⏳ Du hast gerade viele KI-Anfragen gesendet. Bitte warte noch etwa ${r.retryAfterSeconds ?? 60} Sekunden.`\n                    : '⏳ Die KI-Anbieter sind gerade im Rate-Limit. Bitte versuch es in ein paar Minuten nochmal.';", 1)
old = "              r.error === 'RATE_LIMIT'\n                ? '⏳ Mein KI-Kontingent ist gerade ausgeschöpft (Rate-Limit). Bitte versuch es in ein paar Minuten nochmal.'\n                : \"🤔 Hmm, da hat gerade etwas nicht geklappt. Versuch's bitte gleich nochmal.\";"
assert old in s
s = s.replace(old, "              r.error === 'RATE_LIMIT'\n                ? (r.rateLimitSource === 'user'\n                    ? `⏳ Du hast gerade viele KI-Anfragen gesendet. Bitte warte noch etwa ${r.retryAfterSeconds ?? 60} Sekunden.`\n                    : '⏳ Die KI-Anbieter sind gerade im Rate-Limit. Bitte versuch es in ein paar Minuten nochmal.')\n                : \"🤔 Hmm, da hat gerade etwas nicht geklappt. Versuch's bitte gleich nochmal.\";", 1)
p.write_text(s)

# ---- tests ----
p = Path('tests/ai/nitradoHelp.test.ts')
s = p.read_text()
if '  enrichDayzTechnicalFollowUp,\n' not in s:
    s = s.replace('  extractDayzTechnicalIdentifiers,\n', '  extractDayzTechnicalIdentifiers,\n  enrichDayzTechnicalFollowUp,\n', 1)
test_marker = "  it('liefert nach blockierter Bauen+-Generation einen deterministischen Fallback', () => {"
if "erkennt Event.xml als events.xml" not in s:
    tests = r'''  it('erkennt Event.xml als events.xml und antwortet deterministisch ohne Zeitplan-Halluzination', () => {
    expect(looksLikeDayZFileQuestion('Was ist die Event.xml?')).toBe(true);
    expect(isDayzTechnicalAdminQuestion('Was ist die Event.xml?')).toBe(true);
    expect(isNitradoOrDayZHelpQuestion('Was ist die Event.xml?')).toBe(true);
    const a = lookupNitradoHelp('Was ist die Event.xml?');
    expect(a.found).toBe(true);
    expect(a.directAnswer).toMatch(/events\.xml/);
    expect(a.directAnswer).toMatch(/dynamische Events/i);
    expect(a.directAnswer).toMatch(/StaticHeliCrash/);
    expect(a.directAnswer).toMatch(/nominal=3/);
    expect(a.directAnswer).toMatch(/Wreck_UH1Y/);
    expect(a.directAnswer).not.toMatch(/Start-.*Endzeit|Regenphasen|Zombie-Wellen.*festgelegten Zeiten/i);
  });

  it('kontextualisiert kurze DayZ-Folgefragen auf die vorherige Datei', () => {
    expect(enrichDayzTechnicalFollowUp('hast du ein Beispiel?', 'Die events.xml definiert dynamische Events.')).toBe('events.xml: hast du ein Beispiel?');
    expect(enrichDayzTechnicalFollowUp('hast du ein Beispiel?', 'Die Event.xml definiert Events.')).toBe('events.xml: hast du ein Beispiel?');
    expect(enrichDayzTechnicalFollowUp('Wer ist Bundeskanzler?', 'Die events.xml definiert dynamische Events.')).toBe('Wer ist Bundeskanzler?');
  });

'''
    assert test_marker in s
    s = s.replace(test_marker, tests + test_marker, 1)
p.write_text(s)

required = [
    ('src/modules/ai/nitradoHelp.ts', 'EVENTS_XML_DIRECT_ANSWER'),
    ('src/modules/ai/nitradoHelp.ts', 'enrichDayzTechnicalFollowUp'),
    ('src/modules/ai/nitradoHelp.ts', "id: 'events-xml'"),
    ('src/modules/ai/aiHandler.ts', "rateLimitSource: 'user'"),
    ('src/modules/ai/aiHandler.ts', "rateLimitSource: 'provider'"),
    ('src/events/messageCreate.ts', 'let aiQuestion = question'),
    ('src/utils/rateLimiter.ts', 'maxRequests: 20'),
]
for fn, needle in required:
    if needle not in Path(fn).read_text():
        raise SystemExit(f'missing {needle} in {fn}')
