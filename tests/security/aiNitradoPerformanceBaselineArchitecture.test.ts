import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/ai-nitrado-performance-baseline-matrix.json'));

describe('Stage 48 AI Nitrado performance baseline', () => {
  it('documents the exact loopback scope and keeps production boundaries explicit', () => {
    expect(m.stage).toBe(48);
    expect(m.schemaVersion).toBe(2);
    expect(m.status).toBe('VERIFIED');
    expect(m.exactSha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.cases.every((entry: { status: string }) => entry.status === 'dual-ci-verified')).toBe(true);
    expect(m.residual).toEqual([]);
    expect(m.externalProductionBoundary.stage).toBe(67);
    expect(m.externalProductionBoundary.claim).toMatch(/no production-provider RTT/i);
    const aiDir = path.resolve('src/ai');
    expect(fs.existsSync(aiDir) || fs.existsSync(path.resolve('src/modules'))).toBe(true);
    const env = r('.env.example');
    expect(env).toMatch(/AI_PROVIDER|GROQ_API_KEY|OPENAI_API_KEY/);
    expect(env).toMatch(/NITRADO|REDIS/);
    // Scope guards remain present from prior stages.
    expect(r('src/dashboard/middleware/economyScopeGuard.ts')).toContain('requireSafeDashboardEconomyScope');
  });

  it('drives the real clients over a guarded ephemeral TCP loopback server', () => {
    const probe = r('scripts/ai-nitrado-performance-48.ts');
    expect(probe).toContain("server.listen(0, '127.0.0.1'");
    expect(probe).toContain("require('../src/modules/ai/aiHandler')");
    expect(probe).toContain("require('../src/modules/nitrado/nitradoClient')");
    expect(probe).toContain("process.env.STAGE48_REQUIRE_LAB === '1'");
    expect(probe).toContain('remoteRequestsAfterFailFast === remoteRequestsAtOpen');
    expect(probe).toContain('Object.values(metricsPresent).every(Boolean)');

    const guard = r('src/utils/stage48Loopback.ts');
    expect(guard).toContain("process.env.STAGE48_LAB_MODE !== '1'");
    expect(guard).toContain("parsed.protocol !== 'http:'");
    expect(guard).toContain("'127.0.0.1', '::1'");

    const ai = r('src/modules/ai/aiHandler.ts');
    const nitrado = r('src/modules/nitrado/nitradoClient.ts');
    expect(ai).toContain('requireStage48LoopbackUrl(transport.baseUrl)');
    expect(nitrado).toContain('requireStage48LoopbackUrl(options.stage48LabBaseUrl)');
    expect(nitrado).toContain(': NITRADO_BASE');
  });

  it.each(['.github/workflows/ci.yml', '.github/workflows/verification2.yml'])(
    'makes the SHA-bound Stage 48 artifact mandatory in %s',
    workflowPath => {
      const workflow = r(workflowPath);
      expect(workflow).toContain('npm run perf:ai-nitrado-48');
      expect(workflow).toContain("STAGE48_REQUIRE_LAB: '1'");
      expect(workflow).toContain('STAGE48_EXACT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
      expect(workflow).toContain('stage48-artifacts/${{ github.event.pull_request.head.sha || github.sha }}.json');
      expect(workflow).toContain('stage48-artifacts/*.json');
    },
  );

  it('pins two independent byte-archived measurements and all Gate-1 runs to the technical SHA', () => {
    expect(m.verification.artifacts).toHaveLength(2);
    for (const artifactPath of m.verification.artifacts as string[]) {
      expect(fs.existsSync(path.resolve(artifactPath))).toBe(true);
      const artifact = JSON.parse(r(artifactPath));
      expect(artifact.stage).toBe(48);
      expect(artifact.exactSha).toBe(m.exactSha);
      expect(artifact.passed).toBe(true);
      expect(artifact.residual).toEqual([]);
      expect(artifact.ai.success.errorCount).toBe(0);
      expect(artifact.nitrado.success.errorCount).toBe(0);
      expect(artifact.nitrado.circuit.remoteRequestsAfterFailFast).toBe(
        artifact.nitrado.circuit.remoteRequestsAtOpen,
      );
    }

    const evidence = JSON.parse(r(m.verification.ciEvidence));
    expect(evidence.pullRequest).toBe(270);
    expect(evidence.technicalSha).toBe(m.exactSha);
    expect(evidence.runs).toHaveLength(3);
    for (const run of evidence.runs as Array<{ attempt: number; headSha: string; conclusion: string }>) {
      expect(run.attempt).toBe(1);
      expect(run.headSha).toBe(m.exactSha);
      expect(run.conclusion).toBe('success');
    }
  });
});
