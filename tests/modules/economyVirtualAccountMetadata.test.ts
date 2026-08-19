import {
  normalizeVirtualAccountChannelId,
  normalizeVirtualAccountDescription,
} from '../../src/modules/economy/virtualAccountMetadata';

describe('Economy-1J virtual account metadata normalization', () => {
  it('normalizes optional descriptions without destroying intentional line breaks', () => {
    expect(normalizeVirtualAccountDescription('  Event   Kasse\n\n\nNur fuer Raid  ')).toBe('Event Kasse\n\nNur fuer Raid');
    expect(normalizeVirtualAccountDescription('')).toBeNull();
    expect(normalizeVirtualAccountDescription(null)).toBeNull();
  });

  it('rejects oversized or control-character descriptions', () => {
    expect(() => normalizeVirtualAccountDescription('x'.repeat(281))).toThrow(/maximal 280/);
    expect(() => normalizeVirtualAccountDescription('ok\u0000bad')).toThrow(/Steuerzeichen/);
  });

  it('accepts only Discord snowflake-shaped channel ids or null', () => {
    expect(normalizeVirtualAccountChannelId('12345678901234567')).toBe('12345678901234567');
    expect(normalizeVirtualAccountChannelId(' 12345678901234567890 ')).toBe('12345678901234567890');
    expect(normalizeVirtualAccountChannelId('')).toBeNull();
    expect(() => normalizeVirtualAccountChannelId('123')).toThrow(/ungueltig/);
    expect(() => normalizeVirtualAccountChannelId('1234567890123456x')).toThrow(/ungueltig/);
  });
});
