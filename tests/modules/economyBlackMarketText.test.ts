import { normalizeMarketItemText, parseMarketDeliveryItems } from '../../src/modules/economy/blackMarket';

describe('Economy Schwarzmarkt — freie Itemtexte', () => {
  it('uebernimmt Itemtext inklusive Unicode-/Discord-Emoji ohne Classname-Pruefung', () => {
    expect(normalizeMarketItemText('  🔫 M4A1  ')).toBe('🔫 M4A1');
    expect(normalizeMarketItemText('🚗 Olga komplett')).toBe('🚗 Olga komplett');
    expect(normalizeMarketItemText('<:m4:123456789012345678> M4A1')).toBe('<:m4:123456789012345678> M4A1');
    expect(normalizeMarketItemText('VIP fuer 30 Tage')).toBe('VIP fuer 30 Tage');
  });

  it('akzeptiert neue itemText-Payloads und alte className-Payloads nur als Freitext', () => {
    expect(parseMarketDeliveryItems([{ itemText: '🔫 M4A1', quantity: 2 }])).toEqual([{ itemText: '🔫 M4A1', quantity: 2 }]);
    expect(parseMarketDeliveryItems([{ className: 'frei erfundenes Paket', quantity: 1 }])).toEqual([{ itemText: 'frei erfundenes Paket', quantity: 1 }]);
  });

  it('kombiniert identische freie Texte und schuetzt Mengen-/Textgrenzen', () => {
    expect(parseMarketDeliveryItems([
      { itemText: '📦 Paket', quantity: 2 },
      { itemText: '📦 Paket', quantity: 3 },
    ])).toEqual([{ itemText: '📦 Paket', quantity: 5 }]);
    expect(() => parseMarketDeliveryItems([{ itemText: '', quantity: 1 }])).toThrow();
    expect(() => parseMarketDeliveryItems([{ itemText: 'M4A1\nPreis 0', quantity: 1 }])).toThrow();
    expect(() => parseMarketDeliveryItems([{ itemText: 'M4A1', quantity: 1001 }])).toThrow();
  });
});