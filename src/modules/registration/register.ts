import prisma from '../../database/prisma';
import { generateOneTimePassword, hashPassword } from '../../utils/password';
import { logger, logAudit, logSecurity } from '../../utils/logger';
import fs from 'fs/promises';

/**
 * Hersteller-Registrierung.
 *
 * Invarianten:
 * - Hersteller ist nur `isManufacturer=true` UND role=MANUFACTURER.
 * - Approve/Deny sind atomare CAS-Entscheidungen auf PENDING.
 * - APPROVED + neuer OTP wird in EINER DB-Transaktion geschrieben.
 * - OTP-Verbrauch + Hersteller-Aktivierung + Fresh-Start-DB-Cleanup werden in
 *   EINER DB-Transaktion committed. Ein Fehler verbraucht den OTP nicht.
 * - Alte Paketdateien werden erst NACH erfolgreichem DB-Commit best-effort
 *   entfernt; die DB zeigt dadurch nie auf bewusst vorher geloeschte Dateien.
 */

export async function createManufacturerRequest(discordId: string, username: string, reason?: string) {
  const user = await prisma.user.upsert({
    where: { discordId },
    create: { discordId, username },
    update: { username },
  });

  if (user.isManufacturer !== (user.role === 'MANUFACTURER')) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isManufacturer: false,
        role: user.role === 'MANUFACTURER' ? 'USER' : user.role,
        manufacturerApprovedAt: null,
        manufacturerApprovedBy: null,
      },
    });
    user.isManufacturer = false;
    if (user.role === 'MANUFACTURER') user.role = 'USER';
    logAudit('MANUFACTURER_STATE_REPAIRED', 'REGISTRATION', {
      userId: user.id,
      discordId,
      reason: 'Asymmetrischer Zustand isManufacturer != role==MANUFACTURER',
    });
  }

  if (user.isManufacturer && user.role === 'MANUFACTURER') {
    return {
      success: false,
      message:
        'Du bist bereits als Hersteller registriert.\n' +
        `• Discord-ID: \`${discordId}\`\n` +
        `• GUID: \`${user.id}\`\n\n` +
        'Wenn das ein Fehler ist, bitte einen Developer um Reset via `/dev-manufacturer remove`.',
    };
  }

  const existing = await prisma.manufacturerRequest.findUnique({
    where: { userId: user.id },
  });

  if (existing) {
    if (existing.status === 'PENDING') {
      return { success: false, message: 'Du hast bereits eine offene Anfrage.' };
    }
    if (existing.status === 'APPROVED') {
      const validOtp = await prisma.oneTimePassword.findFirst({
        where: {
          userId: user.id,
          isUsed: false,
          isRevoked: false,
          expiresAt: { gt: new Date() },
        },
      });
      if (validOtp) {
        return {
          success: false,
          message: 'Deine Anfrage wurde bereits angenommen. Du hast einen gueltigen OTP per DM erhalten – verifiziere ihn mit `/register verify`.',
        };
      }
    }

    await prisma.$transaction(async tx => {
      await tx.manufacturerRequest.update({
        where: { userId: user.id },
        data: {
          status: 'PENDING',
          reason,
          adminNote: null,
          reviewedBy: null,
          reviewedAt: null,
        },
      });
      await tx.oneTimePassword.updateMany({
        where: { userId: user.id, isUsed: false, isRevoked: false },
        data: { isRevoked: true },
      });
    });
  } else {
    await prisma.manufacturerRequest.create({ data: { userId: user.id, reason } });
  }

  logAudit('MANUFACTURER_REQUEST_CREATED', 'REGISTRATION', {
    userId: user.id,
    discordId,
    reason,
  });
  return { success: true, userId: user.id, message: 'Anfrage erfolgreich gesendet. Ein Admin wird dich kontaktieren.' };
}

