import { answerDayz129CatalogQuestion } from '../../src/modules/ai/dayz129Catalog';
import { getDayz129Index } from '../../src/modules/ai/dayz129CatalogBase';

/**
 * Phase B: die drei gelieferten ZIP-Datensaetze werden jetzt fuer 13 weitere
 * Dateitypen inhaltlich geparst (vorher nur types.xml/events.xml). Diese
 * Tests pinnen konkrete, aus den echten Dateien gelesene Werte, damit eine
 * kuenftige Index-Regenerierung abweichende Werte sofort auffallen laesst.
 */
describe('DayZ 1.29 Phase B: extended file content (globals/weather/limits/etc.)', () => {
  test('the generated index actually carries the new Phase B fields', () => {
    const index = getDayz129Index();
    const cher = index.maps.chernarus;
    expect(cher.globals).toBeDefined();
    expect(cher.economyClasses).toBeDefined();
    expect(cher.economyCore).toBeDefined();
    expect(cher.weather).toBeDefined();
    expect(cher.limitsDefinition).toBeDefined();
    expect(cher.limitsDefinitionUser).toBeDefined();
    expect(cher.ignoreList).toBeDefined();
    expect(cher.territories).toBeDefined();
    expect(cher.eventGroups).toBeDefined();
    expect(cher.randomPresets).toBeDefined();
    expect(cher.effectAreas).toBeDefined();
    expect(cher.spawnableTypes).toBeDefined();
    expect(cher.playerSpawnPoints).toBeDefined();
    // Sakhal liefert real kein db/messages.xml - das muss weiterhin fehlend
    // (nicht faelschlich leer erfunden) bleiben.
    expect(index.maps.sakhal.messages).toBeUndefined();
    expect(index.maps.chernarus.messages).toEqual([]);
  });

  test('resolves a real db/globals.xml variable to its actual value per map', () => {
    const answer = answerDayz129CatalogQuestion('wie hoch ist ZombieMaxCount?');
    expect(answer?.answer).toContain('`ZombieMaxCount=1000`');
    expect(answer?.ids.every((id) => id.startsWith('dayz129:globals:'))).toBe(true);
  });

  test('a globals.xml question wins over the generic file-purpose explanation', () => {
    // Regressionsschutz: explicitCatalogIntent matcht "globals.xml" literal
    // und wuerde sonst zuerst die generische Datei-Beschreibung liefern statt
    // des tatsaechlichen, jetzt bekannten Werts.
    const answer = answerDayz129CatalogQuestion('was bedeutet FlagRefreshFrequency in globals.xml?');
    expect(answer?.answer).toContain('Globale CE-Variable `FlagRefreshFrequency`');
    expect(answer?.answer).toContain('FlagRefreshFrequency=432000');
  });

  test('lists the definitive category/usage/value/tag namespace from cfglimitsdefinition.xml', () => {
    const categories = answerDayz129CatalogQuestion('welche Kategorien gibt es in der Central Economy?');
    expect(categories?.answer).toContain('`tools`');
    expect(categories?.answer).toContain('`weapons`');

    const usage = answerDayz129CatalogQuestion('welche Usage-Zonen gibt es?');
    expect(usage?.answer).toContain('`Military`');
    expect(usage?.answer).toContain('`ContaminatedArea`');

    const tiers = answerDayz129CatalogQuestion('welche Wertstufen gibt es?');
    expect(tiers?.answer).toContain('`Tier1`');
    expect(tiers?.answer).toContain('`Unique`');
  });

  test('does not fire on an unrelated question that merely contains the bare word "Kategorien"', () => {
    expect(answerDayz129CatalogQuestion('wie viele Kategorien hat mein Kühlschrank?')).toBeNull();
  });

  test('answers ignore-list membership for a real classname', () => {
    // Von den 18 gelisteten cfgignorelist.xml-Eintraegen ist "EasterEgg" der
    // einzige, der auch im aktuellen types.xml-Index als realer Classname
    // existiert - die anderen (Bandage, Spear, CattleProd, ...) sind in der
    // Ignore-Liste referenziert, aber kein aktueller 1.29-Classname mehr. Das
    // ist eine reale Eigenschaft der gelieferten Dateien, kein Fehler dieses
    // Codes, und wird hier bewusst mit dem tatsaechlich passenden Eintrag
    // getestet statt einen nicht (mehr) existierenden Classname anzunehmen.
    const answer = answerDayz129CatalogQuestion('ist EasterEgg auf der Ignore-Liste?');
    expect(answer?.answer).toContain('Ist `EasterEgg` auf der CE-Ignore-Liste');
    expect(answer?.answer).toContain('Chernarus: ja');
  });

  test('does not fire on the ordinary verb "ignoriert" without DayZ context', () => {
    expect(answerDayz129CatalogQuestion('Mein Chef hat mich heute komplett ignoriert.')).toBeNull();
  });

  test('resolves a cfgweather.xml section value for a named map', () => {
    const answer = answerDayz129CatalogQuestion('wie hoch ist der Storm-Threshold auf Chernarus?');
    expect(answer?.answer).toContain('Chernarus: `density=1`, `threshold=0.9`, `timeout=45`');
    expect(answer?.answer).not.toContain('Livonia');
  });

  test('does not fire on ordinary weather small talk without DayZ context', () => {
    expect(answerDayz129CatalogQuestion('Der Regen war gestern richtig stark.')).toBeNull();
    expect(answerDayz129CatalogQuestion('Drausen ist gerade dichter Nebel.')).toBeNull();
  });

  test('resolves a real cfgrandompresets.xml preset with its actual items', () => {
    const answer = answerDayz129CatalogQuestion('was ist im Preset foodHermit?');
    expect(answer?.answer).toContain('`TunaCan` (0.11)');
    expect(answer?.answer).toContain('`Apple` (0.07)');
  });

  test('resolves a real cfgeventgroups.xml group to its actual child classnames', () => {
    const answer = answerDayz129CatalogQuestion('was steht in der Eventgruppe Train_Abandoned_Cherno?');
    expect(answer?.answer).toContain('`StaticObj_Wreck_Train_742_Red_DE`');
    expect(answer?.answer).toContain('`Land_Train_Wagon_Box_DE` x4');
    expect(answer?.answer).toContain('Livonia: nicht vorhanden');
  });

  test('resolves cfgeffectarea.json contamination area details by name', () => {
    const answer = answerDayz129CatalogQuestion('wie groß ist der kontaminierte Bereich Ship-Bow?');
    expect(answer?.answer).toContain('Typ `ContaminatedArea_Static`');
    expect(answer?.answer).toContain('Radius 75');
  });

  test('resolves cfgspawnabletypes.xml attachment/cargo relationships for a real classname', () => {
    const answer = answerDayz129CatalogQuestion('welches Zubehör hat PlateCarrierVest_Camo?');
    expect(answer?.answer).toContain('PlateCarrierHolster_Camo');
    expect(answer?.answer).toContain('PlateCarrierPouches_Camo');
  });

  test('a spawnable-type question wins over the generic classname lookup when accessory context is present', () => {
    // Ohne die Vorrang-Reihenfolge wuerde "PlateCarrierVest_Camo" (ein echter,
    // technisch aussehender Identifier) explicitCatalogIntent ausloesen und
    // nur den nackten Classname-Datensatz statt der Zubehoer-Relation liefern.
    const answer = answerDayz129CatalogQuestion('welches Zubehör hat PlateCarrierVest_Camo?');
    expect(answer?.answer).toContain('Spawn-Zubehoer/Cargo fuer `PlateCarrierVest_Camo`');
  });

  test('a plain classname question without accessory context still resolves via the existing terse path', () => {
    const answer = answerDayz129CatalogQuestion('DayZ Classname PlateCarrierVest_Camo');
    expect(answer?.answer).toBe('Der Classname ist **`PlateCarrierVest_Camo`**.');
  });

  test('territory zone-count answers still resolve unchanged (Phase B did not regress Phase A)', () => {
    const answer = answerDayz129CatalogQuestion('wie viele Zombie-Zonen hat Sakhal?');
    expect(answer?.answer).toContain('- Sakhal: 417');
  });

  test('unrelated general questions stay null', () => {
    expect(answerDayz129CatalogQuestion('was ist Photosynthese?')).toBeNull();
    expect(answerDayz129CatalogQuestion('wie geht es dir heute?')).toBeNull();
  });
});
