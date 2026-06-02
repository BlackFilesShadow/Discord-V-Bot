import { validateDayzXml, detectDayzXmlKind } from '../../src/dashboard/services/devValidators';

describe('validateDayzXml — DayZ XML structural validation (Spec §9)', () => {
  describe('detectDayzXmlKind', () => {
    it('detects by file name', () => {
      expect(detectDayzXmlKind('<types></types>', 'types.xml')).toBe('types');
      expect(detectDayzXmlKind('<events></events>', 'events.xml')).toBe('events');
      expect(detectDayzXmlKind('<variables></variables>', 'globals.xml')).toBe('globals');
    });
    it('detects by root element when no file name', () => {
      expect(detectDayzXmlKind('<types><type name="x"/></types>')).toBe('types');
      expect(detectDayzXmlKind('<variables><var name="x" value="1"/></variables>')).toBe('globals');
    });
    it('returns generic for unknown structures', () => {
      expect(detectDayzXmlKind('<config><x/></config>', 'config.xml')).toBe('generic');
    });
  });

  describe('types.xml', () => {
    it('accepts a valid type', () => {
      const xml = '<types><type name="Apple"><nominal>10</nominal><min>5</min><lifetime>3600</lifetime></type></types>';
      const r = validateDayzXml(xml, 'types.xml');
      expect(r.kind).toBe('types');
      expect(r.ok).toBe(true);
      expect(r.issues).toHaveLength(0);
    });

    it('flags missing name', () => {
      const xml = '<types><type><nominal>10</nominal><min>5</min><lifetime>1</lifetime></type></types>';
      const r = validateDayzXml(xml, 'types.xml');
      expect(r.ok).toBe(false);
      expect(r.issues.some(i => i.message.includes('name-Attribut'))).toBe(true);
    });

    it('flags duplicate type names', () => {
      const xml = '<types>'
        + '<type name="A"><nominal>1</nominal><min>1</min><lifetime>1</lifetime></type>'
        + '<type name="A"><nominal>1</nominal><min>1</min><lifetime>1</lifetime></type>'
        + '</types>';
      const r = validateDayzXml(xml, 'types.xml');
      expect(r.issues.some(i => i.message.includes('Doppelter type name'))).toBe(true);
    });

    it('flags min > nominal', () => {
      const xml = '<types><type name="A"><nominal>5</nominal><min>10</min><lifetime>1</lifetime></type></types>';
      const r = validateDayzXml(xml, 'types.xml');
      expect(r.issues.some(i => i.message.includes('min') && i.message.includes('> nominal'))).toBe(true);
    });

    it('flags negative values', () => {
      const xml = '<types><type name="A"><nominal>-1</nominal><min>1</min><lifetime>1</lifetime></type></types>';
      const r = validateDayzXml(xml, 'types.xml');
      expect(r.issues.some(i => i.message.includes('negativ'))).toBe(true);
    });
  });

  describe('events.xml', () => {
    it('flags min > max', () => {
      const xml = '<events><event name="E"><nominal>2</nominal><min>5</min><max>3</max></event></events>';
      const r = validateDayzXml(xml, 'events.xml');
      expect(r.kind).toBe('events');
      expect(r.issues.some(i => i.message.includes('min') && i.message.includes('> max'))).toBe(true);
    });
  });

  describe('globals.xml', () => {
    it('flags missing value', () => {
      const xml = '<variables><var name="CleanupLifetimeDeadInfected"/></variables>';
      const r = validateDayzXml(xml, 'globals.xml');
      expect(r.kind).toBe('globals');
      expect(r.issues.some(i => i.message.includes('value fehlt'))).toBe(true);
    });

    it('accepts valid var', () => {
      const xml = '<variables><var name="A" value="42"/></variables>';
      const r = validateDayzXml(xml, 'globals.xml');
      expect(r.ok).toBe(true);
    });
  });

  it('returns malformed XML errors before structural checks', () => {
    const r = validateDayzXml('<types><type name="A"></types>', 'types.xml');
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});
