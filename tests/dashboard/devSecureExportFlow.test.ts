import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('DEV command-center security wiring', () => {
  const routes = read('src/dashboard/routes/v2.ts');
  const stepUp = read('src/dashboard/middleware/devStepUp.ts');
  const secureExport = read('src/dashboard/routes/v2/devSecureExport.ts');
  const app = read('dashboard-ui/src/App.tsx');

  it('setzt echte Step-Up-Pruefung vor Command Center, Incident und mutierende DEV-Stubs', () => {
    expect(routes).toContain("'/dev/command-center', requireGlobalDeveloperIdentity, requireDev, redirectLegacyDevExports, guardDevCommandCenterInput, requireVerifiedDevMutationStepUp");
    expect(routes).toContain("'/dev/incident', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp");
    expect(routes).toContain("'/dev/stubs', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp");
  });

  it('gibt Legacy-Exporte nicht mehr direkt per GET aus', () => {
    expect(stepUp).toContain("res.redirect(303, `/dev/secure-export?kind=packages");
    expect(stepUp).toContain("res.redirect(303, `/dev/secure-export?kind=user");
    expect(stepUp).toContain("res.redirect(303, `/dev/secure-export?kind=logs");
    expect(stepUp).not.toMatch(/reAuth=.*encodeURIComponent/);
  });

  it('stellt sensible Exporte ausschliesslich als POST hinter verifiziertem Step-Up bereit', () => {
    expect(routes).toContain("'/dev/secure-export', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp");
    expect(secureExport).toContain("devSecureExportRouter.post('/packages/:discordId'");
    expect(secureExport).toContain("devSecureExportRouter.post('/user/:discordId'");
    expect(secureExport).toContain("devSecureExportRouter.post('/logs'");
    expect(secureExport).not.toContain('devSecureExportRouter.get(');
  });

  it('streamt grosse Audit-Exporte seitenweise statt bis zu 50k Rows im RAM zu sammeln', () => {
    expect(secureExport).toContain('async function writeChunk');
    expect(secureExport).toContain("if (!(await writeChunk(res, '['))) return;");
    expect(secureExport).toContain('take: Math.min(AUDIT_PAGE_SIZE, MAX_ROWS - count)');
    expect(secureExport).toContain('prefix + jsonStringify(row)');
    expect(secureExport).not.toMatch(/const\s+rows\s*:[\s\S]*?=\s*\[\]/);
    expect(secureExport).not.toContain('rows.push(...page)');
  });

  it('hat eine geschuetzte Dashboard-Seite fuer die erneute Export-Authentisierung', () => {
    expect(app).toContain("import SecureDevExport from './pages/dev/SecureDevExport';");
    expect(app).toContain('<Route path="secure-export" element={<SecureDevExport />} />');
  });
});
