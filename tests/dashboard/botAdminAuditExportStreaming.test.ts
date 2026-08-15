import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('Bot-Admin audit export streaming', () => {
  const routes = read('src/dashboard/routes/v2.ts');
  const exportRoute = read('src/dashboard/routes/v2/botAdminAuditExport.ts');

  it('mountet den Streaming-Export vor dem generischen Command-Center', () => {
    const streaming = routes.indexOf("v2Router.use('/bot-admin/command-center/audit/export'");
    const generic = routes.indexOf("v2Router.use('/bot-admin/command-center',");
    expect(streaming).toBeGreaterThanOrEqual(0);
    expect(generic).toBeGreaterThan(streaming);
  });

  it('liest AuditLogs in stabilen Cursor-Seiten statt 50k Rows auf einmal', () => {
    expect(exportRoute).toContain('const PAGE_SIZE = 1000');
    expect(exportRoute).toContain('take: Math.min(PAGE_SIZE, MAX_ROWS - count)');
    expect(exportRoute).toContain("cursor: { id: cursor }");
    expect(exportRoute).toContain('async function writeChunk');
    expect(exportRoute).not.toMatch(/findMany\([\s\S]*?take:\s*50_000/);
    expect(exportRoute).not.toMatch(/JSON\.stringify\([^\n]*rows/);
  });

  it('setzt Download-Responses auf no-store und beendet bei Client-Abbruch', () => {
    expect(exportRoute).toContain("Cache-Control', 'no-store, private'");
    expect(exportRoute).toContain('res.destroyed || res.writableEnded');
    expect(exportRoute).toContain('BOTADMIN_AUDIT_EXPORT_ABORTED');
  });
});
