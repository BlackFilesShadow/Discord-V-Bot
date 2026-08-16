import fs from 'node:fs';
import path from 'node:path';

function read(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
}

function exportedBlock(source: string, start: string, next: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(next, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Block ${start}..${next} nicht gefunden`);
  return source.slice(from, to);
}

describe('Economy command safety contract', () => {
  it('/balance exposes balances only and no transaction history', () => {
    const source = read('src/commands/dashboard/economy.ts');
    expect(source).not.toContain('recentTransactions');
    expect(source).not.toContain('Letzte 5 Transaktionen');
    expect(source).toContain("{ name: '👛 Wallet'");
    expect(source).toContain("{ name: '🏦 Bank'");
    expect(source).toContain("{ name: 'Σ Gesamt'");
  });

  it('/admin-pay is positive-only so deductions cannot bypass step-up', () => {
    const source = read('src/commands/dashboard/economy.ts');
    const block = exportedBlock(source, 'export const adminPayCommand', '// /grant wurde entfernt');
    expect(block).toContain(".setMinValue(1)");
    expect(block).not.toContain('.setMinValue(-');
    expect(block).toContain("'Guthaben hinzugefügt'");
  });

  it('/add-money credits immediately while /remove-money still queues confirmation', () => {
    const source = read('src/commands/dashboard/privileged.ts');
    const addBlock = exportedBlock(source, 'export const addMoneyCommand', 'export const removeMoneyCommand');
    const removeBlock = exportedBlock(source, 'export const removeMoneyCommand', 'export const forceLinkCommand');

    expect(addBlock).toContain('await adminPay({');
    expect(addBlock).not.toContain('queueAction(');
    expect(addBlock).toContain('confirmationRequired: false');

    expect(removeBlock).toContain('queueAction(');
    expect(removeBlock).toContain('ACTIONS.REMOVE_MONEY');
  });
});
