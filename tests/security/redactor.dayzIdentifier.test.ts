import { getDayz129Index } from '../../src/modules/ai/dayz129Catalog';
import { PLACEHOLDER, redactText } from '../../src/modules/nitrado/mirror/redactor';

describe('redactor verified DayZ identifiers', () => {
  test('keeps a real long DayZ classname visible', () => {
    const known = getDayz129Index().allTypeNames.find((name) => name.length >= 20 && /[_-]/.test(name));
    expect(known).toBeTruthy();
    const out = redactText(`Classname: ${known}`);
    expect(out).toContain(known!);
    expect(out).not.toContain(PLACEHOLDER.guid);
  });
});
