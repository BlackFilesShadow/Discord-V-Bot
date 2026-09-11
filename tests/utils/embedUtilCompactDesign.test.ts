import { createBotEmbed } from '../../src/utils/embedUtil';
import { Colors } from '../../src/utils/embedDesign';

describe('createBotEmbed compact presentation', () => {
  it('moves the visible heading into the compact description without changing fields', () => {
    const json = createBotEmbed({
      title: '📦 Pakete',
      description: 'Zwei Eintraege.',
      color: Colors.Primary,
      fields: [{ name: 'Paket A', value: 'Aktiv', inline: true }],
      footer: 'V-Bot • Pakete',
    }).toJSON();

    expect(json.title).toBeUndefined();
    expect(json.description).toBe('**📦 Pakete**\nZwei Eintraege.');
    expect(json.fields?.[0]).toMatchObject({ name: 'Paket A', value: 'Aktiv', inline: true });
    expect(json.footer?.text).toBe('V-Bot • Pakete');
    expect(json.timestamp).toBeUndefined();
  });

  it('preserves an explicitly requested timestamp', () => {
    const json = createBotEmbed({ title: 'Zeit', timestamp: true }).toJSON();
    expect(json.timestamp).toBeDefined();
  });

  it('keeps status color to status symbol coupling in the compact heading', () => {
    const json = createBotEmbed({ title: 'Erfolg', color: Colors.Success }).toJSON();
    expect(json.description).toBe('**✅ Erfolg**');
    expect(json.color).toBe(Colors.Success);
  });
});
