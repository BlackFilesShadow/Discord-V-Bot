import type { KnowledgeSnippet } from '../../src/modules/ai/guildKnowledge';
import {
  attachHallucinationGuardReference,
  buildHallucinationGuardFallback,
  buildResolvedDayzHallucinationGuard,
  buildUnresolvedDayzHallucinationGuard,
  consumeHallucinationGuardReference,
  formatHallucinationGuardPrompt,
  preflightLiveServerQuestion,
  validateLiveServerAnswer,
} from '../../src/modules/ai/dayzHallucinationGuard';
import { assessKnowledgeProvenance } from '../../src/modules/ai/knowledgeProvenance';

function snippet(
  content: string,
  sourceRef = 'nitrado-mirror://conn-1/mission%2FdayzOffline.chernarusplus%2Ftypes.xml',
  sourceVersion = 'snap-1:abc',
): KnowledgeSnippet {
  const now = new Date();
  return {
    id: `${sourceRef}:${sourceVersion}:${content}`,
    label: 'Live types.xml',
    content,
    provenance: assessKnowledgeProvenance({
      sourceKind: 'LIVE_SERVER',
      trustLevel: 'VERIFIED',
      sourceRef,
      sourceVersion,
      observedAt: now,
      validUntil: new Date(now.getTime() + 86_400_000),
    }, now),
  };
}

function guard(snippets: KnowledgeSnippet[]) {
  return buildResolvedDayzHallucinationGuard({
    nitradoConnId: 'conn-1',
    slot: 1,
    alias: 'Alpha',
    snippets,
  });
}

