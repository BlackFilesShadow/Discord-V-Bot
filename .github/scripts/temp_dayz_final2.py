from pathlib import Path

# 1) Fix remaining literal backslash-n in events topic and enrich the deterministic answer with an exact XML example.
p = Path('src/modules/ai/nitradoHelp.ts')
s = p.read_text()
s = s.replace("    ].join('\\\\n'),\n    directAnswer: EVENTS_XML_DIRECT_ANSWER,", "    ].join('\\n'),\n    directAnswer: EVENTS_XML_DIRECT_ANSWER,", 1)
needle = "  '**Echtes Chernarus-1.29-Beispiel:** `StaticHeliCrash` hat in Bohemias DZ_129-Referenz `nominal=3`, `lifetime=2100`, `restock=0`, `saferadius=1000`, `distanceradius=1000`, `cleanupradius=1000`, `position=fixed`, `limit=child` und `active=1`. Als Child ist `Wreck_UH1Y` mit `lootmin=10`, `lootmax=15`, `min=1` und `max=3` hinterlegt.',\n  '',\n"
if "<event name=\"StaticHeliCrash\">" not in s:
    replacement = needle + "  '```xml',\n  '<event name=\"StaticHeliCrash\">',\n  '  <nominal>3</nominal>',\n  '  <min>0</min>',\n  '  <max>0</max>',\n  '  <lifetime>2100</lifetime>',\n  '  <restock>0</restock>',\n  '  <saferadius>1000</saferadius>',\n  '  <distanceradius>1000</distanceradius>',\n  '  <cleanupradius>1000</cleanupradius>',\n  '  <secondary>InfectedArmy</secondary>',\n  '  <flags deletable=\"1\" init_random=\"0\" remove_damaged=\"0\"/>',\n  '  <position>fixed</position>',\n  '  <limit>child</limit>',\n  '  <active>1</active>',\n  '  <children>',\n  '    <child lootmax=\"15\" lootmin=\"10\" max=\"3\" min=\"1\" type=\"Wreck_UH1Y\"/>',\n  '  </children>',\n  '</event>',\n  '```',\n  '',\n"
    assert needle in s
    s = s.replace(needle, replacement, 1)
p.write_text(s)

# 2) Deterministic DayZ direct answers must bypass the AI/user limiter entirely.
p = Path('src/modules/ai/aiHandler.ts')
s = p.read_text()
anchor = "  const context = opts.context;\n\n"
if 'DayZ direct-answer preflight' not in s:
    preflight = "  // DayZ direct-answer preflight: verified deterministic answers do not call an AI provider\n  // and therefore must not consume or be blocked by the per-user AI rate limit.\n  if (mode !== 'welcome') {\n    try {\n      const preflightHelp = lookupNitradoHelp(question);\n      if (preflightHelp.directAnswer) {\n        logger.info(`[DayZ-Grounding] direct-answer preflight (topics=${preflightHelp.topicIds.join(',')})`);\n        return { success: true, result: redactText(preflightHelp.directAnswer) };\n      }\n    } catch (e) {\n      logger.warn(`[DayZ-Grounding] direct-answer preflight fehlgeschlagen: ${String(e)}`);\n    }\n  }\n\n"
    assert anchor in s
    s = s.replace(anchor, anchor + preflight, 1)
p.write_text(s)

# 3) Short follow-ups search recent V-Bot messages until a DayZ-relevant one is found.
p = Path('src/events/messageCreate.ts')
s = p.read_text()
old = "            if (me) {\n              const previousBot = Array.from(recent.values()).find(m => m.author.id === me && (m.content?.trim()?.length ?? 0) > 0);\n              aiQuestion = enrichDayzTechnicalFollowUp(question, previousBot?.content);\n              if (aiQuestion !== question) logger.info(`[DayZ-Grounding] Folgefrage kontextualisiert: ${aiQuestion.slice(0, 120)}`);\n            }"
new = "            if (me) {\n              const recentBotMessages = Array.from(recent.values())\n                .filter(m => m.author.id === me && (m.content?.trim()?.length ?? 0) > 0);\n              for (const previousBot of recentBotMessages) {\n                const enriched = enrichDayzTechnicalFollowUp(question, previousBot.content);\n                if (enriched !== question) {\n                  aiQuestion = enriched;\n                  break;\n                }\n              }\n              if (aiQuestion !== question) logger.info(`[DayZ-Grounding] Folgefrage kontextualisiert: ${aiQuestion.slice(0, 120)}`);\n            }"
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# 4) Strengthen regression tests for real formatting/example and follow-up behavior.
p = Path('tests/ai/nitradoHelp.test.ts')
s = p.read_text()
old = "    expect(a.directAnswer).toMatch(/Wreck_UH1Y/);\n    expect(a.directAnswer).toMatch(/nicht.*Start-\\/Endzeit/i);"
new = "    expect(a.directAnswer).toMatch(/Wreck_UH1Y/);\n    expect(a.directAnswer).toMatch(/<event name=\\\"StaticHeliCrash\\\">/);\n    expect(a.directAnswer).toContain('\\n');\n    expect(a.directAnswer).not.toContain('\\\\n');\n    expect(a.directAnswer).toMatch(/nicht.*Start-\\/Endzeit/i);"
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)
