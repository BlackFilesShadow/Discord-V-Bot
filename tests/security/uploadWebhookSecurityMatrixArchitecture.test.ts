import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/upload-webhook-security-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string }>;
  residual?: unknown[];
};
const server = r('src/dashboard/server.ts');
const webhookTest = r('tests/security/webhookRawBody.test.ts');
const webhookReplay = r('tests/security/webhookReplayDelivery.test.ts');
const uploadRuntime = r('tests/modules/safeUploadValidation.test.ts');
const mimeRuntime = r('tests/security/uploadMimeContentValidationRuntime.test.ts');

describe('Stage 44 upload webhook security matrix', () => {
  it('documents stage', () => {
    expect(m.stage).toBe(44);
    expect(m.residual ?? []).toEqual([]);
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['mime-magic-bytes', 'webhook-replay-claim', 'upload-path-size']),
    );
  });

  it('keeps private upload dirs off static and webhook raw body coverage', () => {
    expect(server).toContain('/uploads/factions');
    expect(server).toContain('/uploads/media');
    expect(server).toContain('devUploadDir');
    expect(server).toContain('rawBody');
    expect(webhookTest.length).toBeGreaterThan(100);
  });

  it('pins Stage 44 webhook signature/replay + upload path/size + MIME runtime evidence', () => {
    expect(webhookTest).toContain('lehnt einen manipulierten Body ab');
    expect(webhookTest).toContain('lehnt fehlende und abgelaufene Timestamps ab');
    expect(webhookTest).toContain('blockiert denselben authentisierten Request beim zweiten Versuch');
    expect(webhookReplay).toContain('blockiert einen bereits geclaimten Replay vor jeder Discord-Zustellung');
    expect(uploadRuntime).toContain('blockiert Dateien groesser als 50 MB');
    expect(mimeRuntime).toContain('rejects spoofed image MIME vs magic bytes');
    expect(mimeRuntime).toContain('validateFile rejects unknown extensions');
    expect(webhookTest + webhookReplay + uploadRuntime + mimeRuntime).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });
});
