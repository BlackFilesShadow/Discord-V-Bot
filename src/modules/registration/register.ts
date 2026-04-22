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

  // SELBSTHEILUNG fuer asymmetrische Zustaende:
  // Wenn nur EINE der beiden Hersteller-Flaggen gesetzt ist (z.B. weil das
  // Dashboard fruehe nur isManufacturer toggled hat, oder ein alter Code-Pfad
  // role MANUFACTURER ohne isManufacturer setzte), gilt der User als NICHT
  // verifizierter Hersteller. Wir raeumen den halben Zustand still auf,
  // damit /register manufacturer wieder funktioniert.
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

  // MASTER-Wahrheit: User-Flag. Nur wer wirklich isManufacturer=true UND
  // role=MANUFACTURER ist, gilt als verifizierter Hersteller. Alles andere
  // (alte APPROVED-Requests, abgelaufene OTPs, halbfertige Zustaende) wird
  // beim erneuten /register manufacturer als "frischer Start" behandelt.
  if (user.isManufacturer && user.role === 'MANUFACTURER') {
    // Diagnose-freundliche Antwort: User und Dev sehen sofort die
    // benoetigten Identifier, um den Status ggf. zurueckzusetzen.
    return {
      success: false,
      message:
        'Du bist bereits als Hersteller registriert.\n' +
        `\u2022 Discord-ID: \`${discordId}\`\n` +
        `\u2022 GUID: \`${user.id}\`\n\n` +
        'Wenn das ein Fehler ist, bitte einen Developer um Reset via `/dev-manufacturer remove`.',
    };
  }

  // Pr\u00fcfe ob bereits eine Anfrage existiert
  const existing = await prisma.manufacturerRequest.findUnique({
    where: { userId: user.id },
  });

  if (existing) {
    if (existing.status === 'PENDING') {
      return { success: false, message: 'Du hast bereits eine offene Anfrage.' };
    }
    // APPROVED-Sonderfall: Pruefe, ob noch ein gueltiger, ungenutzter OTP existiert.
    // Wenn ja: NICHT zuruecksetzen \u2013 sonst wuerden wir den per DM verschickten OTP
    // widerrufen. Stattdessen den User darauf hinweisen, dass er nur noch verifizieren muss.
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
          message:
            'Deine Anfrage wurde bereits angenommen. Du hast einen gueltigen OTP per DM erhalten \u2013 verifiziere ihn mit `/register verify <passwort>`.',
        };
      }
    }
    // APPROVED ohne gueltigen OTP, oder DENIED: User ist (laut User-Flag oben) KEIN
    // Hersteller mehr, also war das eine alte/verwaiste Anfrage. Wir setzen sie auf
    // PENDING zurueck und widerrufen vorsorglich alle alten OTPs.
    await prisma.manufacturerRequest.update({
      where: { userId: user.id },
      data: {
        status: 'PENDING',
        reason,
        adminNote: null,
        reviewedBy: null,
        reviewedAt: null,
      },
    });
    await prisma.oneTimePassword.updateMany({
      where: { userId: user.id, isUsed: false, isRevoked: false },
      data: { isRevoked: true },
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

  // Alte ungenutzte OTPs sofort widerrufen (verhindert Mehrdeutigkeit)
  await prisma.oneTimePassword.updateMany({
    where: { userId: user.id, isUsed: false, isRevoked: false },
    data: { isRevoked: true },
  });

  // Einmal-Passwort speichern
  await prisma.oneTimePassword.create({
    data: {
      userId: user.id,
      passwordHash: otpHash,
      expiresAt,
    },
  });

  // WICHTIG: Hersteller-Rolle/-Flag werden hier NICHT gesetzt.
  // Sie werden erst nach erfolgreicher OTP-Verifizierung in
  // verifyOneTimePassword() aktiviert. So gilt der User offiziell
  // erst als Hersteller, wenn er auch wirklich verifiziert hat.

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
    // User-Status mit pruefen, damit wir aussagekraeftige Meldungen liefern
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const anyOtp = await prisma.oneTimePassword.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    let reason = 'Kein g\u00fcltiges Einmal-Passwort gefunden.';
    if (user?.isManufacturer && user.role === 'MANUFACTURER') {
      // Bereits vollstaendig verifiziert \u2013 kein neuer OTP n\u00f6tig.
      reason = 'Du bist bereits als Hersteller verifiziert. Du brauchst keinen weiteren OTP. Falls du Probleme hast, wende dich an einen Admin.';
    } else if (anyOtp) {
      const fmt = (d: Date) => d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
      if (anyOtp.isUsed && anyOtp.usedAt) {
        reason = `Dein letzter OTP (erstellt ${fmt(anyOtp.createdAt)}) wurde bereits am ${fmt(anyOtp.usedAt)} verwendet. Frage einen Admin nach einem neuen.`;
      } else if (anyOtp.isRevoked) {
        reason = 'Dein Einmal-Passwort wurde widerrufen. Frage einen Admin nach einem neuen.';
      } else if (anyOtp.expiresAt <= new Date()) {
        reason = `Dein Einmal-Passwort ist am ${fmt(anyOtp.expiresAt)} abgelaufen (30 Min G\u00fcltigkeit). Frage einen Admin nach einem neuen.`;
      }
    } else {
      reason = 'Du hast noch kein Einmal-Passwort. Beantrage zuerst Hersteller-Status mit `/register manufacturer`.';
    }
    logSecurity('OTP_VERIFY_FAILED', 'MEDIUM', {
      userId,
      reason,
    });
    return { success: false, message: reason };
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
    return { success: false, message: 'Ungültiges Passwort. Prüfe Groß-/Kleinschreibung und kopiere den OTP exakt aus der DM (ohne Leerzeichen).' };
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

  // Uploadrechte aktivieren (defensiv: isManufacturer + role + status setzen)
  // Hersteller-Status jetzt aktivieren (vorher nur Anfrage APPROVED + OTP).
  // Wir holen reviewedBy aus der ManufacturerRequest, damit
  // manufacturerApprovedBy korrekt den Admin enth\u00e4lt.
  const req = await prisma.manufacturerRequest.findUnique({ where: { userId } });
  await prisma.user.update({
    where: { id: userId },
    data: {
      status: 'ACTIVE',
      isManufacturer: true,
      role: 'MANUFACTURER',
      manufacturerApprovedAt: new Date(),
      manufacturerApprovedBy: req?.reviewedBy ?? null,
    },
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
