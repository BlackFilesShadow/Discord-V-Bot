import { formatProviderRateLimitMessage } from '../../src/modules/ai/rateLimitMessage';

describe('Provider Rate-Limit-Hinweis', () => {
  it('nennt die bestaetigte kurze Wartezeit in Sekunden', () => {
    expect(formatProviderRateLimitMessage(30)).toContain('30 Sekunden');
  });

  it('nennt laengere Wartezeiten in aufgerundeten Minuten', () => {
    expect(formatProviderRateLimitMessage(121)).toContain('3 Minuten');
  });

  it.each([undefined, 0, -1, NaN, Infinity])('erfindet ohne gueltige Wartezeit (%s) keine Minutenangabe', value => {
    const message = formatProviderRateLimitMessage(value);
    expect(message).toContain('später erneut');
    expect(message).not.toContain('Minuten');
    expect(message).not.toContain('Infinity');
  });
});