describe('AI-16 DayZ hallucination guard', () => {
  test('extracts exact verified live values and identifiers from the existing RAG snippets', () => {
    const result = guard([
      snippet('LIVE_SERVER types.xml | mission/dayzOffline.chernarusplus/types.xml\ntype=M4A1 | nominal=7 | min=3 | lifetime=7200 | usage=Military | value=Tier4'),
    ]);
    expect(result.scopeStatus).toBe('RESOLVED');
    expect(result.identifiers).toEqual(expect.arrayContaining(['M4A1', 'Military', 'Tier4']));
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'M4A1', field: 'nominal', values: ['7'], conflict: false }),
      expect.objectContaining({ subject: 'M4A1', field: 'min', values: ['3'], conflict: false }),
    ]));
  });

  test('rejects cross-server, unverified and expired facts from the trusted guard', () => {
    const now = new Date();
    const unverified: KnowledgeSnippet = {
      ...snippet('type=M4A1 | nominal=99'),
      provenance: assessKnowledgeProvenance({
        sourceKind: 'LIVE_SERVER',
        trustLevel: 'UNVERIFIED',
        sourceRef: 'nitrado-mirror://conn-1/x',
        sourceVersion: 'bad',
        observedAt: now,
        validUntil: new Date(now.getTime() + 86_400_000),
      }, now),
    };
    const expired: KnowledgeSnippet = {
      ...snippet('type=M4A1 | nominal=88'),
      provenance: assessKnowledgeProvenance({
        sourceKind: 'LIVE_SERVER',
        trustLevel: 'VERIFIED',
        sourceRef: 'nitrado-mirror://conn-1/y',
        sourceVersion: 'old',
        observedAt: new Date(now.getTime() - 10 * 86_400_000),
        validUntil: new Date(now.getTime() - 1),
      }, now),
    };
    const result = guard([
      snippet('type=M4A1 | nominal=7'),
      snippet('type=M4A1 | nominal=66', 'nitrado-mirror://conn-2/types.xml'),
      unverified,
      expired,
    ]);
    const nominal = result.facts.find((fact) => fact.subject === 'M4A1' && fact.field === 'nominal');
    expect(nominal?.values).toEqual(['7']);
  });

  test('detects conflicting verified values instead of silently choosing one source', () => {
    const result = guard([
      snippet('type=M4A1 | nominal=7', 'nitrado-mirror://conn-1/a', 'snap-a'),
      snippet('type=M4A1 | nominal=9', 'nitrado-mirror://conn-1/b', 'snap-b'),
    ]);
    const nominal = result.facts.find((fact) => fact.subject === 'M4A1' && fact.field === 'nominal');
    expect(nominal).toEqual(expect.objectContaining({ values: ['7', '9'], conflict: true }));
    expect(result.conflictKeys).toContain(nominal!.key);
    const preflight = preflightLiveServerQuestion('Was ist aktuell nominal von M4A1 auf meinem Server?', result);
    expect(preflight.handled).toBe(true);
    expect(preflight.response).toMatch(/widersprechen/i);
  });

  test('answers an exact verified live value deterministically before an LLM can change it', () => {
    const result = guard([snippet('type=M4A1 | nominal=7 | min=3')]);
    const preflight = preflightLiveServerQuestion('Was ist nominal von M4A1 auf meinem Server?', result);
    expect(preflight).toEqual({ handled: true, response: 'Auf dem ausgewaehlten Server ist M4A1.nominal = 7.' });
  });

  test('fails closed when a live scope is ambiguous or a requested fact is missing', () => {
    const unresolved = preflightLiveServerQuestion(
      'Wie ist nominal von M4A1 auf meinem Server?',
      buildUnresolvedDayzHallucinationGuard(),
    );
    expect(unresolved.handled).toBe(true);
    expect(unresolved.response).toMatch(/eindeutigen Gameserver/i);

    const missing = preflightLiveServerQuestion(
      'Wie ist restock von M4A1 auf meinem Server?',
      guard([snippet('type=M4A1 | nominal=7')]),
    );
    expect(missing.handled).toBe(true);
    expect(missing.response).toMatch(/nicht sicher bestaetigen/i);
  });

  test('post-validation blocks an invented numeric value for a known live subject', () => {
    const result = guard([snippet('type=M4A1 | nominal=7')]);
    const validation = validateLiveServerAnswer(
      'Was ist nominal von M4A1 auf meinem Server?',
      'Beim M4A1 ist nominal 12.',
      result,
    );
    expect(validation.valid).toBe(false);
    expect(validation.violations).toContain('UNSUPPORTED_VALUE:M4A1.nominal=12');
    expect(buildHallucinationGuardFallback(validation.violations)).toMatch(/nicht sicher belegen/i);
  });

  test('post-validation accepts an exact grounded numeric value', () => {
    const result = guard([snippet('type=M4A1 | nominal=7')]);
    expect(validateLiveServerAnswer(
      'Was ist nominal von M4A1 auf meinem Server?',
      'Beim M4A1 ist nominal 7.',
      result,
    )).toEqual({ valid: true, violations: [] });
  });

  test('post-validation rejects an explicitly claimed unknown live identifier', () => {
    const result = guard([snippet('type=M4A1 | nominal=7')]);
    const validation = validateLiveServerAnswer(
      'Welche Werte hat M4A1 auf meinem Server?',
      'Zusätzlich ist type=TotallyInventedRifle aktiv.',
      result,
    );
    expect(validation.valid).toBe(false);
    expect(validation.violations).toContain('UNSUPPORTED_IDENTIFIER:TotallyInventedRifle');
  });

  test('general DayZ questions remain outside the live guard', () => {
    const result = guard([snippet('type=M4A1 | nominal=7')]);
    expect(preflightLiveServerQuestion('Wie aendere ich nominal in types.xml?', result)).toEqual({ handled: false });
    expect(validateLiveServerAnswer('Wie aendere ich nominal in types.xml?', 'Setze nominal auf den gewuenschten Wert.', result))
      .toEqual({ valid: true, violations: [] });
  });

  test('guard reference is one-shot and cannot be replaced by visible context text', () => {
    const result = guard([snippet('type=M4A1 | nominal=7')]);
    const wrapped = attachHallucinationGuardReference('visible-context', result)!;
    expect(wrapped).toMatch(/^AI16_GUARD_REF:/);
    const first = consumeHallucinationGuardReference(wrapped);
    expect(first.context).toBe('visible-context');
    expect(first.guard?.nitradoConnId).toBe('conn-1');
    const second = consumeHallucinationGuardReference(wrapped);
    expect(second.guard).toBeNull();
  });

  test('provider prompt contains the hard source contract but no source IDs are required in user output', () => {
    const text = formatHallucinationGuardPrompt(guard([snippet('type=M4A1 | nominal=7')]));
    expect(text).toContain('HALLUCINATION GUARD');
    expect(text).toContain('VERIFIED LIVE_SERVER');
    expect(text).toContain('M4A1');
    expect(text).toContain('"values":["7"]');
  });
});
