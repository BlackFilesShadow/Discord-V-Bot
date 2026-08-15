import { Router } from 'express';
import { requireBotAdmin } from '../../middleware/auth';
import { logAudit, logger } from '../../../utils/logger';
import { safeValidateUpload, SafeUploadValidationError } from '../../../modules/dashboard/safeUploadValidation';

/**
 * Sicherheits-Override fuer den von der bestehenden Bot-Admin-Oberflaeche
 * verwendeten `POST /validate`-Pfad. Der alte Handler validierte den in der DB
 * gespeicherten Pfad direkt. Dieser Router stellt vor dem Legacy-Router dieselben
 * Schutzschranken wie der migrierte Command-Center-Pfad sicher.
 */
export const botAdminSafeValidationRouter = Router();
botAdminSafeValidationRouter.use(requireBotAdmin);

botAdminSafeValidationRouter.post('/validate', async (req, res) => {
  const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';
  if (!uploadId) {
    res.status(400).json({ error: 'uploadId fehlt.' });
    return;
  }

  try {
    const result = await safeValidateUpload(
      uploadId,
      String(req.auth?.discordId ?? req.auth?.userId ?? 'bot-admin'),
    );
    logAudit('BOTADMIN_VALIDATE', 'UPLOAD', {
      uploadId: result.id,
      isValid: result.isValid,
      adminId: req.auth?.discordId ?? req.auth?.userId ?? null,
    });
    res.json({
      uploadId: result.id,
      report: {
        isValid: result.isValid,
        errors: result.errors,
        warnings: result.warnings,
        suggestions: result.suggestions,
      },
    });
  } catch (error) {
    const status = error instanceof SafeUploadValidationError ? error.status : 500;
    logger.error('BotAdmin sichere Upload-Validierung fehlgeschlagen', {
      uploadId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(status).json({
      error: error instanceof SafeUploadValidationError
        ? error.message
        : 'Validierung fehlgeschlagen.',
    });
  }
});
