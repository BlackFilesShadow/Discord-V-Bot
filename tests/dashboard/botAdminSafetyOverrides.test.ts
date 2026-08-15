import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('Bot-Admin compatibility safety overrides', () => {
  const routes = read('src/dashboard/routes/v2.ts');
  const validateRoute = read('src/dashboard/routes/v2/botAdminSafeValidation.ts');
  const validateService = read('src/modules/dashboard/safeUploadValidation.ts');

  it('mountet Safety-Overrides und Guild-Referenzguard vor dem Legacy BotAdmin-Router', () => {
    expect(routes).toContain(
      "v2Router.use('/bot-admin', requireGlobalBotAdminIdentity, botAdminSafeValidationRouter, botAdminSafePackageDeleteRouter, guardBotAdminGuildReferences, botAdminRouter);",
    );
  });

  it('uebernimmt den weiterhin von der Hauptoberflaeche verwendeten POST /validate Pfad', () => {
    expect(validateRoute).toContain("botAdminSafeValidationRouter.post('/validate'");
    expect(validateRoute).toContain('safeValidateUpload(');
  });

  it('erzwingt lexikalischen und realen Upload-Root, Groessenlimit und Timeout vor persistierter Validierung', () => {
    const lexicalRootCheck = validateService.indexOf('isInsideUploadRoot(upload.filePath)');
    const realRootResolution = validateService.indexOf('realUploadRoot = await fs.realpath(config.upload.dir)');
    const realFileResolution = validateService.indexOf('realFile = await fs.realpath(upload.filePath)');
    const realRootCheck = validateService.indexOf('isInsideRoot(realFile, realUploadRoot)');
    const sizeCheck = validateService.indexOf('stat.size > MAX_VALIDATE_BYTES');
    const timeout = validateService.indexOf('withTimeout(validateFile(realFile)');
    const transaction = validateService.indexOf('await prisma.$transaction');

    expect(lexicalRootCheck).toBeGreaterThanOrEqual(0);
    expect(realRootResolution).toBeGreaterThan(lexicalRootCheck);
    expect(realFileResolution).toBeGreaterThan(realRootResolution);
    expect(realRootCheck).toBeGreaterThan(realFileResolution);
    expect(sizeCheck).toBeGreaterThan(realRootCheck);
    expect(timeout).toBeGreaterThan(sizeCheck);
    expect(transaction).toBeGreaterThan(timeout);
  });
});
