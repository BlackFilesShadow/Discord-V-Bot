import {
  countDayzValidationIssues,
  validateDayzKnowledgeFile,
  validateDayzKnowledgeSet,
} from '../../src/modules/ai/dayzConfigValidation';

const input = (name: string, content: string) => ({
  path: `/mpmissions/dayzOffline.chernarusplus/db/${name}`,
  name,
  content,
});

describe('AI-15 deterministic DayZ XML/JSON validation', () => {
  test('blocks malformed XML before it can become verified knowledge', () => {
    const result = validateDayzKnowledgeFile(input('types.xml', '<types><type name="M4A1"></types>'));
    expect(result.syntaxValid).toBe(false);
    expect(result.validForKnowledge).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'ERROR', code: 'SYNTAX_INVALID' }),
    ]));
  });

  test('blocks missing required CE tags and min greater than nominal', () => {
    const result = validateDayzKnowledgeFile(input('types.xml', `<?xml version="1.0"?><types>
      <type name="M4A1">
        <nominal>3</nominal><min>5</min><lifetime>7200</lifetime>
      </type>
    </types>`));
    expect(result.validForKnowledge).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUIRED_FIELD_MISSING', path: 'types.type[0].restock' }),
      expect.objectContaining({ code: 'MIN_GT_NOMINAL' }),
    ]));
  });

  test('accepts valid CE values including DayZ -1 quantity sentinels', () => {
    const result = validateDayzKnowledgeFile(input('types.xml', `<?xml version="1.0"?><types>
      <type name="M4A1">
        <nominal>7</nominal><min>3</min><lifetime>7200</lifetime><restock>1200</restock>
        <quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost>
      </type>
    </types>`));
    expect(result.syntaxValid).toBe(true);
    expect(result.validForKnowledge).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'ERROR')).toHaveLength(0);
    expect(result.identifiers).toContain('M4A1');
  });

  test('detects duplicate type identifiers deterministically', () => {
    const result = validateDayzKnowledgeFile(input('types.xml', `<types>
      <type name="NailBox"><nominal>20</nominal><min>10</min><lifetime>14400</lifetime><restock>0</restock></type>
      <type name="NailBox"><nominal>20</nominal><min>10</min><lifetime>14400</lifetime><restock>0</restock></type>
    </types>`));
    expect(result.validForKnowledge).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'ERROR', code: 'DUPLICATE_IDENTIFIER' }),
    ]));
  });

  test('blocks contradictory event ranges and invalid child references', () => {
    const result = validateDayzKnowledgeFile(input('events.xml', `<events>
      <event name="TestEvent">
        <nominal>12</nominal><min>8</min><max>4</max><lifetime>180</lifetime><restock>0</restock>
        <children><child /></children>
      </event>
    </events>`));
    expect(result.validForKnowledge).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MIN_GT_MAX' }),
      expect.objectContaining({ code: 'NOMINAL_OUTSIDE_RANGE' }),
      expect.objectContaining({ code: 'REFERENCE_MISSING' }),
    ]));
  });

  test('reports unusual lifetime as warning without turning a syntactically valid file into false facts', () => {
    const result = validateDayzKnowledgeFile(input('types.xml', `<types>
      <type name="LongLife"><nominal>1</nominal><min>0</min><lifetime>31536000</lifetime><restock>0</restock></type>
    </types>`));
    expect(result.validForKnowledge).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'WARNING', code: 'UNUSUAL_LIFETIME' }),
    ]));
  });

  test('blocks malformed JSON and structurally invalid cfgGameplay sections', () => {
    const malformed = validateDayzKnowledgeFile(input('cfggameplay.json', '{"version": 122,'));
    expect(malformed.syntaxValid).toBe(false);
    expect(malformed.validForKnowledge).toBe(false);
    expect(malformed.issues[0]).toEqual(expect.objectContaining({ code: 'SYNTAX_INVALID' }));

    const wrongSection = validateDayzKnowledgeFile(input('cfggameplay.json', JSON.stringify({
      version: 122,
      GeneralData: false,
    })));
    expect(wrongSection.validForKnowledge).toBe(false);
    expect(wrongSection.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JSON_SECTION_INVALID', path: '$.GeneralData' }),
    ]));
  });

  test('cross-file validation flags unknown event/spawn references without inventing certainty', () => {
    const files = [
      input('types.xml', `<types>
        <type name="KnownItem"><nominal>2</nominal><min>1</min><lifetime>7200</lifetime><restock>0</restock></type>
      </types>`),
      input('events.xml', `<events>
        <event name="Test"><nominal>1</nominal><min>0</min><max>2</max><lifetime>180</lifetime><restock>0</restock>
          <children><child name="UnknownModClass" /></children>
        </event>
      </events>`),
      input('cfgspawnabletypes.xml', `<spawnabletypes><type name="UnknownVehicle"><attachments><item name="KnownItem" /></attachments></type></spawnabletypes>`),
    ];
    const results = validateDayzKnowledgeSet(files);
    const eventResult = results.get(files[1].path)!;
    const spawnResult = results.get(files[2].path)!;
    expect(eventResult.validForKnowledge).toBe(true);
    expect(eventResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'WARNING', code: 'UNKNOWN_REFERENCE' }),
    ]));
    expect(spawnResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'WARNING', code: 'UNKNOWN_REFERENCE' }),
    ]));
    const totals = countDayzValidationIssues(results.values());
    expect(totals.errors).toBe(0);
    expect(totals.warnings).toBeGreaterThanOrEqual(2);
    expect(totals.rejectedFiles).toBe(0);
  });

  test('validates globals required identity/value and weather root structure', () => {
    const globals = validateDayzKnowledgeFile(input('globals.xml', `<variables>
      <var name="ZombieMaxCount" type="0" value="500" />
      <var type="0" value="10" />
    </variables>`));
    expect(globals.validForKnowledge).toBe(false);
    expect(globals.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'IDENTIFIER_MISSING' }),
    ]));

    const weather = validateDayzKnowledgeFile(input('cfgweather.xml', '<notweather />'));
    expect(weather.validForKnowledge).toBe(false);
    expect(weather.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ROOT_INVALID' }),
    ]));
  });
});
