import prisma from '../../database/prisma';
import { generateOneTimePassword, hashPassword } from '../../utils/password';
import { logger, logAudit, logSecurity } from '../../utils/logger';

/**
 * Registrierungsmodul (Sektion 1):
 * - Registrierung als Hersteller per Command
 * - Anfrage an Admin per PN
 * - Admin kann annehmen/ablehnen, alles wird geloggt
 */

/**
 * Hersteller-Registrierungsanfrage erstellen.
 */
export async function createManufacturerRequest(discordId: string, username: string, reason?: string) {
  // User in DB sicherstellen
  const user = await prisma.user.upsert({
    where: { discordId },
    create: { discordId, username },
    update: { username },
  });

  // Prüfe ob bereits eine Anfrage existiert
  const existing = await prisma.manufacturerRequest.findUnique({
    where: { userId: user.id },
  });

  if (existing) {
    if (existing.status === 'PENDING') {
      return { success: false, message: 'Du hast bereits eine offene Anfrage.' };
    }
    if (existing.status === 'APPROVED') {
      return { success: false, message: 'Du bist bereits als Hersteller registriert.' };
    }
    // Bei DENIED: Neue Anfrage erlauben
    await prisma.manufacturerRequest.update({
      where: { userId: user.id },
      data: { status: 'PENDING', reason, adminNote: null, reviewedBy: null, reviewedAt: null },
    });
  } else {
    await prisma.manufacturerRequest.create({
      data: { userId: user.id, reason },
    });
  }

  logAudit('MANUFACTURER_REQUEST_CREATED', 'REGISTRATION', {
    userId: user.id,
    discordId,
    reason,
  });

  return { success: true, userId: user.id, message: 'Anfrage erfolgreich gesendet. Ein Admin wird dich kontaktieren.' };
}

/**
 * Hersteller-Anfrage annehmen (Admin).
 * Sektion 1: Bei Annahme: Einmal-Passwort, GUID-basierte Bereichserstellung.
 */
export async function approveManufacturer(discordId: string, adminDiscordId: string) {
  // Discord-ID → interne UUID auflösen
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) {
    return { success: false, message: 'User nicht in der Datenbank gefunden.' };
  }

  const request = await prisma.manufacturerRequest.findUnique({
    where: { userId: user.id },
    include: { user: true },
  });

  if (!request) {
    return { success: false, message: 'Anfrage nicht gefunden.' };
  }

  if (request.status !== 'PENDING') {
    return { success: false, message: `Anfrage bereits ${request.status === 'APPROVED' ? 'angenommen' : 'abgelehnt'}.` };
  }

  // Einmal-Passwort generieren (hochkomplex, zeitlich limitiert)
  const otp = generateOneTimePassword(48);
  const otpHash = await hashPassword(otp);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 Minuten

  // Anfrage aktualisieren
  await prisma.manufacturerRequest.update({
    where: { userId: user.id },
    data: {
      status: 'APPROVED',
      reviewedBy: adminDiscordId,
      reviewedAt: new Date(),
    },
  });

  // Einmal-Passwort speichern
  await prisma.oneTimePassword.create({
    data: {
      userId: user.id,
      passwordHash: otpHash,
      expiresAt,
    },
  });

  // User-Rolle auf MANUFACTURER setzen
  await prisma.user.update({
    where: { id: user.id },
    data: {
      isManufacturer: true,
      role: 'MANUFACTURER',
      manufacturerApprovedAt: new Date(),
      manufacturerApprovedBy: adminDiscordId,
    },
  });

  logAudit('MANUFACTURER_APPROVED', 'REGISTRATION', {
    userId: user.id,
    approvedBy: adminDiscordId,
    otpExpiresAt: expiresAt.toISOString(),
  });

  return {
    success: true,
    otp,
    expiresAt,
    user: request.user,
    message: 'Hersteller-Anfrage angenommen. Einmal-Passwort generiert.',
  };
}

/**
 * Hersteller-Anfrage ablehnen (Admin).
 */
export async function denyManufacturer(discordId: string, adminDiscordId: string, adminNote?: string) {
  // Discord-ID → interne UUID auflösen
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) {
    return { success: false, message: 'User nicht in der Datenbank gefunden.' };
  }

  const request = await prisma.manufacturerRequest.findUnique({
    where: { userId: user.id },
  });

  if (!request) {
    return { success: false, message: 'Anfrage nicht gefunden.' };
  }

  if (request.status !== 'PENDING') {
    return { success: false, message: 'Anfrage ist nicht mehr offen.' };
  }

  await prisma.manufacturerRequest.update({
    where: { userId: user.id },
    data: {
      status: 'DENIED',
      adminNote,
      reviewedBy: adminDiscordId,
      reviewedAt: new Date(),
    },
  });

  logAudit('MANUFACTURER_DENIED', 'REGISTRATION', {
    userId: user.id,
    deniedBy: adminDiscordId,
    adminNote,
  });

  return { success: true, message: 'Hersteller-Anfrage abgelehnt.' };
}

/**
 * Einmal-Passwort verifizieren und GUID-Bereich aktivieren.
 * Sektion 1: Passwort-Eingabe → automatische GUID-basierte Bereichserstellung.
 * Passwort sofort ungültig nach Nutzung.
 */
export async function verifyOneTimePassword(userId: string, password: string) {
  const otps = await prisma.oneTimePassword.findMany({
    where: {
      userId,
      isUsed: false,
      isRevoked: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (otps.length === 0) {
    logSecurity('OTP_VERIFY_FAILED', 'MEDIUM', {
      userId,
      reason: 'Kein gültiges OTP gefunden',
    });
    return { success: false, message: 'Kein gültiges Einmal-Passwort gefunden oder abgelaufen.' };
  }

  // Passwort gegen alle gültigen OTPs prüfen
  const { verifyPassword } = await import('../../utils/password.js');
  let matchedOtp = null;

  for (const otp of otps) {
    const isValid = await verifyPassword(otp.passwordHash, password);
    if (isValid) {
      matchedOtp = otp;
      break;
    }
  }

  if (!matchedOtp) {
    logSecurity('OTP_VERIFY_FAILED', 'HIGH', {
      userId,
      reason: 'Falsches Passwort',
    });
    return { success: false, message: 'Ungültiges Passwort.' };
  }

  // OTP als verwendet markieren (sofort ungültig)
  await prisma.oneTimePassword.update({
    where: { id: matchedOtp.id },
    data: { isUsed: true, usedAt: new Date() },
  });

  // Alle anderen OTPs für diesen User revoken
  await prisma.oneTimePassword.updateMany({
    where: { userId, id: { not: matchedOtp.id }, isUsed: false },
    data: { isRevoked: true },
  });

  // Uploadrechte aktivieren
  await prisma.user.update({
    where: { id: userId },
    data: { status: 'ACTIVE' },
  });

  logAudit('OTP_VERIFIED', 'REGISTRATION', {
    userId,
    message: 'GUID-Bereich aktiviert, Uploadrechte freigeschaltet',
  });

  return {
    success: true,
    userId,
    message: 'Passwort verifiziert! Dein GUID-Bereich ist jetzt aktiv. Du kannst Pakete hochladen.',
  };
}
