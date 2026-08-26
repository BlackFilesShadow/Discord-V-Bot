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
const KNOWN_FILE_ALIASES = new Set([
  'type.xml', 'types.xml',
  'event.xml', 'events.xml',
  'message.xml', 'messages.xml',
  'global.xml', 'globals.xml',
  'economy.xml',
]);

function explicitConfigFileToken(question: string): string | null {
  return question.match(/\b[A-Za-z0-9_.-]+\.(?:xml|json|cfg|c)\b/i)?.[0] ?? null;
}

function hasDayzContext(question: string): boolean {
  const q = fold(question);
  return /\bdayz\b|\bcentral economy\b|\bce\b|\bserverdz\.cfg\b|\bmaxplayers\b|\bservertimeacceleration\b|\bservernighttimeacceleration\b|\benablecfggameplayfile\b/.test(q);
}

function isKnownDayzConfigFile(file: string): boolean {
  const normalized = fold(file).replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  if (KNOWN_FILE_ALIASES.has(basename)) return true;
  return base.getDayz129Index().allRelativePaths.some((path) => {
    const candidate = fold(path).replace(/\\/g, '/');
    const candidateBasename = candidate.split('/').pop() ?? candidate;
    return normalized === candidate || basename === candidateBasename;
  });
}

function isUnscopedForeignConfigFile(question: string): boolean {
  const file = explicitConfigFileToken(question);
  if (!file) return false;
  if (hasDayzContext(question)) return false;
  return !isKnownDayzConfigFile(file);
}

function isTechnicalAdminIntent(question: string): boolean {
  if (!question) return false;
  const q = fold(question);
  if (!hasDayzContext(question)) return false;
  if (explicitConfigFileToken(question)) return false;
  return CHANGE_VERBS.test(q)
    && (TECHNICAL_ADMIN_MARKERS.test(q) || CONFIGURABLE_CONCEPTS.test(q));
}

function directCentralEconomyExplanation(question: string): DayzCatalogAnswer | null {
  const q = fold(question);
  const explanationIntent = /\b(was|wofuer|wozu|bedeut|erklaer|erklär|funktioniert|unterschied|macht)\b/.test(q);
  const fileIntent = /\btypes?\.xml\b/.test(q);
  const ceIntent = fileIntent || /\bdayz\b|\bcentral economy\b|\bce\b/.test(q);
  if (!explanationIntent && !fileIntent) return null;

  if (fileIntent && !/\b(nominal|min|lifetime|restock|quantmin|quantmax|flags?|usage|value|category|tag)\b/.test(q)) {
    return {
      answer: [
        '`db/types.xml` ist die Spawnable-Types-Konfiguration der DayZ Central Economy.',
        'Sie definiert die in der Economy bekannten Typen/Classnames und deren Präsenz-Limiter wie `nominal` und `min` sowie weitere CE-Metadaten wie `lifetime`, `restock`, Flags, Kategorien, Usage-, Value- und Tag-Zuordnungen.',
        'Wichtig: Die Datei beschreibt die Economy-Regeln eines Typs – sie ist keine einfache Liste von festen Spawnpunkten. Spawnmöglichkeiten und Kartenstruktur kommen aus weiteren CE-Dateien.',
      ].join('\n'),
      topic: 'file',
      ids: ['dayz129:file:types.xml'],
    };
  }

  if (ceIntent && /\bnominal\b/.test(q)) {
    return {
      answer: '`nominal` ist der Zielbestand eines Typs, den die Central Economy im Rahmen ihrer Regeln anstrebt. Es bedeutet **nicht**, dass exakt diese Zahl jederzeit sichtbar auf dem Boden liegt oder gleichzeitig an festen Punkten spawnt. Ob vorhandene Exemplare mitgezählt werden und ob nachgespawnt werden kann, hängt zusätzlich von CE-Flags, `min`, verfügbaren Spawnplätzen und weiteren Economy-Bedingungen ab.',
      topic: 'file', ids: ['dayz129:ce:nominal'],
    };
  }
  if (ceIntent && /\bmin\b|minimum/.test(q)) {
    return {
      answer: '`min` ist der untere Präsenz-Limiter eines Typs in der Central Economy. Sinkt der für die CE relevante Bestand entsprechend ab, entsteht Nachspawn-Bedarf in Richtung `nominal`. Das ist **keine Garantie**, dass sofort oder an einem bestimmten Ort ein neues Item erscheint; die CE muss weiterhin einen zulässigen Spawnplatz und ihre übrigen Bedingungen erfüllen.',
      topic: 'file', ids: ['dayz129:ce:min'],
    };
  }
  if (ceIntent && /\blifetime\b/.test(q)) {
    return {
      answer: '`lifetime` ist eine Zeitangabe in Sekunden für die Persistenz bzw. Cleanup-Bewertung eines CE-Typs. Sie ist **kein Respawn-Timer**. Ob ein Objekt tatsächlich entfernt wird, hängt zusätzlich von Cleanup-Bedingungen ab – zum Beispiel Spielerabstand und möglichen Lifetime-Refresh-Mechanismen wie Flaggen.',
      topic: 'file', ids: ['dayz129:ce:lifetime'],
    };
  }
  if (ceIntent && /\brestock\b/.test(q)) {
    return {
      answer: '`restock` steuert das zeitliche Nachfüllen/Respawn-Verhalten der Central Economy. Der Wert ist **kein fester Countdown**, nach dem ein genommenes Item garantiert am selben Spawnpunkt wieder erscheint. CE-Limiter, verfügbare Lootpunkte und weitere Spawnbedingungen entscheiden mit.',
      topic: 'file', ids: ['dayz129:ce:restock'],
    };
  }
  if (ceIntent && /\bquantmin\b|\bquantmax\b/.test(q)) {
    return {
      answer: '`quantmin` und `quantmax` begrenzen die Startmenge bei Typen mit einer Quantity/Füllmenge, zum Beispiel bei geeigneten Magazinen oder Behältern. `-1` bedeutet bei vielen Vanilla-Einträgen, dass für diesen CE-Eintrag keine solche Mengen-Spanne vorgegeben wird. Das ist getrennt von `nominal`/`min`, die den Typbestand steuern.',
      topic: 'file', ids: ['dayz129:ce:quantity'],
    };
  }
  if (ceIntent && /\bflags?\b|count_in_(?:cargo|hoarder|map|player)|\bdeloot\b|\bcrafted\b/.test(q)) {
    return {
      answer: 'Die `flags` in `types.xml` bestimmen unter anderem, **wo vorhandene Exemplare für die CE-Zählung berücksichtigt werden** (`count_in_cargo`, `count_in_hoarder`, `count_in_map`, `count_in_player`) und enthalten zusätzliche Kennzeichnungen wie `crafted` oder `deloot`. Deshalb darf `nominal` nie isoliert als „so viele liegen auf der Map“ erklärt werden.',
      topic: 'file', ids: ['dayz129:ce:flags'],
    };
  }
  if (ceIntent && /\busage\b|\bvalue\b|\bcategory\b|\btag\b|\btier\b/.test(q)) {
    return {
      answer: '`usage`, `value`, `category` und `tag` sind CE-Limiter/Zuordnungen. Sie verbinden einen Typ mit passenden Economy-Bereichen und Definitionen, zum Beispiel Usage-Gruppen oder Value/Tier-Zonen. Diese Namen müssen zu den jeweiligen Limit-Definitionen der Mission passen; sie sind keine frei erfundenen Beschreibungsfelder.',
      topic: 'file', ids: ['dayz129:ce:limiters'],
    };
  }
  return null;
}

