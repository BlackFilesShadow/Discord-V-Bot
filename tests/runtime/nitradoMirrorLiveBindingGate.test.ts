import fs from 'node:fs';
import path from 'node:path';

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}

function functionBody(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Nitrado-1R mirror -> LIVE_SERVER binding fence', () => {
  const snapshotService = read('src/modules/nitrado/mirror/snapshotService.ts');
  const liveIndex = read('src/modules/ai/liveServerKnowledgeIndex.ts');
  const constants = read('src/modules/ai/liveServerKnowledgeConstants.ts');

  it('captures mirror token/service/generation only through the canonical ACTIVE binding fence', () => {
    const start = functionBody(snapshotService, 'export async function startSnapshot', 'async function runSnapshot');

    expect(start).toContain('readCurrentAdmBinding({ id: opts.nitradoConnId, guildId: opts.guildId })');
    expect(start).toContain('serviceId: binding.nitradoServerId');
    expect(start).toContain('void runSnapshot(snap.id, binding)');
    expect(start).not.toContain('serviceId ??');
    expect(start).not.toContain('nitradoConnection.findFirst');
  });

  it('carries the exact original binding through remote I/O into the only live-index call', () => {
    const run = functionBody(snapshotService, 'async function runSnapshot', 'function parentOf');

    expect(run).toContain('binding: AdmBindingSnapshot');
    expect(run).toContain('const serviceId = binding.nitradoServerId');
    expect(run).toContain('decrypt(binding.encryptedToken');
    expect(run).toContain('indexNitradoSnapshotKnowledge({ snapshotId, guildId, nitradoConnId: connId, binding })');
  });

  it('requires snapshot service identity before parsing and the full binding fence before local replacement', () => {
    const start = liveIndex.indexOf('export async function indexNitradoSnapshotKnowledge');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = liveIndex.slice(start);

    const identity = body.indexOf('input.binding.id !== input.nitradoConnId');
    const snapshotRead = body.indexOf('prisma.nitradoSnapshot.findFirst');
    const serviceCheck = body.indexOf('snapshot.serviceId !== input.binding.nitradoServerId');
    const fileRead = body.indexOf('prisma.nitradoSnapshotFile.findMany');
    const fence = body.indexOf('withFreshAdmBinding(input.binding');
    const transaction = body.indexOf('prisma.$transaction', fence);
    const replacement = body.indexOf('deleteGeneratedLiveServerKnowledge(', transaction);
    const firstCreate = body.indexOf('tx.guildKnowledge.create', transaction);

    expect(identity).toBeGreaterThanOrEqual(0);
    expect(snapshotRead).toBeGreaterThan(identity);
    expect(serviceCheck).toBeGreaterThan(snapshotRead);
    expect(fileRead).toBeGreaterThan(serviceCheck);
    expect(fence).toBeGreaterThan(fileRead);
    expect(transaction).toBeGreaterThan(fence);
    expect(replacement).toBeGreaterThan(transaction);
    expect(firstCreate).toBeGreaterThan(replacement);
  });

  it('version-stamps generated LIVE_SERVER provenance so later lifecycle gates can fail closed by generation', () => {
    expect(constants).toContain('export function liveServerSourceVersion(bindingVersion: number, snapshotId: string, sha256: string)');
    expect(constants).toContain('const prefix = `b${bindingVersion}:${snapshot}:`;');
    expect(liveIndex).toContain('liveServerSourceVersion(input.binding.bindingVersion, input.snapshotId, document.sha256)');
  });
});
