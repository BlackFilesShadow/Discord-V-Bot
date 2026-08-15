import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('Bot-Admin Command-Center Safety', () => {
  const routes = read('src/dashboard/routes/v2.ts');
  const safety = read('src/dashboard/routes/v2/botAdminCommandCenterSafety.ts');
  const commandCenter = read('src/dashboard/routes/v2/botAdminCommandCenter.ts');

  it('mountet Safety vor dem Command-Center-Sammelrouter', () => {
    expect(routes).toContain(
      "v2Router.use('/bot-admin/command-center', requireGlobalBotAdminIdentity, guardBotAdminCommandCenterInput, botAdminCommandCenterSafetyRouter, botAdminCommandCenterRouter);",
    );
  });

  it('leitet alle erreichbaren Maintenance-Pfade auf kanonische Safety-Services', () => {
    expect(safety).toContain("post('/validate/package/:id'");
    expect(safety).toContain("post('/validate/upload/:id'");
    expect(safety).toContain("delete('/uploads/:id'");
    expect(safety).toContain("delete('/packages/:id/hard'");
    expect(safety).toContain("post('/users/:id/packages/delete'");
    expect(safety).toContain('safeValidateUpload(');
    expect(safety).toContain('safeDeleteUpload(');
    expect(safety).toContain('hardDeletePackage(');
  });

  it('erzwingt DELETE serverseitig fuer Einzeldatei, Paket-Hard-Delete und Bulk-Hard-Delete', () => {
    expect(safety).toContain("function requireDeleteConfirmation(req: Request): boolean");
    expect(safety).toContain("return req.body?.confirm === 'DELETE'");

    const uploadDelete = safety.indexOf("delete('/uploads/:id'");
    const packageDelete = safety.indexOf("delete('/packages/:id/hard'");
    const bulkDelete = safety.indexOf("post('/users/:id/packages/delete'");
    const uploadConfirm = safety.indexOf('if (!requireDeleteConfirmation(req))', uploadDelete);
    const packageConfirm = safety.indexOf('if (!requireDeleteConfirmation(req))', packageDelete);
    const bulkConfirm = safety.indexOf('if (hard && !requireDeleteConfirmation(req))', bulkDelete);

    expect(uploadConfirm).toBeGreaterThan(uploadDelete);
    expect(uploadConfirm).toBeLessThan(packageDelete);
    expect(packageConfirm).toBeGreaterThan(packageDelete);
    expect(packageConfirm).toBeLessThan(bulkDelete);
    expect(bulkConfirm).toBeGreaterThan(bulkDelete);
  });

  it('meldet Bulk-Hard-Delete-Teilfehler explizit statt Erfolg zu simulieren', () => {
    expect(safety).toContain("'BOTADMIN_BULK_HARD_DELETE_ABORTED'");
    expect(safety).toContain('failedPackageId');
    expect(safety).toContain('partial:');
  });

  it('verbietet Schattenimplementierungen sicherheitskritischer Command-Center-Pfade', () => {
    expect(commandCenter).not.toContain("get('/audit/export'");
    expect(commandCenter).not.toContain("get('/triggers'");
    expect(commandCenter).not.toContain("post('/triggers'");
    expect(commandCenter).not.toContain("post('/triggers/upload'");
    expect(commandCenter).not.toContain("post('/triggers/clear'");
    expect(commandCenter).not.toContain("delete('/triggers/:id'");
    expect(commandCenter).not.toContain("post('/validate/package/:id'");
    expect(commandCenter).not.toContain("post('/validate/upload/:id'");
    expect(commandCenter).not.toContain("delete('/uploads/:id'");
    expect(commandCenter).not.toContain("delete('/packages/:id/hard'");
    expect(commandCenter).not.toContain("post('/users/:id/packages/delete'");
    expect(commandCenter).not.toContain('validateFile(');
    expect(commandCenter).not.toContain('hardDeletePackage(');
  });
});