export async function approveManufacturer(discordId: string, adminDiscordId: string) {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return { success: false, message: 'User nicht in der Datenbank gefunden.' };

  const request = await prisma.manufacturerRequest.findUnique({
    where: { userId: user.id },
    include: { user: true },
  });
  if (!request) return { success: false, message: 'Anfrage nicht gefunden.' };
  if (request.status !== 'PENDING') {
    return { success: false, message: `Anfrage bereits ${request.status === 'APPROVED' ? 'angenommen' : 'abgelehnt'}.` };
  }

  const otp = generateOneTimePassword(48);
  const otpHash = await hashPassword(otp);
  const reviewedAt = new Date();
  const expiresAt = new Date(reviewedAt.getTime() + 30 * 60 * 1000);

  const claimed = await prisma.$transaction(async tx => {
    const cas = await tx.manufacturerRequest.updateMany({
      where: { userId: user.id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        reviewedBy: adminDiscordId,
        reviewedAt,
      },
    });
    if (cas.count !== 1) return false;

    await tx.oneTimePassword.updateMany({
      where: { userId: user.id, isUsed: false, isRevoked: false },
      data: { isRevoked: true },
    });
    await tx.oneTimePassword.create({
      data: { userId: user.id, passwordHash: otpHash, expiresAt },
    });
    return true;
  });

  if (!claimed) {
    return { success: false, message: 'Anfrage wurde bereits von einer anderen Aktion bearbeitet.' };
  }

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

export async function denyManufacturer(discordId: string, adminDiscordId: string, adminNote?: string) {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return { success: false, message: 'User nicht in der Datenbank gefunden.' };

  const request = await prisma.manufacturerRequest.findUnique({ where: { userId: user.id } });
  if (!request) return { success: false, message: 'Anfrage nicht gefunden.' };

  const decidedAt = new Date();
  const denied = await prisma.manufacturerRequest.updateMany({
    where: { userId: user.id, status: 'PENDING' },
    data: {
      status: 'DENIED',
      adminNote,
      reviewedBy: adminDiscordId,
      reviewedAt: decidedAt,
    },
  });
  if (denied.count !== 1) {
    return { success: false, message: 'Anfrage ist nicht mehr offen oder wurde bereits bearbeitet.' };
  }

  logAudit('MANUFACTURER_DENIED', 'REGISTRATION', {
    userId: user.id,
    deniedBy: adminDiscordId,
    adminNote,
  });
  return { success: true, message: 'Hersteller-Anfrage abgelehnt.' };
}

export async function verifyOneTimePassword(userId: string, password: string) {
  const now = new Date();
  const otps = await prisma.oneTimePassword.findMany({
    where: {
      userId,
      isUsed: false,
      isRevoked: false,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (otps.length === 0) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const anyOtp = await prisma.oneTimePassword.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    let reason = 'Kein gueltiges Einmal-Passwort gefunden.';
    if (user?.isManufacturer && user.role === 'MANUFACTURER') {
      reason = 'Du bist bereits als Hersteller verifiziert. Du brauchst keinen weiteren OTP.';
    } else if (anyOtp) {
      const fmt = (d: Date) => d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
      if (anyOtp.isUsed && anyOtp.usedAt) {
        reason = `Dein letzter OTP (erstellt ${fmt(anyOtp.createdAt)}) wurde bereits am ${fmt(anyOtp.usedAt)} verwendet. Frage einen Admin nach einem neuen.`;
      } else if (anyOtp.isRevoked) {
        reason = 'Dein Einmal-Passwort wurde widerrufen. Frage einen Admin nach einem neuen.';
      } else if (anyOtp.expiresAt <= now) {
        reason = `Dein Einmal-Passwort ist am ${fmt(anyOtp.expiresAt)} abgelaufen (30 Min Gueltigkeit). Frage einen Admin nach einem neuen.`;
      }
    } else {
      reason = 'Du hast noch kein Einmal-Passwort. Beantrage zuerst Hersteller-Status mit `/register manufacturer`.';
    }
    logSecurity('OTP_VERIFY_FAILED', 'MEDIUM', { userId, reason });
    return { success: false, message: reason };
  }

  const { verifyPassword } = await import('../../utils/password.js');
  let matchedOtp: (typeof otps)[number] | null = null;
  for (const otp of otps) {
    if (await verifyPassword(otp.passwordHash, password)) {
      matchedOtp = otp;
      break;
    }
  }

  if (!matchedOtp) {
    logSecurity('OTP_VERIFY_FAILED', 'HIGH', { userId, reason: 'Falsches Passwort' });
    return { success: false, message: 'Ungueltiges Passwort. Pruefe Gross-/Kleinschreibung und kopiere den OTP exakt aus der DM.' };
  }

  const activationTime = new Date();
  const activation = await prisma.$transaction(async tx => {
    // CAS verhindert, dass zwei parallele Verifizierungen denselben OTP nutzen.
    const claim = await tx.oneTimePassword.updateMany({
      where: {
        id: matchedOtp!.id,
        userId,
        isUsed: false,
        isRevoked: false,
        expiresAt: { gt: activationTime },
      },
      data: { isUsed: true, usedAt: activationTime },
    });
    if (claim.count !== 1) return { activated: false as const, filePaths: [] as string[], packagesPurged: 0, wasManufacturer: false };

    const req = await tx.manufacturerRequest.findUnique({ where: { userId } });
    if (!req || req.status !== 'APPROVED') {
      throw new Error('Hersteller-Anfrage ist nicht mehr APPROVED; OTP-Aktivierung abgebrochen.');
    }

    const userBefore = await tx.user.findUnique({
      where: { id: userId },
      select: { isManufacturer: true, role: true },
    });
    if (!userBefore) throw new Error('User fuer Hersteller-Aktivierung nicht gefunden.');

    let filePaths: string[] = [];
    let packagesPurged = 0;
    if (!userBefore.isManufacturer) {
      const oldPackages = await tx.package.findMany({
        where: { userId },
        include: { files: { select: { filePath: true } } },
      });
      filePaths = oldPackages.flatMap(pkg => pkg.files.map(file => file.filePath));
      if (oldPackages.length > 0) {
        const deleted = await tx.package.deleteMany({ where: { userId } });
        packagesPurged = deleted.count;
      }
    }

    await tx.oneTimePassword.updateMany({
      where: { userId, id: { not: matchedOtp!.id }, isUsed: false, isRevoked: false },
      data: { isRevoked: true },
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        status: 'ACTIVE',
        isManufacturer: true,
        role: 'MANUFACTURER',
        manufacturerApprovedAt: activationTime,
        manufacturerApprovedBy: req.reviewedBy ?? null,
      },
    });

    return {
      activated: true as const,
      filePaths,
      packagesPurged,
      wasManufacturer: userBefore.isManufacturer,
    };
  });

  if (!activation.activated) {
    return { success: false, message: 'Dieser OTP wurde bereits verwendet oder ist inzwischen abgelaufen. Bitte fordere einen neuen an.' };
  }

  // Dateisystem erst nach erfolgreichem DB-Commit bereinigen. Fehler erzeugen
  // hoechstens unreferenzierte Altdateien, niemals kaputte DB-Referenzen.
  for (const filePath of activation.filePaths) {
    try { await fs.unlink(filePath); } catch { /* bereits weg / best effort */ }
  }

  if (activation.packagesPurged > 0) {
    logAudit('FRESH_MANUFACTURER_CLEANUP', 'REGISTRATION', {
      userId,
      packagesPurged: activation.packagesPurged,
    });
  } else if (activation.wasManufacturer) {
    logAudit('FRESH_MANUFACTURER_CLEANUP_SKIPPED', 'REGISTRATION', {
      userId,
      reason: 'User war bereits Hersteller; Cleanup uebersprungen',
    });
  }

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
