import {
  answerDayz129CatalogQuestion,
  searchDayz129Types,
} from '../../src/modules/ai/dayz129Catalog';
import { PLACEHOLDER, redactText } from '../../src/modules/nitrado/mirror/redactor';

describe('DayZ classname / grounding regressions', () => {
  test('specific Tundra classname question wins over the types.xml filename mention', () => {
    const answer = answerDayz129CatalogQuestion('weißt du wie die Tundra in der Types.xml heißt?');
    expect(answer?.topic).toBe('type');
    expect(answer?.answer).toContain('Winchester70');
    expect(answer?.answer).not.toMatch(/Vorkommen in deinen 1\.29-Datensaetzen/i);
    expect(answer?.answer).not.toMatch(/XML-Root/i);
  });

  test('direct Tundra classname wording resolves to Winchester70', () => {
    const answer = answerDayz129CatalogQuestion('hast du den Classname von der Tundra?');
    expect(answer?.topic).toBe('type');
    expect(answer?.answer).toBe('Der Classname ist **`Winchester70`**.');
    expect(searchDayz129Types('Tundra', 5)[0]).toBe('Winchester70');
  });

  test('existing exact classname detail lookup still uses the full grounded catalog', () => {
    const answer = answerDayz129CatalogQuestion('DayZ Classname WoodenPlank');
    expect(answer?.topic).toBe('type');
    expect(answer?.answer).toMatch(/Chernarus/);
    expect(answer?.answer).toMatch(/Livonia/);
    expect(answer?.answer).toMatch(/Sakhal/);
    expect(answer?.answer).toMatch(/crafted=1/);
  });

  test('verified long DayZ classnames are not mistaken for GUIDs', () => {
    const classname = 'AK_FoldingBttstck_Black';
    const out = redactText(`Classname: ${classname}`);
    expect(out).toContain(classname);
    expect(out).not.toContain(PLACEHOLDER.guid);
  });

  test('real console identifiers remain redacted', () => {
    const id = 'K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=';
    const out = redactText(`Konsolen-ID: ${id}`);
    expect(out).not.toContain(id);
    expect(out).toContain(PLACEHOLDER.guid);
  });

  test('restock is explained as CE timing, not a guaranteed spawn-point timer', () => {
    const answer = answerDayz129CatalogQuestion('was ist der Restock?');
    expect(answer?.answer).toMatch(/Central Economy/i);
    expect(answer?.answer).toMatch(/Sekunden/i);
    expect(answer?.answer).toMatch(/nicht.*Spawnpunkt/i);
    expect(answer?.answer).not.toMatch(/Spawn-Punkt.*wieder auffüllt/i);
  });
});
