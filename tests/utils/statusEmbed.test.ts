/**
 * Zentraler Status-Embed-Builder: verbindliche Symbol-Farb-Kopplung.
 */
import { buildStatusEmbed, statusEmoji, statusColor } from '../../src/utils/statusEmbed';
import { Colors } from '../../src/utils/embedDesign';

describe('buildStatusEmbed', () => {
  it('SUCCESS -> grüner Haken + grüne Farbe', () => {
    const e = buildStatusEmbed({ status: 'SUCCESS', title: 'Einzahlung erfolgreich' }).toJSON();
    expect(e.title).toBe('✅ Einzahlung erfolgreich');
    expect(e.color).toBe(Colors.Success);
  });

  it('INFO -> Ausrufezeichen + blaue Farbe', () => {
    const e = buildStatusEmbed({ status: 'INFO', title: 'Beitrittsanfrage gestellt' }).toJSON();
    expect(e.title).toBe('❕ Beitrittsanfrage gestellt');
    expect(e.color).toBe(Colors.Info);
  });

  it('ERROR -> Kreuz + rote Farbe', () => {
    const e = buildStatusEmbed({ status: 'ERROR', title: 'Unzureichendes Guthaben' }).toJSON();
    expect(e.title).toBe('❌ Unzureichendes Guthaben');
    expect(e.color).toBe(Colors.Error);
  });

  it('behält thematische Emojis hinter dem Statussymbol', () => {
    const e = buildStatusEmbed({ status: 'INFO', title: '📋 Neue Anfrage' }).toJSON();
    expect(e.title).toBe('❕ 📋 Neue Anfrage');
  });

  it('ersetzt alte Statussymbole statt sie zu verdoppeln', () => {
    const e = buildStatusEmbed({ status: 'INFO', title: 'ℹ️ 📋 Neue Anfrage' }).toJSON();
    expect(e.title).toBe('❕ 📋 Neue Anfrage');
  });

  it('Felder sind standardmäßig einspaltig (inline:false)', () => {
    const e = buildStatusEmbed({
      status: 'SUCCESS', title: 'x',
      fields: [{ name: '💰 Betrag', value: '1.000 🪙' }],
    }).toJSON();
    expect(e.fields?.[0].inline).toBe(false);
  });

  it('erzwingt Discord-Längenlimits', () => {
    const e = buildStatusEmbed({ status: 'INFO', title: 'a'.repeat(400), description: 'b'.repeat(5000) }).toJSON();
    expect((e.title ?? '').length).toBeLessThanOrEqual(256);
    expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
  });

  it('normalisiert vorhandene Absatzabstände ohne Inhalt hinzuzufügen', () => {
    const e = buildStatusEmbed({
      status: 'INFO',
      title: 'Hinweis',
      description: 'Erster Abschnitt.\n\n\nZweiter Abschnitt.  \n',
    }).toJSON();

    expect(e.description).toBe('Erster Abschnitt.\n\nZweiter Abschnitt.');
  });

  it('genau ein Statussymbol im Titel (kein Doppel)', () => {
    const e = buildStatusEmbed({ status: 'ERROR', title: '❌ Fehler' }).toJSON();
    const count = ((e.title ?? '').match(/✅|❕|❌/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('statusEmoji/statusColor liefern die verbindliche Kopplung', () => {
    expect(statusEmoji('SUCCESS')).toBe('✅');
    expect(statusEmoji('INFO')).toBe('❕');
    expect(statusColor('ERROR')).toBe(Colors.Error);
  });
});
