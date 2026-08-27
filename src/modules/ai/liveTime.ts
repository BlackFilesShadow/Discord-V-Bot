const BERLIN_TIME_ZONE = 'Europe/Berlin';

export interface BerlinLiveTimeSnapshot {
  now: Date;
  year: number;
  monthNumber: number;
  monthName: string;
  dayOfMonth: number;
  weekday: string;
  dateLong: string;
  timeShort: string;
  daypart: 'Nacht' | 'Morgen' | 'Mittag' | 'Nachmittag' | 'Abend';
  season: 'Winter' | 'Frühling' | 'Sommer' | 'Herbst';
}

function calendarParts(now: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: BERLIN_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now).map(part => [part.type, part.value]),
  );
}

export function getBerlinLiveTimeSnapshot(now: Date = new Date()): BerlinLiveTimeSnapshot {
  const parts = calendarParts(now);
  const year = Number(parts.year);
  const monthNumber = Number(parts.month);
  const dayOfMonth = Number(parts.day);
  const hour = Number(parts.hour) % 24;

  let daypart: BerlinLiveTimeSnapshot['daypart'] = 'Nacht';
  if (hour >= 5 && hour < 11) daypart = 'Morgen';
  else if (hour >= 11 && hour < 14) daypart = 'Mittag';
  else if (hour >= 14 && hour < 18) daypart = 'Nachmittag';
  else if (hour >= 18 && hour < 22) daypart = 'Abend';

  let season: BerlinLiveTimeSnapshot['season'] = 'Winter';
  if (monthNumber >= 3 && monthNumber <= 5) season = 'Frühling';
  else if (monthNumber >= 6 && monthNumber <= 8) season = 'Sommer';
  else if (monthNumber >= 9 && monthNumber <= 11) season = 'Herbst';

  return {
    now,
    year,
    monthNumber,
    monthName: new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: BERLIN_TIME_ZONE }).format(now),
    dayOfMonth,
    weekday: new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: BERLIN_TIME_ZONE }).format(now),
    dateLong: new Intl.DateTimeFormat('de-DE', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: BERLIN_TIME_ZONE,
    }).format(now),
    timeShort: new Intl.DateTimeFormat('de-DE', {
      hour: '2-digit', minute: '2-digit', timeZone: BERLIN_TIME_ZONE,
    }).format(now),
    daypart,
    season,
  };
}

