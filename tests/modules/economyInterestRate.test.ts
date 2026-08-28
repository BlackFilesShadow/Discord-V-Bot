import { computeInterestBasisPoints } from '../../src/modules/economy/bankInterest';
import { interestBasisPointsToPercent, parseInterestPercent } from '../../src/modules/economy/interestRate';

describe('Economy bank interest precision', () => {
  it('parst ganze und dezimale Prozentwerte exakt in Basispunkte', () => {
    expect(parseInterestPercent(5)).toBe(500);
    expect(parseInterestPercent('2.5')).toBe(250);
    expect(parseInterestPercent('3,25')).toBe(325);
    expect(parseInterestPercent('100.00')).toBe(10_000);
    expect(interestBasisPointsToPercent(250)).toBe(2.5);
  });

  it('verweigert mehr als zwei Nachkommastellen und Werte ueber 100 Prozent', () => {
    expect(() => parseInterestPercent('2.555')).toThrow();
    expect(() => parseInterestPercent('100.01')).toThrow();
    expect(() => parseInterestPercent('-1')).toThrow();
  });

  it('berechnet Geld ausschliesslich mit BigInt und rundet Cent-/Float-frei ab', () => {
    expect(computeInterestBasisPoints(10_000n, 250)).toBe(250n);
    expect(computeInterestBasisPoints(12_000n, 250)).toBe(300n);
    expect(computeInterestBasisPoints(999n, 325)).toBe(32n);
    expect(computeInterestBasisPoints(0n, 250)).toBe(0n);
  });
});