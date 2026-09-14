import {
  Colors,
  compactDescription,
  compactQuote,
  economyEmbed,
  vEmbed,
} from '../../src/utils/embedDesign';

describe('compact V-Bot embed design primitives', () => {
  it('keeps the compact card footer but removes the duplicate embed timestamp', () => {
    const json = economyEmbed(Colors.Primary, 'V-Bot • Testserver').toJSON();

    expect(json.color).toBe(Colors.Primary);
    expect(json.footer?.text).toBe('V-Bot • Testserver');
    expect(json.timestamp).toBeUndefined();
  });

  it('renders the approved bold heading plus compact quoted value list', () => {
    const description = compactDescription('▣ Balance · <@123>', [
      compactQuote([
        'Cash: **100 🐭**',
        'Bank: **200 🐭**',
        'Total: **300 🐭**',
      ]),
    ]);

    expect(description).toBe([
      '**▣ Balance · <@123>**',
      '> Cash: **100 🐭**',
      '> Bank: **200 🐭**',
      '> Total: **300 🐭**',
    ].join('\n'));
  });

  it('automatically converts legacy fixed vEmbed titles into the compact description heading', () => {
    const json = vEmbed(Colors.Error)
      .setTitle('Aktion fehlgeschlagen')
      .setDescription('Bitte erneut versuchen.')
      .toJSON();

    expect(json.title).toBeUndefined();
    expect(json.description).toBe('**❌ Aktion fehlgeschlagen**\nBitte erneut versuchen.');
    expect(json.color).toBe(Colors.Error);
  });

  it('keeps title URLs clickable after fixed headings move into the description', () => {
    const json = vEmbed(Colors.Info)
      .setTitle('Statusseite')
      .setURL('https://example.com/status')
      .setDescription('Aktueller Zustand')
      .toJSON();

    expect(json.title).toBeUndefined();
    expect(json.url).toBe('https://example.com/status');
    expect(json.description).toBe('**[❕ Statusseite](https://example.com/status)**\nAktueller Zustand');
  });

  it('caps compact descriptions at Discord\'s 4096-character limit', () => {
    const description = compactDescription('Titel', ['x'.repeat(5000)]);
    expect(description.length).toBe(4096);
    expect(description.endsWith('…')).toBe(true);
  });

  it('does not stack a second status icon in front of a title that already carries its own thematic emoji', () => {
    const json = vEmbed(Colors.Error)
      .setTitle('🔨 BAN · Case #5')
      .setDescription('Details.')
      .toJSON();

    expect(json.description).toBe('**🔨 BAN · Case #5**\nDetails.');
  });

  it('still replaces a stale leading canonical status icon with the current one', () => {
    const json = vEmbed(Colors.Success)
      .setTitle('❌ Aktion fehlgeschlagen')
      .toJSON();

    expect(json.description).toBe('**✅ Aktion fehlgeschlagen**');
  });
});
