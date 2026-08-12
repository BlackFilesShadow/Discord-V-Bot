import { detectTypesXmlValueViolations } from '../../src/modules/ai/nitradoHelp';

describe('detectTypesXmlValueViolations — 1.29 compatibility', () => {
  it('flaggt Werte >25 nicht mehr pauschal', () => {
    const real129Examples = [
      '<type name="WaterBottle"><nominal>100</nominal><min>85</min></type>',
      'nominal="120" min="95"',
      '| Item | nominal | min | max |\n| X | 140 | 100 | 250 |',
    ].join('\n');
    expect(detectTypesXmlValueViolations(real129Examples)).toEqual([]);
  });

  it('liefert auch bei leerem Input keine erfundene Verletzung', () => {
    expect(detectTypesXmlValueViolations('')).toEqual([]);
  });
});