function normalizeQuestion(value: string): string {
  return String(value || '')
    .toLocaleLowerCase('de-DE')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[?!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Provider-unabhaengiger Fast-Path fuer Fakten, die V-Bot selbst autoritativ
 * aus Europe/Berlin kennt. Diese Fragen duerfen niemals an einem externen
 * Provider, dessen Rate-Limit oder einer leeren Completion scheitern.
 */
export function answerLiveTimeQuestion(question: string, now: Date = new Date()): string | null {
  const q = normalizeQuestion(question);
  if (!q) return null;

  const wantsYear =
    /\b(?:welches|was fur(?: ein)?) jahr (?:haben wir|ist es)(?: heute| jetzt| aktuell)?\b/.test(q)
    || /\bin welchem jahr (?:sind|leben) wir\b/.test(q)
    || /\bwelche jahreszahl (?:haben wir|ist aktuell)\b/.test(q);
  const wantsDate =
    /\bwelches datum(?: haben wir| ist heute| ist es heute)?\b/.test(q)
    || /\bwas fur(?: ein)? datum (?:haben wir|ist heute)\b/.test(q)
    || /\bwas ist (?:heute )?das datum\b/.test(q);
  const wantsWeekday =
    /\bwelcher wochentag(?: ist heute| haben wir heute| haben wir)?\b/.test(q)
    || /\bwas fur(?: ein)? wochentag (?:ist heute|haben wir heute)\b/.test(q)
    || /\bwas fur(?: ein)? tag (?:ist|haben wir) heute\b/.test(q);
  const wantsTime =
    /\bwie spat ist es\b/.test(q)
    || /\bwie ?viel uhr ist es\b/.test(q)
    || /\bwelche uhrzeit (?:ist es|haben wir|ist aktuell)\b/.test(q);
  const wantsMonth =
    /\bwelchen monat (?:haben wir|ist es)\b/.test(q)
    || /\bwelcher monat (?:ist heute|ist gerade|ist aktuell)\b/.test(q);
  const wantsSeason =
    /\bwelche jahreszeit (?:haben wir|ist gerade|ist aktuell|ist es)\b/.test(q)
    || /\bwas fur(?: eine)? jahreszeit (?:haben wir|ist gerade|ist es)\b/.test(q);
  const wantsDaypart =
    /\bwelche tageszeit (?:ist|haben wir)\b/.test(q)
    || /\bist es (?:gerade|jetzt) (?:morgen|mittag|nachmittag|abend|nacht)\b/.test(q);

  if (!wantsYear && !wantsDate && !wantsWeekday && !wantsTime && !wantsMonth && !wantsSeason && !wantsDaypart) {
    return null;
  }

  const snapshot = getBerlinLiveTimeSnapshot(now);
  const requestedCount = [wantsYear, wantsDate, wantsWeekday, wantsTime, wantsMonth, wantsSeason, wantsDaypart]
    .filter(Boolean).length;

  if (requestedCount === 1) {
    if (wantsYear) return `Wir haben **${snapshot.year}**.`;
    if (wantsDate) return `Heute ist der **${snapshot.dateLong}**.`;
    if (wantsWeekday) return `Heute ist **${snapshot.weekday}**.`;
    if (wantsTime) return `Es ist **${snapshot.timeShort} Uhr**.`;
    if (wantsMonth) return `Wir haben **${snapshot.monthName}**.`;
    if (wantsSeason) return `Aktuell ist **${snapshot.season}**.`;
    if (wantsDaypart) return `Aktuell ist **${snapshot.daypart}**.`;
  }

  const parts: string[] = [];
  if (wantsWeekday) parts.push(snapshot.weekday);
  if (wantsDate) parts.push(snapshot.dateLong);
  else {
    if (wantsMonth) parts.push(snapshot.monthName);
    if (wantsYear) parts.push(String(snapshot.year));
  }
  if (wantsTime) parts.push(`${snapshot.timeShort} Uhr`);
  if (wantsDaypart) parts.push(snapshot.daypart);
  if (wantsSeason) parts.push(snapshot.season);
  return `Aktuell: **${parts.join(' · ')}**.`;
}

export function buildLiveTimeContext(now: Date = new Date()): string {
  const snapshot = getBerlinLiveTimeSnapshot(now);
  const full = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: BERLIN_TIME_ZONE,
  }).format(now);

  return [
    'AUTORITATIVE ZEIT- UND DATUMSANGABEN (Europe/Berlin) - diese Werte sind FAKT, nutze sie direkt:',
    `- Vollständig: ${full}`,
    `- Heutiges Datum: ${snapshot.weekday}, ${snapshot.dateLong}`,
    `- Wochentag: ${snapshot.weekday}`,
    `- Aktuelle Uhrzeit: ${snapshot.timeShort} Uhr`,
    `- Tageszeit: ${snapshot.daypart}`,
    `- Jahreszeit: ${snapshot.season}`,
    `- Jahr: ${snapshot.year}`,
    '',
    'REGELN fuer Zeit-/Datumsfragen:',
    '- Fragt der Nutzer nach Datum, Wochentag, Uhrzeit, Tageszeit, Jahr oder Jahreszeit: antworte DIREKT und SICHER mit obigen Werten. NIEMALS "weiss ich nicht" oder "nicht tagesaktuell" sagen.',
    `- NIEMALS Tageszeit halluzinieren (z.B. nicht "Nacht" sagen, wenn oben "${snapshot.daypart}" steht).`,
    '- Gib JEDEN Wert (Wochentag, Datum, Uhrzeit, Monat, Jahr) HOECHSTENS EINMAL pro Antwort aus. Kein Teil darf doppelt vorkommen.',
    `- Vorzugsformat fuer kombinierte Fragen ("Tag/Datum/Uhrzeit/Jahr/Monat"): EIN Satz - z.B. "Heute ist ${snapshot.weekday}, ${snapshot.dateLong}, ${snapshot.timeShort} Uhr." Punkt.`,
    '- Wenn Datum bereits den Monat und das Jahr enthaelt, sind Monat und Jahr damit beantwortet - NICHT noch einmal extra anfuegen.',
    '- Vermeide Doppelungen wie "Frühlingsabend, es ist Abend".',
  ].join('\n');
}
