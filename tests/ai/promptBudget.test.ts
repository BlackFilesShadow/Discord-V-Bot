import { clampBlock, clampHistory, getPromptBudgets } from '../../src/modules/ai/promptBudget';

describe('promptBudget', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('liefert Default-Budgets', () => {
    const b = getPromptBudgets();
    expect(b.system).toBe(6000);
    expect(b.knowledge).toBe(4000);
    expect(b.userContext).toBe(1500);
  });

  it('uebersteuert Budgets per ENV', () => {
    process.env.MAX_KNOWLEDGE_CHARS = '100';
    expect(getPromptBudgets().knowledge).toBe(100);
  });

  it('ignoriert ungueltige ENV-Werte', () => {
    process.env.MAX_SYSTEM_CHARS = 'abc';
    expect(getPromptBudgets().system).toBe(6000);
    process.env.MAX_SYSTEM_CHARS = '-5';
    expect(getPromptBudgets().system).toBe(6000);
  });

  it('clampBlock gibt null fuer leere Eingabe', () => {
    expect(clampBlock('knowledge', null)).toBeNull();
    expect(clampBlock('knowledge', '')).toBeNull();
  });

  it('clampBlock laesst kurze Bloecke unveraendert', () => {
    const text = 'kurzer block';
    expect(clampBlock('knowledge', text)).toBe(text);
  });

  it('clampBlock kappt zu lange Bloecke mit Marker', () => {
    process.env.MAX_KNOWLEDGE_CHARS = '50';
    const long = 'wort '.repeat(50);
    const out = clampBlock('knowledge', long)!;
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('gekuerzt');
  });

  it('clampHistory behaelt juengste Turns innerhalb des Budgets', () => {
    process.env.MAX_HISTORY_CHARS = '20';
    const turns = [
      { role: 'user', content: 'aaaaaaaaaa' },     // 10
      { role: 'assistant', content: 'bbbbbbbbbb' }, // 10
      { role: 'user', content: 'cccccccccc' },     // 10 -> wuerde 30 ergeben
    ];
    const kept = clampHistory(turns);
    expect(kept.length).toBe(2);
    expect(kept[kept.length - 1].content).toBe('cccccccccc');
  });

  it('clampHistory behaelt mindestens den letzten Turn', () => {
    process.env.MAX_HISTORY_CHARS = '5';
    const turns = [{ role: 'user', content: 'viel zu langer turn ueber budget' }];
    expect(clampHistory(turns).length).toBe(1);
  });
});