function directTechnicalAnswer(question: string): DayzCatalogAnswer | null {
  const q = fold(question);

  if (/\bmaxplayers\b|maximale\s+spieler|spieler(?:zahl|anzahl).*server/.test(q)) {
    return {
      answer: '`maxPlayers` setzt in der DayZ-Serverkonfiguration die konfigurierte maximale Spielerzahl. Bei einem Hoster wie Nitrado kann das gebuchte Produkt zusätzlich eine harte Slot-Obergrenze setzen. Ich gebe dafür keinen universellen Vanilla-Zahlenwert aus.',
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

  if ((/\bmods?\b/.test(q) && /\b(?:installier\w*|lad\w*|workshop)\b/.test(q)) || /\-mod=|\-servermod=/.test(q)) {
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
  return {
    answer: 'Dazu kann ich dir aktuell keinen ausreichend sicher belegten DayZ-1.29-Datei-, Feld- oder Parameternamen nennen. Nenne mir die konkrete Datei, die Karte und das genaue Ziel; dann prüfe ich den vorhandenen 1.29-Katalog gezielt. Ich rate keine Server-Einstellung.',
    topic: 'file',
    ids: ['dayz129:technical:grounding-required'],
  };
}

export const searchTypes = v3.searchTypes;

export function answer(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  if (isUnscopedForeignConfigFile(question)) return null;

  const explicit = explicitLookupIntent(question);
  const short = question.trim().split(/\s+/).filter(Boolean).length <= 6 && !hasDetailIntent(question);

  if (explicit || short) {
    const exact = exactCaseMention(question);
    if (exact) return exactAnswer(exact);
  }

  if (explicit) {
    const unique = uniqueCaseInsensitiveMention(question);
    if (unique) return exactAnswer(unique);

    // Ein expliziter Classname-Wunsch muss vor allgemeiner Datei-Hilfe gewinnen.
    // Dadurch wird z. B. "wie heißt die Tundra in der types.xml?" als
    // Winchester70 aufgeloest, statt nur types.xml zu erklaeren. V3 arbeitet
    // dabei auf dem vollstaendigen eingebetteten 1.29-Types-Index und bleibt bei
    // unklaren/fehlenden Treffern fail-closed.
    const resolved = v3.answer(question);
    if (resolved) return resolved;
  }

  const ceExplanation = directCentralEconomyExplanation(question);
  if (ceExplanation) return ceExplanation;

  const direct = directTechnicalAnswer(question);
  if (direct) return direct;

  const guarded = failClosedTechnicalAnswer(question);
  if (guarded) return guarded;

  return v3.answer(question);
}
