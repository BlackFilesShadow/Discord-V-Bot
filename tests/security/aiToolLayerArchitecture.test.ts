import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

describe('AI-18 tool layer architecture', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const toolLayerPath = path.join(repoRoot, 'src/modules/ai/toolLayer.ts');
  const toolRuntimePath = path.join(repoRoot, 'src/modules/ai/toolRuntime.ts');
  const aiRuntimePath = path.join(repoRoot, 'src/modules/ai/runtime.ts');
  const aiHandlerPath = path.join(repoRoot, 'src/modules/ai/aiHandler.ts');
  const stepUpPath = path.join(repoRoot, 'src/security/aiToolStepUp.ts');

  test('tool execution boundary has no direct destructive infrastructure imports', () => {
    const source = normalizeSourceNewlines(fs.readFileSync(toolLayerPath, 'utf8'));
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

  test('production runtime wires AiToolExecutor and only trusted entry executeProductionAiTool', () => {
    const runtime = normalizeSourceNewlines(fs.readFileSync(toolRuntimePath, 'utf8'));
    const aiRuntime = normalizeSourceNewlines(fs.readFileSync(aiRuntimePath, 'utf8'));
    expect(runtime).toContain('new AiToolExecutor');
    expect(runtime).toContain('executeProductionAiTool');
    expect(runtime).toContain('authorizeAiToolRequest');
    expect(runtime).toContain("name: 'nitrado.connection.status'");
    expect(runtime).toMatch(/risk:\s*'READ_ONLY'/);
    expect(runtime).not.toMatch(/risk:\s*'DESTRUCTIVE'/);
    expect(runtime).not.toMatch(/risk:\s*'MUTATING'/);
    expect(aiRuntime).toContain('getProductionAiToolExecutor');
    expect(aiRuntime).toContain('listProductionAiToolNames');
  });

  test('main LLM runtime cannot mint step-up grants or import the signing service', () => {
    const source = normalizeSourceNewlines(fs.readFileSync(aiHandlerPath, 'utf8'));
    expect(source).not.toMatch(/aiToolStepUp/);
    expect(source).not.toMatch(/toolRuntime/);
    expect(source).not.toMatch(/\.issue\s*\(/);
  });

  test('step-up issuer lives outside the AI/model module and explicitly requires user confirmation', () => {
    expect(stepUpPath).not.toContain(`${path.sep}modules${path.sep}ai${path.sep}`);
    const source = normalizeSourceNewlines(fs.readFileSync(stepUpPath, 'utf8'));
    expect(source).toContain('confirmedByUser: true');
    expect(source).toContain('verifyAndConsume');
    expect(source).toContain('consumedNonces');
    expect(source).toContain("createHmac('sha256'");
  });
});
