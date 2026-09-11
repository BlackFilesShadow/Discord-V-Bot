import {
  Colors,
  compactDescription,
  compactQuote,
  economyEmbed,
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
});
