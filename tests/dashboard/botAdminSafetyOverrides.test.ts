import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('Bot-Admin compatibility safety overrides', () => {
  const routes = read('src/dashboard/routes/v2.ts');
  const validateRoute = read('src/dashboard/routes/v2/botAdminSafeValidation.ts');
  const validateService = read('src/modules/dashboard/safeUploadValidation.ts');

  it('mountet sichere Validation und Hard-Delete vor dem Legacy BotAdmin-Router', () => {
    expect(routes).toContain(
      "v2Router.use('/bot-admin', requireGlobalBotAdminIdentity, botAdminSafeValidationRouter, botAdminSafePackageDeleteRouter, botAdminRouter);",
    );
  });

  it('uebernimmt den weiterhin von der Hauptoberflaeche verwendeten POST /validate Pfad', () => {
    expect(validateRoute).toContain("botAdminSafeValidationRouter.post('/validate'");
    expect(validateRoute).toContain('safeValidateUpload(');
  });

  it('erzwingt Upload-Root, Groessenlimit und Timeout vor persistierter Validierung', () => {
    const rootCheck = validateService.indexOf('isInsideUploadRoot(upload.filePath)');
    const sizeCheck = validateService.indexOf('stat.size > MAX_VALIDATE_BYTES');
    const timeout = validateService.indexOf('withTimeout(validateFile(upload.filePath)');
    const transaction = validateService.indexOf('await prisma.$transaction');
    expect(rootCheck).toBeGreaterThanOrEqual(0);
    expect(sizeCheck).toBeGreaterThan(rootCheck);
    expect(timeout).toBeGreaterThan(sizeCheck);
    expect(transaction).toBeGreaterThan(timeout);
  });
});
