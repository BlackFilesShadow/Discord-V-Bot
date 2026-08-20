import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('Bot-Admin hard-delete safety wiring', () => {
  const routes = read('src/dashboard/routes/v2.ts');
  const safeRoute = read('src/dashboard/routes/v2/botAdminSafePackageDelete.ts');
  const service = read('src/modules/packages/hardDeletePackage.ts');

  it('mountet XP-Retirement, Danger- und Safe-Delete-Router vor Guild-Guard, Contract-Adapter und Legacy-Router', () => {
    expect(routes).toContain(
      "v2Router.use('/bot-admin', requireGlobalBotAdminIdentity, botAdminXpRetirementRouter, botAdminDangerSafetyRouter, botAdminSafeValidationRouter, botAdminSafePackageDeleteRouter, guardBotAdminGuildReferences, botAdminLegacyContractRouter, botAdminRouter);",
    );
  });

  it('uebernimmt nur den legacy hard=true Pfad und laesst Soft-Delete unveraendert weiterlaufen', () => {
    expect(safeRoute).toContain("if (req.query.hard !== 'true')");
    expect(safeRoute).toContain('next();');
    expect(safeRoute).toContain('if (!pkg.isDeleted)');
  });

  it('revalidiert den Soft-Delete-Zustand im Service gegen Restore-Races', () => {
    expect(safeRoute).toContain("hardDeletePackage(packageId, { requireSoftDeleted: true })");
    expect(service).toContain('if (options.requireSoftDeleted && !pkg.isDeleted)');
  });

  it('validiert alle Pfade vor dem ersten unlink und loescht DB erst nach Filesystem-Cleanup', () => {
    const unsafeCheck = service.indexOf("const unsafe = pkg.files.find");
    const unlinkLoop = service.indexOf('for (const file of pkg.files)');
    const dbDelete = service.indexOf('await prisma.package.delete');
    expect(unsafeCheck).toBeGreaterThanOrEqual(0);
    expect(unlinkLoop).toBeGreaterThan(unsafeCheck);
    expect(dbDelete).toBeGreaterThan(unlinkLoop);
  });
});
