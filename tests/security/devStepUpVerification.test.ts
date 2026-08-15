const twoFactorFindUnique = jest.fn();
const decryptMock = jest.fn();
const verifyTotpMock = jest.fn();
const logAuditMock = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    twoFactorAuth: { findUnique: (...args: unknown[]) => twoFactorFindUnique(...args) },
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '11'.repeat(32) } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: (...args: unknown[]) => decryptMock(...args),
  verify2FAToken: (...args: unknown[]) => verifyTotpMock(...args),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

import type { Request } from 'express';
import { verifyDevStepUp } from '../../src/dashboard/middleware/devStepUp';

function req(): Request {
  return {
    auth: { userId: 'db-user-1', discordId: '123456789012345678', role: 'DEVELOPER' },
    ip: '127.0.0.1',
  } as unknown as Request;
}

beforeEach(() => {
  twoFactorFindUnique.mockReset();
  decryptMock.mockReset();
  verifyTotpMock.mockReset();
  logAuditMock.mockReset();
  delete process.env.DEV_PASSWORD;
});

describe('verifyDevStepUp', () => {
  it('verifiziert DEV_PASSWORD kryptografisch wenn 2FA nicht aktiv ist', async () => {
    twoFactorFindUnique.mockResolvedValue(null);
    process.env.DEV_PASSWORD = 'correct-horse-battery-staple';
    await expect(verifyDevStepUp(req(), { reason: 'Adminrolle ändern', reAuth: 'correct-horse-battery-staple' }))
      .resolves.toEqual({ ok: true, mode: 'password' });
  });

  it('weist ein falsches DEV_PASSWORD zurueck', async () => {
    twoFactorFindUnique.mockResolvedValue({ isEnabled: false, secretEnc: null });
    process.env.DEV_PASSWORD = 'correct-horse-battery-staple';
    const result = await verifyDevStepUp(req(), { reason: 'Adminrolle ändern', reAuth: 'definitely-wrong' });
    expect(result).toEqual({ ok: false, error: 'reauth_invalid' });
  });

  it('nutzt bei aktiver 2FA ausschliesslich das entschluesselte TOTP-Secret', async () => {
    twoFactorFindUnique.mockResolvedValue({ isEnabled: true, secretEnc: 'ciphertext' });
    decryptMock.mockReturnValue('BASE32SECRET');
    verifyTotpMock.mockReturnValue(true);
    process.env.DEV_PASSWORD = 'password-must-not-bypass-totp';

    const result = await verifyDevStepUp(req(), { reason: 'Security Änderung', reAuth: '123456' });
    expect(result).toEqual({ ok: true, mode: 'totp' });
    expect(decryptMock).toHaveBeenCalledWith('ciphertext', '11'.repeat(32));
    expect(verifyTotpMock).toHaveBeenCalledWith('BASE32SECRET', '123456');
  });

  it('erlaubt DEV_PASSWORD nicht als Fallback wenn 2FA aktiv aber TOTP falsch ist', async () => {
    twoFactorFindUnique.mockResolvedValue({ isEnabled: true, secretEnc: 'ciphertext' });
    decryptMock.mockReturnValue('BASE32SECRET');
    verifyTotpMock.mockReturnValue(false);
    process.env.DEV_PASSWORD = 'password-must-not-bypass-totp';

    const result = await verifyDevStepUp(req(), { reason: 'Security Änderung', reAuth: 'password-must-not-bypass-totp' });
    expect(result).toEqual({ ok: false, error: 'reauth_invalid' });
  });

  it('fail-closed wenn weder 2FA noch DEV_PASSWORD verfuegbar ist', async () => {
    twoFactorFindUnique.mockResolvedValue(null);
    const result = await verifyDevStepUp(req(), { reason: 'Konfiguration ändern', reAuth: '123456' });
    expect(result).toEqual({ ok: false, error: 'no_credential' });
  });

  it('loggt niemals das Re-Auth-Geheimnis', async () => {
    twoFactorFindUnique.mockResolvedValue(null);
    process.env.DEV_PASSWORD = 'super-secret-step-up';
    await verifyDevStepUp(req(), { reason: 'Command Registry neu laden', reAuth: 'super-secret-step-up' });
    const serializedCalls = JSON.stringify(logAuditMock.mock.calls);
    expect(serializedCalls).not.toContain('super-secret-step-up');
    expect(serializedCalls).toContain('DEV_STEP_UP_OK');
  });
});
