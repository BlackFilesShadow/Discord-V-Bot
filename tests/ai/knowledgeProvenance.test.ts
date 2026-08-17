import {
  assessKnowledgeProvenance,
  legacyKnowledgeProvenance,
  validateKnowledgeProvenance,
} from '../../src/modules/ai/knowledgeProvenance';

const NOW = new Date('2026-08-17T00:00:00.000Z');

describe('AI-11 knowledge provenance', () => {
  it('setzt manuell kuratierte Defaults konservativ', () => {
    const result = validateKnowledgeProvenance(undefined, {
      sourceKind: 'OWNER_CURATED',
      trustLevel: 'CURATED',
    }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      sourceKind: 'OWNER_CURATED',
      trustLevel: 'CURATED',
      sourceRef: null,
      sourceVersion: null,
      validUntil: null,
    });
    expect(result.value.observedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('verbietet AUTHORITATIVE ohne konkrete Source-Referenz', () => {
    const result = validateKnowledgeProvenance({
      sourceKind: 'OFFICIAL_DOC',
      trustLevel: 'AUTHORITATIVE',
      observedAt: NOW.toISOString(),
    }, undefined, NOW);
    expect(result).toEqual({ ok: false, message: 'AUTHORITATIVE erfordert eine konkrete sourceRef.' });
  });

  it('akzeptiert AUTHORITATIVE mit Quelle und Version', () => {
    const result = validateKnowledgeProvenance({
      sourceKind: 'OFFICIAL_DOC',
      trustLevel: 'AUTHORITATIVE',
      sourceRef: 'bohemia:dayz-server-config',
      sourceVersion: '2026-08',
      observedAt: '2026-08-16T12:00:00.000Z',
      validUntil: '2026-09-01T00:00:00.000Z',
    }, undefined, NOW);
    expect(result.ok).toBe(true);
  });

  it('weist Zukunfts-observedAt und invertierte Gueltigkeit ab', () => {
    expect(validateKnowledgeProvenance({
      observedAt: '2026-08-18T00:00:00.000Z',
    }, undefined, NOW).ok).toBe(false);

    expect(validateKnowledgeProvenance({
      observedAt: '2026-08-16T00:00:00.000Z',
      validUntil: '2026-08-15T00:00:00.000Z',
    }, undefined, NOW).ok).toBe(false);
  });

  it('berechnet Source-Age/Freshness je nach Quellentyp', () => {
    const freshLive = assessKnowledgeProvenance({
      sourceKind: 'LIVE_SERVER',
      trustLevel: 'VERIFIED',
      sourceRef: 'nitrado:123',
      sourceVersion: null,
      observedAt: new Date('2026-08-16T12:00:00.000Z'),
      validUntil: null,
    }, NOW);
    expect(freshLive.freshness).toBe('FRESH');
    expect(freshLive.sourceAgeDays).toBe(0.5);

    const staleLive = assessKnowledgeProvenance({
      sourceKind: 'LIVE_SERVER',
      trustLevel: 'VERIFIED',
      sourceRef: 'nitrado:123',
      sourceVersion: null,
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: null,
    }, NOW);
    expect(staleLive.freshness).toBe('STALE');
    expect(staleLive.qualityFactor).toBeLessThan(freshLive.qualityFactor);
  });

  it('markiert validUntil strikt als EXPIRED und Quality 0', () => {
    const meta = assessKnowledgeProvenance({
      sourceKind: 'OFFICIAL_DOC',
      trustLevel: 'AUTHORITATIVE',
      sourceRef: 'official:doc',
      sourceVersion: 'v1',
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: new Date('2026-08-16T23:59:59.000Z'),
    }, NOW);
    expect(meta.freshness).toBe('EXPIRED');
    expect(meta.qualityFactor).toBe(0);
  });

  it('behandelt Legacy-Snippets als CURATED statt sie unbemerkt AUTHORITATIVE zu machen', () => {
    const legacy = legacyKnowledgeProvenance(new Date('2026-08-01T00:00:00.000Z'), NOW);
    expect(legacy.sourceKind).toBe('OWNER_CURATED');
    expect(legacy.trustLevel).toBe('CURATED');
    expect(legacy.legacyDefault).toBe(true);
  });

  it('gibt hoehere Quality fuer gleich frische autoritative Quelle als UNVERIFIED', () => {
    const common = {
      sourceKind: 'OFFICIAL_DOC' as const,
      sourceRef: 'official:doc',
      sourceVersion: 'v1',
      observedAt: new Date('2026-08-16T00:00:00.000Z'),
      validUntil: null,
    };
    const authoritative = assessKnowledgeProvenance({ ...common, trustLevel: 'AUTHORITATIVE' }, NOW);
    const unverified = assessKnowledgeProvenance({ ...common, trustLevel: 'UNVERIFIED' }, NOW);
    expect(authoritative.qualityFactor).toBeGreaterThan(unverified.qualityFactor);
  });
});
