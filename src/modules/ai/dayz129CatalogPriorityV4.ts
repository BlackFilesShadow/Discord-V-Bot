import * as v3 from './dayz129CatalogPriorityV3';
import * as base from './dayz129CatalogBase';
import type { DayzCatalogAnswer } from './dayz129CatalogBase';

function fold(text: string): string {
  return text.toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function explicitLookupIntent(question: string): boolean {
  const q = fold(question);
  return /\b(classname|class name|typename|type name|itemname|item name)\b/.test(q)
    || (/\btypes?\.xml\b/.test(q) && /\b(wie|name|heisst)\b/.test(q));
}

function hasDetailIntent(question: string): boolean {
  return /\b(?:werte?|stats?|schaden|damage|reichweite|nominal|min|max|lifetime|restock|usage|tier|spawn|magazin|munition|ammo|kaliber|attachment|zubehoer|zubehör|erklaer|erklär|funktioniert)\b/i.test(fold(question));
}

function exactCaseMention(question: string): string | null {
  const names = [...base.getDayz129Index().allTypeNames]
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return names.find((name) => question.includes(name)) ?? null;
}

function uniqueCaseInsensitiveMention(question: string): string | null {
  const q = fold(question);
  const matches = base.getDayz129Index().allTypeNames.filter((name) => q.includes(fold(name)));
  return matches.length === 1 ? matches[0] : null;
}

function exactAnswer(name: string): DayzCatalogAnswer {
  return {
    answer: `Der Classname ist **\`${name}\`**.`,
    topic: 'type',
    ids: [`dayz129:type:${name}`],
  };
}

const TECHNICAL_ADMIN_MARKERS = /\b(server|nitrado|config|konfig|settings?|einstellung|datei|file|xml|json|cfg|mission|mod|parameter|feld|schalter|wert|central economy|ce|loot|spawn|event|wetter|weather|lifetime|restock|nominal|globals|types|events|basebuilding|bauen|build)\b/i;
const CHANGE_VERBS = /\b(aender|aendere|aendern|ander|andere|andern|änder|ändere|ändern|einstell|einstellen|setz|setzen|aktivier|aktivieren|deaktivier|deaktivieren|anpass|anpassen|konfigurier|konfigurieren|erhoeh|erhoehen|erhöh|erhöhen|verringer|verringern)\w*\b/i;
const CONFIGURABLE_CONCEPTS = /\b(stamina|ausdauer|third.?person|crosshair|perspektive|base.?damage|container.?damage|schaden|damage|tag.?nacht|day.?night|nacht|night|wetter|weather|loot|spawn|respawn)\b/i;

function explicitConfigFileToken(question: string): string | null {
  return question.match(/\b[A-Za-z0-9_.-]+\.(?:xml|json|cfg|c)\b/i)?.[0] ?? null;
}

function hasDayzContext(question: string): boolean {
  const q = fold(question);
  return /\bdayz\b|\bcentral economy\b|\bce\b|\bserverdz\.cfg\b|\bmaxplayers\b|\bservertimeacceleration\b|\bservernighttimeacceleration\b|\benablecfggameplayfile\b/.test(q);
}

function isUnscopedForeignConfigFile(question: string): boolean {
  const file = explicitConfigFileToken(question);
  if (!file) return false;
  if (hasDayzContext(question)) return false;
  return !base.isKnownDayz129Identifier(file);
}

function isTechnicalAdminIntent(question: string): boolean {
  if (!question) return false;
  const q = fold(question);
  const dayzContext = hasDayzContext(question);
  const fileToken = explicitConfigFileToken(question);
  if (fileToken) return dayzContext || base.isKnownDayz129Identifier(fileToken);
  if (!dayzContext) return false;
  return TECHNICAL_ADMIN_MARKERS.test(q) || (CHANGE_VERBS.test(q) && CONFIGURABLE_CONCEPTS.test(q));
}

function directTechnicalAnswer(question: string): DayzCatalogAnswer | null {
  const q = fold(question);

  if (/\bmaxplayers\b|maximale\s+spieler|spieler(?:zahl|anzahl).*server/.test(q)) {
    return {
      answer: '`maxPlayers` setzt in der DayZ-Serverkonfiguration die konfigurierte maximale Spielerzahl. Bei einem Hoster wie Nitrado kann das gebuchte Produkt zusätzlich eine harte Slot-Obergrenze setzen. Einen universellen Vanilla-Zahlenwert gebe ich dafür nicht aus.',
      topic: 'file',
      ids: ['dayz129:server:maxPlayers'],
    };
  }

  if (/\bservertimeacceleration\b|\bservernighttimeacceleration\b|tag.?nacht|day.?night/.test(q)) {
    return {
      answer: '`serverTimeAcceleration` beschleunigt die Serverzeit. `serverNightTimeAcceleration` wirkt zusätzlich auf die Nachtphase. Konkrete Werte solltest du nach gewünschter Tages-/Nachtlänge wählen; V-Bot erfindet dafür keinen angeblichen Vanilla-Pflichtwert.',
      topic: 'file',
      ids: ['dayz129:server:time-acceleration'],
    };
  }

  if (/bauen\s*\+|bauen plus|build[ -]?anywhere|basebuilding|bauplatzierung/.test(q)) {
    return {
      answer: [
        'Für **Bauen+ / gelockerte Bauplatzierung** in Vanilla DayZ 1.29 nutzt du `cfggameplay.json`.',
        '',
        '1. Aktiviere die Gameplay-Datei in der gestarteten Server-Konfiguration mit `enableCfgGameplayFile = 1;`.',
        '2. Bearbeite in der Mission `cfggameplay.json` -> `BaseBuildingData`.',
        '3. Setze nur die Prüfungen auf `true`, die du gezielt deaktivieren bzw. lockern willst.',
        '',
        'Belegte Platzierungschecks sind unter anderem `disableIsCollidingBBoxCheck`, `disableIsCollidingPlayerCheck` und `disableIsPlacementPermittedCheck`; für den Bauvorgang existieren `disablePerformRoofCheck`, `disableIsCollidingCheck` und `disableDistanceCheck`.',
      ].join('\n'),
      topic: 'file',
      ids: ['dayz129:file:cfggameplay.json', 'dayz129:server:enableCfgGameplayFile'],
    };
  }

  if (/mission\s+(wechseln|aendern|ändern)|(?:karte|map)\s+wechseln|mission\s+template|class\s+missions/.test(q)) {
    return {
      answer: 'Die Mission wird in der DayZ-Serverkonfiguration im `class Missions`-Block über `template` gewählt. Die drei verifizierten 1.29-Missionen heißen `dayzOffline.chernarusplus`, `dayzOffline.enoch` und `dayzOffline.sakhal`. Missionsdateien und CE-Werte nicht blind zwischen den Karten kopieren.',
      topic: 'file',
      ids: ['dayz129:server:mission-template'],
    };
  }

  if (/mods?\s+(installieren|laden)|workshop\s+mod|\-mod=|\-servermod=/.test(q)) {
    return {
      answer: 'DayZ-Mods werden serverseitig über Startparameter wie `-mod=` geladen. Konkrete Workshop-Pfade, Abhängigkeiten und zusätzliche Server-Parameter müssen aus der jeweiligen Mod-Dokumentation stammen; V-Bot rät sie nicht.',
      topic: 'file',
      ids: ['dayz129:server:mods'],
    };
  }

  if (CHANGE_VERBS.test(q) && /\b(wetter|weather|regen|rain|schnee|snow)\b/.test(q)) {
    return {
      answer: 'Für das Missionswetter ist in den verifizierten DayZ-1.29-Datensätzen `cfgweather.xml` zuständig. Die konkreten Bereiche unterscheiden sich je Karte; nenne Chernarus, Livonia oder Sakhal und das gewünschte Wetterziel, dann kann V-Bot die belegte Datei gezielt erklären, ohne Werte zu erfinden.',
      topic: 'file',
      ids: ['dayz129:file:cfgweather.xml'],
    };
  }

  return null;
}

function failClosedTechnicalAnswer(question: string): DayzCatalogAnswer | null {
  if (!isTechnicalAdminIntent(question)) return null;
  const direct = directTechnicalAnswer(question);
  if (direct) return direct;
  return {
    answer: 'Dazu kann ich dir aktuell keinen ausreichend sicher belegten DayZ-1.29-Datei-, Feld- oder Parameternamen nennen. Nenne mir die konkrete Datei, die Karte und das genaue Ziel; dann prüfe ich den vorhandenen 1.29-Katalog gezielt. Ich rate keine Server-Einstellung.',
    topic: 'file',
    ids: ['dayz129:technical:grounding-required'],
  };
}

export const searchTypes = v3.searchTypes;

export function answer(question: string): DayzCatalogAnswer | null {
  if (!question) return null;

  // Foreign config files must not be claimed by the DayZ catalog merely because
  // they end in .xml/.json/.cfg/.c. Known DayZ files still work without the
  // word "DayZ"; unknown files require explicit DayZ context.
  if (isUnscopedForeignConfigFile(question)) return null;

  const explicit = explicitLookupIntent(question);
  const short = question.trim().split(/\s+/).filter(Boolean).length <= 6 && !hasDetailIntent(question);

  if (explicit || short) {
    const exact = exactCaseMention(question);
    if (exact) return exactAnswer(exact);
  }

  // Case-insensitive matching is allowed only for explicit classname requests
  // and only when it is unique. This deliberately refuses collisions such as
  // Ammo_40mm_ChemGas vs Ammo_40mm_Chemgas instead of returning the wrong one.
  if (explicit) {
    const unique = uniqueCaseInsensitiveMention(question);
    if (unique) return exactAnswer(unique);
  }

  const existing = v3.answer(question);
  if (existing) return existing;

  // Final preflight firewall: technical DayZ admin/config questions must never
  // fall through to an ungrounded LLM answer. Known safe topics are answered
  // deterministically above; everything else fails closed without inventing
  // filenames, parameters or numeric defaults.
  return failClosedTechnicalAnswer(question);
}
