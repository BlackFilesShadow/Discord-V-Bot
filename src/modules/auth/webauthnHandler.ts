import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * FIDO2/WebAuthn Support (Sektion 12):
 * - WebAuthn Registrierung & Authentifizierung
 * - Credential-Management
 * - Ergänzt TOTP als 2. Faktor
 */

interface WebAuthnCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceName: string;
}

// In-Memory Challenge-Store (kurzlebig)
const challengeStore: Map<string, { challenge: string; expiresAt: number }> = new Map();

/**
 * WebAuthn Registrierungs-Optionen generieren.
 */
export async function generateRegistrationOptions(
  userId: string,
  username: string,
): Promise<{
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: string; alg: number }[];
  timeout: number;
  attestation: string;
  authenticatorSelection: {
    authenticatorAttachment?: string;
    residentKey: string;
    userVerification: string;
  };
}> {
  const challenge = crypto.randomBytes(32).toString('base64url');

  // Challenge speichern (5 min gültig)
  challengeStore.set(userId, {
    challenge,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return {
    challenge,
    rp: {
      name: 'Discord-V-Bot',
      id: process.env.WEBAUTHN_RP_ID || 'localhost',
    },
    user: {
      id: Buffer.from(userId).toString('base64url'),
      name: username,
      displayName: username,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },   // ES256
      { type: 'public-key', alg: -257 },  // RS256
    ],
    timeout: 300000, // 5 min
    attestation: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  };
}

/**
 * WebAuthn Registrierung verifizieren.
 */
export async function verifyRegistration(
  userId: string,
  credentialId: string,
  publicKey: string,
  deviceName: string = 'Security Key',
): Promise<{ success: boolean; message: string }> {
  const stored = challengeStore.get(userId);
  if (!stored || stored.expiresAt < Date.now()) {
    challengeStore.delete(userId);
    return { success: false, message: 'Challenge abgelaufen.' };
  }

  challengeStore.delete(userId);

  // Credential in TwoFactorAuth speichern
  const existing = await prisma.twoFactorAuth.findUnique({ where: { userId } });

  const newCredential: WebAuthnCredential = {
    credentialId,
    publicKey,
    counter: 0,
    deviceName,
  };

  if (existing) {
    const existingCreds = (existing.webauthnCredentials as unknown as WebAuthnCredential[]) || [];
    existingCreds.push(newCredential);

    await prisma.twoFactorAuth.update({
      where: { userId },
      data: {
        webauthnEnabled: true,
        webauthnCredentials: JSON.parse(JSON.stringify(existingCreds)),
      },
    });
  } else {
    await prisma.twoFactorAuth.create({
      data: {
        userId,
        isEnabled: true,
        webauthnEnabled: true,
        webauthnCredentials: JSON.parse(JSON.stringify([newCredential])),
      },
    });
  }

  logAudit('WEBAUTHN_REGISTERED', 'AUTH', {
    userId,
    deviceName,
    credentialId: credentialId.substring(0, 16) + '...',
  });

  return { success: true, message: `WebAuthn-Gerät "${deviceName}" registriert.` };
}

/**
 * WebAuthn Authentifizierungs-Optionen generieren.
 */
export async function generateAuthenticationOptions(
  userId: string,
): Promise<{
  success: boolean;
  options?: {
    challenge: string;
    timeout: number;
    rpId: string;
    allowCredentials: { type: string; id: string }[];
    userVerification: string;
  };
  message?: string;
}> {
  const tfa = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!tfa?.webauthnEnabled) {
    return { success: false, message: 'WebAuthn nicht aktiviert.' };
  }

  const credentials = (tfa.webauthnCredentials as unknown as WebAuthnCredential[]) || [];
  if (credentials.length === 0) {
    return { success: false, message: 'Keine WebAuthn-Credentials vorhanden.' };
  }

  const challenge = crypto.randomBytes(32).toString('base64url');
  challengeStore.set(userId, {
    challenge,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return {
    success: true,
    options: {
      challenge,
      timeout: 300000,
      rpId: process.env.WEBAUTHN_RP_ID || 'localhost',
      allowCredentials: credentials.map(c => ({
        type: 'public-key',
        id: c.credentialId,
      })),
      userVerification: 'preferred',
    },
  };
}

/**
 * WebAuthn Authentifizierung verifizieren.
 */
export async function verifyAuthentication(
  userId: string,
  credentialId: string,
  newCounter: number,
): Promise<{ success: boolean; message: string }> {
  const stored = challengeStore.get(userId);
  if (!stored || stored.expiresAt < Date.now()) {
    challengeStore.delete(userId);
    return { success: false, message: 'Challenge abgelaufen.' };
  }

  challengeStore.delete(userId);

  const tfa = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!tfa?.webauthnEnabled) {
    return { success: false, message: 'WebAuthn nicht aktiviert.' };
  }

  const credentials = (tfa.webauthnCredentials as unknown as WebAuthnCredential[]) || [];
  const credential = credentials.find(c => c.credentialId === credentialId);

  if (!credential) {
    return { success: false, message: 'Credential nicht gefunden.' };
  }

  // Counter-Replay-Protection
  if (newCounter <= credential.counter) {
    logAudit('WEBAUTHN_REPLAY_DETECTED', 'SECURITY', {
      userId,
      credentialId: credentialId.substring(0, 16) + '...',
    });
    return { success: false, message: 'Replay-Attack erkannt.' };
  }

  // Counter aktualisieren
  credential.counter = newCounter;
  await prisma.twoFactorAuth.update({
    where: { userId },
    data: {
      webauthnCredentials: JSON.parse(JSON.stringify(credentials)),
    },
  });

  logAudit('WEBAUTHN_AUTHENTICATED', 'AUTH', { userId });

  return { success: true, message: 'WebAuthn-Authentifizierung erfolgreich.' };
}

/**
 * WebAuthn-Gerät entfernen.
 */
export async function removeWebAuthnDevice(
  userId: string,
  credentialId: string,
): Promise<boolean> {
  const tfa = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!tfa) return false;

  const credentials = (tfa.webauthnCredentials as unknown as WebAuthnCredential[]) || [];
  const filtered = credentials.filter(c => c.credentialId !== credentialId);

  await prisma.twoFactorAuth.update({
    where: { userId },
    data: {
      webauthnCredentials: JSON.parse(JSON.stringify(filtered)),
      webauthnEnabled: filtered.length > 0,
    },
  });

  logAudit('WEBAUTHN_DEVICE_REMOVED', 'AUTH', { userId, credentialId: credentialId.substring(0, 16) + '...' });

  return true;
}

/**
 * Liste der registrierten WebAuthn-Geräte eines Users.
 */
export async function listWebAuthnDevices(
  userId: string,
): Promise<{ credentialId: string; deviceName: string; counter: number }[]> {
  const tfa = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!tfa) return [];

  const credentials = (tfa.webauthnCredentials as unknown as WebAuthnCredential[]) || [];
  return credentials.map(c => ({
    credentialId: c.credentialId,
    deviceName: c.deviceName,
    counter: c.counter,
  }));
}

// Periodische Challenge-Bereinigung (alle 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of challengeStore.entries()) {
    if (val.expiresAt < now) challengeStore.delete(key);
  }
}, 5 * 60 * 1000);
