import { ingestChunk } from '../../src/modules/nitrado/adm/serverLogIngestor';

describe('serverLogIngestor — incremental chunks', () => {
  it('preserves absolute byte offsets from a seek range', () => {
    const line = '18:00:12 | Player "Alpha"(id=1) is connected\n';
    const result = ingestChunk(line, 4096, { fileName: 'DayZServer_2026-08-15.ADM' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].byteStart).toBe(4096);
    expect(result.events[0].byteEnd).toBe(4096 + Buffer.byteLength(line, 'utf8'));
    expect(result.newOffset).toBe(result.events[0].byteEnd);
  });

  it('does not advance across a trailing partial line', () => {
    const complete = '18:00:12 | Player "Alpha"(id=1) is connected\n';
    const partial = '18:00:20 | Player "Bravo"(id=2) is conn';
    const result = ingestChunk(complete + partial, 100, { fileName: 'DayZServer_2026-08-15.ADM' });
    expect(result.events).toHaveLength(1);
    expect(result.trailingPartial).toBe(partial);
    expect(result.newOffset).toBe(100 + Buffer.byteLength(complete, 'utf8'));
  });

  it('processes the previously partial line once it becomes complete', () => {
    const offset = 500;
    const completed = '18:00:20 | Player "Bravo"(id=2) is connected\n';
    const result = ingestChunk(completed, offset, { fileName: 'DayZServer_2026-08-15.ADM' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].actorName).toBe('Bravo');
    expect(result.newOffset).toBe(offset + Buffer.byteLength(completed, 'utf8'));
  });

  it('rejects unsafe absolute offsets', () => {
    expect(() => ingestChunk('x\n', -1)).toThrow(/Offset/);
    expect(() => ingestChunk('x\n', Number.MAX_SAFE_INTEGER + 1)).toThrow(/Offset/);
  });
});
