from pathlib import Path

# aiHandler: catalog must be the first deterministic DayZ preflight.
p = Path('src/modules/ai/aiHandler.ts')
s = p.read_text()
needle = "import { classifyProviderHttpStatus, updateAllRateLimitedState } from './providerFailure';\n"
assert needle in s
if "from './dayz129Catalog'" not in s:
    s = s.replace(needle, needle + "import { answerDayz129CatalogQuestion } from './dayz129Catalog';\n", 1)
anchor = "  // DayZ direct-answer preflight: verified deterministic answers do not call an AI provider\n"
assert anchor in s
if '[DayZ-129-Catalog] direct-answer preflight' not in s:
    block = "  // Complete DayZ 1.29 catalog: every indexed file/class/event is resolved before rate-limit/provider use.\n  if (mode !== 'welcome') {\n    try {\n      const catalogAnswer = answerDayz129CatalogQuestion(question);\n      if (catalogAnswer) {\n        logger.info(`[DayZ-129-Catalog] direct-answer preflight (topic=${catalogAnswer.topic}, ids=${catalogAnswer.ids.slice(0, 3).join(',')})`);\n        return { success: true, result: redactText(catalogAnswer.answer) };\n      }\n    } catch (e) {\n      logger.error(`[DayZ-129-Catalog] preflight fehlgeschlagen: ${String(e)}`);\n    }\n  }\n\n"
    s = s.replace(anchor, block + anchor, 1)
p.write_text(s)

# messageCreate: generic follow-up resolver, not the old handful-of-files regex.
p = Path('src/events/messageCreate.ts')
s = p.read_text()
s = s.replace("import { enrichDayzTechnicalFollowUp } from '../modules/ai/nitradoHelp';", "import { enrichDayz129FollowUp } from '../modules/ai/dayz129Catalog';")
s = s.replace('enrichDayzTechnicalFollowUp(question, previousBot.content)', 'enrichDayz129FollowUp(question, previousBot.content)')
p.write_text(s)

# Closed-world validation: names present in the complete user ZIP index are valid evidence.
p = Path('src/modules/ai/nitradoHelp.ts')
s = p.read_text()
needle = "import { buildDayzKnowledgeContext, getDayzGroundingTruthBlock } from './dayzKnowledge';\n"
assert needle in s
if "isKnownDayz129Identifier" not in s.split('\n', 10)[0:10]:
    s = s.replace(needle, needle + "import { isKnownDayz129Identifier } from './dayz129Catalog';\n", 1)
old = "  for (const identifier of extractDayzTechnicalIdentifiers(answer)) {\n    if (!groundingContainsIdentifier(grounding, identifier)) violations.add(`nicht im Grounding belegter Identifier: ${identifier}`);\n  }"
new = "  for (const identifier of extractDayzTechnicalIdentifiers(answer)) {\n    if (isKnownDayz129Identifier(identifier)) continue;\n    if (!groundingContainsIdentifier(grounding, identifier)) violations.add(`nicht im Grounding belegter Identifier: ${identifier}`);\n  }"
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# Runtime provenance: exact values are from the three supplied ZIPs; BI is semantic reference only.
p = Path('src/modules/ai/dayz129Catalog.ts')
s = p.read_text()
s = s.replace('  verifiedAgainstUserManifest: boolean;\n', '  verifiedAgainstUserManifest?: boolean;\n')
insert_after = "const MAP_LABELS: Record<Dayz129Map, string> = {\n"
if 'DAYZ129_PROVENANCE' not in s:
    provenance = "export const DAYZ129_PROVENANCE = {\n  valueAndStructureSource: 'three user-supplied DayZ 1.29.163451 ZIP datasets',\n  officialSemanticReference: 'Bohemia DayZ documentation / DZ_129 where applicable',\n  rule: 'user ZIP values are never replaced by public-repository values when they differ',\n} as const;\n\n"
    s = s.replace(insert_after, provenance + insert_after, 1)
# Improve high-confidence natural class/event resolution.
s = s.replace("    if (candidates.length === 1) return formatTypeAnswer(candidates[0]);\n    if (candidates.length > 1) return candidateListAnswer('type', candidates);", "    if (candidates.length === 1) return formatTypeAnswer(candidates[0]);\n    if (candidates.length > 1) {\n      const top = searchDayz129Types(question, 2);\n      const exactNatural = ['nagelbox', 'naegelbox', 'wasserflasche', 'metallplatte', 'kabeltrommel', 'seekiste', 'autozelt'].some((x) => fold(question).includes(x));\n      if (exactNatural && top[0]) return formatTypeAnswer(top[0]);\n      return candidateListAnswer('type', candidates);\n    }")
s = s.replace("    if (candidates.length === 1) return formatEventAnswer(candidates[0]);\n    if (candidates.length > 1) return candidateListAnswer('event', candidates);", "    if (candidates.length === 1) return formatEventAnswer(candidates[0]);\n    if (candidates.length > 1) {\n      const strongNatural = /helikopterabsturz|heli\\s*crash|militaer.*konvoi|militär.*konvoi/.test(fold(question));\n      if (strongNatural) return formatEventAnswer(candidates[0]);\n      return candidateListAnswer('event', candidates);\n    }")
p.write_text(s)

# Generator provenance/source contract: input is the supplied dataset extraction, not public BI checkout.
p = Path('scripts/generate_dayz129_index.py')
s = p.read_text()
s = s.replace('The generator is intentionally fail-closed: every file listed in the user ZIP\nmanifest must exist in the Bohemia DZ_129 checkout and match size + SHA-256\nbefore any runtime data is generated.  Only the verified manifest file-set is\nindexed, so later upstream files cannot silently enter V-Bot\'s 1.29 corpus.', 'The generator is intentionally fail-closed: every file listed in the user ZIP\nmanifest must exist in the supplied extracted dataset roots and match size +\nSHA-256 before runtime data is generated. Public Bohemia sources are a semantic\ncross-check, not a substitute value source when the supplied ZIPs differ.')
s = s.replace('help="Bohemia DayZ-Central-Economy DZ_129 checkout"', 'help="directory containing the three extracted user mission roots"')
s = s.replace('// Source: supplied three DayZ 1.29 ZIPs, byte-verified against Bohemia DZ_129.', '// Source: supplied three DayZ 1.29 ZIPs, byte-verified against user-source-manifest.json.')
p.write_text(s)

# Regression test provenance assertion must match the actual compact index metadata.
p = Path('tests/ai/dayz129Catalog.test.ts')
s = p.read_text()
s = s.replace("    expect(index.verifiedAgainstUserManifest).toBe(true);\n", "    expect(index.sourceTag).toBe('DZ_129');\n")
p.write_text(s)
