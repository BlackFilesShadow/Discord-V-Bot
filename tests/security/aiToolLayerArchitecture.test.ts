import fs from 'node:fs';
import path from 'node:path';

describe('AI-18 tool layer architecture', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const toolLayerPath = path.join(repoRoot, 'src/modules/ai/toolLayer.ts');
  const aiHandlerPath = path.join(repoRoot, 'src/modules/ai/aiHandler.ts');
  const stepUpPath = path.join(repoRoot, 'src/security/aiToolStepUp.ts');

  test('tool execution boundary has no direct destructive infrastructure imports', () => {
    const source = fs.readFileSync(toolLayerPath, 'utf8');
    const forbidden = [
      /database\/prisma/,
      /modules\/nitrado/,
      /modules\/economy/,
      /modules\/bans/,
      /modules\/whitelist/,
      /discord\.js/,
      /axios/,
    ];
    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
    expect(source).toContain('hasCommandPermission');
    expect(source).toContain("definition.risk !== 'READ_ONLY'");
    expect(source).toContain('verifyAndConsume');
  });

  test('main LLM runtime cannot mint step-up grants or import the signing service', () => {
    const source = fs.readFileSync(aiHandlerPath, 'utf8');
    expect(source).not.toMatch(/aiToolStepUp/);
    expect(source).not.toMatch(/\.issue\s*\(/);
  });

  test('step-up issuer lives outside the AI/model module and explicitly requires user confirmation', () => {
    expect(stepUpPath).not.toContain(`${path.sep}modules${path.sep}ai${path.sep}`);
    const source = fs.readFileSync(stepUpPath, 'utf8');
    expect(source).toContain('confirmedByUser: true');
    expect(source).toContain('verifyAndConsume');
    expect(source).toContain('consumedNonces');
    expect(source).toContain("createHmac('sha256'");
  });
});
