/**
 * Freche, coole DayZ-Themen Level-Up-Texte (nicht beleidigend).
 * Platzhalter: {user} = Mention, {level} = neues Level, {username} = Klartext-Name.
 *
 * Bot wählt zufällig einen passenden Text für das jeweilige Level.
 * Levels 1–20 abgedeckt, plus generische Pools als Fallback.
 */

export interface LevelMessageContext {
  user: string;     // Mention z.B. <@123>
  level: number;
  username?: string;
}

/**
 * Spezifische Texte pro Level (1–20). Jedes Level hat 6+ Varianten,
 * der Bot würfelt eine aus.
 */
const PER_LEVEL_MESSAGES: Record<number, string[]> = {
  1: [
    '🥫 {user} hat **Level {level}** erreicht — Frischling an der Küste, Beans gefunden, jetzt darfst du auch nach Cherno laufen.',
    '🩸 {user} ist auf **Level {level}** — willkommen in Chernarus, halt die Hände hoch wenn jemand "Friendly?" ruft.',
    '🥾 **Level {level}** für {user}! Dein erster Spawn ohne sofort gemeucheln zu werden — Respekt.',
    '🍞 {user} schafft **Level {level}** — Brotrinde gefunden, satt geworden, Sieg.',
    '🌊 {user} ist offiziell **Level {level}** — Salzwasser geschmeckt, Lehre gelernt: nicht trinken.',
    '🦟 **Level {level}**! {user}, dein erstes Mosquito-Trauma — willkommen im Sumpf.',
    '🩴 {user} steigt auf **Level {level}** — barfuß durch Berezino marschiert wie ein Profi.',
  ],
  2: [
    '🪓 {user} hat **Level {level}** — eine Axt, ein Apfel, ein Traum.',
    '🍎 **Level {level}**, {user}! Du hast Äpfel gepflückt ohne dabei abzukacken. Das nenn ich Skill.',
    '🔥 {user} entzündet **Level {level}** — erstes Lagerfeuer, kein Inferno. Saubere Arbeit.',
    '🐔 **Level {level}** für {user} — Huhn gefangen, gerupft, gegrillt. Survival-Modus AN.',
    '🪨 {user} ist auf **Level {level}** — aus Stein wird Messer. Steinzeit-Vibes.',
    '🥬 **Level {level}**, {user}! Eine Paprika gefunden und nicht gleich vergiftet. Erste Sahne.',
  ],
  3: [
    '🎒 **Level {level}**, {user} — Rucksack gefunden, jetzt kannst du noch mehr Müll horten.',
    '🥾 {user} schleicht sich auf **Level {level}**. Vorsicht, hinter dir steht ein Huhn.',
    '🧣 **Level {level}** für {user} — erstes Halstuch gefunden, sieht aus wie ein Pirat. Yarrr.',
    '🍶 {user} hat **Level {level}** — Wasserflasche gefüllt, ohne Cholera zu kriegen. Hut ab.',
    '🪛 **Level {level}**, {user} — Schraubenzieher entdeckt, bei der Bauanleitung verzweifelt.',
    '🦴 {user} steigt auf **Level {level}** — erstes Knochenmesser gebastelt. MacGyver lebt.',
  ],
  4: [
    '🔫 {user} ist **Level {level}** — eine Mosin gefunden und sofort an einen Fremden verloren. Klassiker.',
    '🍗 **Level {level}**! {user} hat heute mehr Hühner gegessen als gewaschen.',
    '🎯 {user} schafft **Level {level}** — erster Schuss, erster Treffer, erster "F" im Chat.',
    '🪵 **Level {level}** für {user} — Holz gehackt wie ein Wikinger. Bergbau-Skill +1.',
    '🥬 {user} hat **Level {level}** — Kohl gegessen, gerülpst, weitergemacht.',
    '🩹 **Level {level}**, {user}! Erste Bandage selbst gewickelt, ohne zu verbluten. Beeindruckend.',
  ],
  5: [
    '🛢️ **Level {level}**, {user}! Du bist offiziell kein Beach-Bambi mehr — jetzt darfst du in Elektro sterben.',
    '🚗 {user} hat **Level {level}** — Auto gefunden, in den Graben gefahren. Karma 100.',
    '🔦 **Level {level}** für {user} — Taschenlampe gefunden, sofort Position verraten. Klassiker.',
    '🪖 {user} ist auf **Level {level}** — erstes Helmtreffer überlebt. Glück gehabt.',
    '🏚️ **Level {level}**, {user}! Erstes Haus geplündert ohne Falle auszulösen.',
    '🐺 {user} steigt auf **Level {level}** — Wolfsrudel überlebt mit ner Pfanne. Legende.',
  ],
  6: [
    '🩹 **Level {level}**! {user} weiß jetzt was eine Saline ist und tankt nicht mehr Desinfektionsmittel.',
    '🦴 {user} ist **Level {level}** — Knochen gefunden und gleich daraus ein Messer geschnitzt. MacGyver-Vibes.',
    '⛺ **Level {level}** für {user} — erstes Zelt aufgebaut, steht sogar gerade. Hammer.',
    '🥩 {user} hat **Level {level}** — rohes Fleisch nicht gegessen. Cleverer Move.',
    '🧭 **Level {level}**, {user}! Norden gefunden, Tiefdruckgebiet auch. Pfadfinder-Stil.',
    '🚿 {user} steigt auf **Level {level}** — endlich gewaschen. Die Server-Fliegen sind erleichtert.',
  ],
  7: [
    '🧥 **Level {level}**, {user} — Ghillie-Suit-Träume. Aktuell läufst du aber noch wie ein wandernder Christbaum durchs Feld.',
    '☢️ {user} hat **Level {level}** — Sperrgebiet betreten, Strahlung gegessen, Lebensentscheidung getroffen.',
    '🎒 **Level {level}** für {user} — Mountain Backpack gefunden. Inventory-Tetris läuft heiß.',
    '🩺 {user} ist **Level {level}** — Salinflasche gefunden, Blutgruppe entdeckt. Doc-Mode.',
    '🪟 **Level {level}**, {user}! Durchs Fenster geklettert ohne Bruch. Stuntman-Diplom.',
    '🧤 {user} steigt auf **Level {level}** — Lederhandschuhe an, Style-Punkte +20.',
  ],
  8: [
    '🪖 **Level {level}**! {user} trägt jetzt Helm — der nächste Headshot kommt trotzdem.',
    '🛻 {user} hat **Level {level}** — du fährst inzwischen schneller als die Zombies dich erwischen.',
    '🥫 **Level {level}** für {user} — zehnte Bohne gegessen, Gas-Mob folgt dir wie ein Hund.',
    '🔪 {user} ist **Level {level}** — Combat-Knife in der Tasche, Mut im Herzen.',
    '🌧️ **Level {level}**, {user}! Im Regen überlebt ohne zu erfrieren. Pfadfinder-Award.',
    '🎁 {user} schafft **Level {level}** — eine Care-Package gefunden, sofort von KOS-Kid gemeuchelt.',
  ],
  9: [
    '🎯 **Level {level}**, {user}! Erster sauberer Long-Range-Kill. Oder war\'s ein Hase? Egal.',
    '🪓 {user} steigt auf **Level {level}** — Holzfäller-Simulator gemeistert.',
    '🏹 **Level {level}** für {user} — Bogen gebaut, Pfeil verschossen, Bambi geschossen. Robin Hood.',
    '🚙 {user} hat **Level {level}** — Reifen gewechselt mit nem Schraubenzieher. Pure Magie.',
    '🩸 **Level {level}**, {user}! Drei Bluttransfusionen, zwei Saline, eine Lebensgeschichte.',
    '🏚️ {user} ist auf **Level {level}** — Haus durchwühlt, alles wertlos, weitergezogen.',
  ],
  10: [
    '🏆 **Level {level}**, {user}! HALBZEIT! Du bist offiziell kein PvE-Held mehr — die Server merken sich deinen Namen.',
    '🩸 {user} hat **Level {level}** erreicht — die ersten 9 Leben sind weg, jetzt geht\'s ums Eingemachte.',
    '⚡ **Level {level}**! {user}, du hast mehr überlebt als die durchschnittliche Bohne im Kühlschrank.',
    '👑 **Level {level}** für {user} — Halbgott von Chernarus. Nur noch 10 zum Olymp.',
    '🥃 {user} steigt auf **Level {level}** — verdient sich einen Schluck Vodka. In-Game natürlich.',
    '🎖️ **Level {level}**, {user}! Verteidiger der Beans, Beschützer der Frischlinge.',
  ],
  11: [
    '🏚️ **Level {level}**, {user} — Basisbau-Träume. Mauer 1 von 47 fertig.',
    '🪛 {user} ist **Level {level}** — Schraubenzieher-Kult beigetreten.',
    '🛠️ **Level {level}** für {user} — erster Tower steht. Solange er hält.',
    '🪚 {user} hat **Level {level}** — Sägeblatt gefunden, alles in Brennholz verwandelt.',
    '⚙️ **Level {level}**, {user}! Mühlenbau begonnen, Mehl-Empire eingeläutet.',
    '🏗️ {user} steigt auf **Level {level}** — Baumeister von Berezino. Holzpalast incoming.',
  ],
  12: [
    '🔋 **Level {level}**! {user} hat eine funktionierende Batterie gefunden. Der Server bebt.',
    '📻 {user} steigt auf **Level {level}** — Funkgerät an, "Anyone in Berezino?"',
    '🚙 **Level {level}** für {user} — Auto repariert, nach 2 Min in Klippe gerast. Der Klassiker.',
    '⚡ {user} ist **Level {level}** — Generator angeworfen, Stromrechnung egal.',
    '🪜 **Level {level}**, {user}! Leiter geklaut, Aussichtsturm fertig.',
    '🔧 {user} schafft **Level {level}** — Mechaniker-Diplom mit Auszeichnung verloren.',
  ],
  13: [
    '☠️ **Level {level}**, {user} — Unglückszahl, aber du lachst nur. Bandit-Vibes aktiviert.',
    '🥷 {user} hat **Level {level}** — Schleichmodus-Master. Selbst die Wölfe haben Respekt.',
    '🃏 **Level {level}** für {user} — Joker-Energie. Niemand weiß, was du als Nächstes tust.',
    '🩻 {user} ist **Level {level}** — Skelett-Fund: dein eigenes von letzter Woche.',
    '🌑 **Level {level}**, {user}! Nachts unterwegs ohne Lampe. Mut oder Wahnsinn.',
    '🦂 {user} steigt auf **Level {level}** — Skorpion-Aura. Niemand legt sich mehr mit dir an.',
  ],
  14: [
    '🚁 **Level {level}**! {user} hat einen Heli-Crashsite zuerst geplündert. Server-MVP.',
    '🎒 {user} ist **Level {level}** — Inventar voll mit Loot, Kopf voll mit Stolz.',
    '🛩️ **Level {level}** für {user} — über die Karte galoppiert wie ein Profi.',
    '💣 {user} hat **Level {level}** — Granate gefunden, nicht aus Versehen gezogen. Wunder.',
    '🎯 **Level {level}**, {user}! Scope montiert, Range eingestellt, Bambi erlegt.',
    '🥇 {user} steigt auf **Level {level}** — Chef-Looter von Tisy-Berg.',
  ],
  15: [
    '👑 **Level {level}**, {user} — Veteran. Du weißt was "KOS" bedeutet und nutzt es.',
    '🩸 {user} hat **Level {level}** — wenn jemand "Friendly?" fragt, lügst du eiskalt.',
    '🛡️ **Level {level}** für {user} — Plate Carrier mit Pouches. Outfit on point.',
    '🪖 {user} ist **Level {level}** — Vollausrüstung, halbgöttlich.',
    '🔫 **Level {level}**, {user}! AK gefunden, Magazin gefüllt, Plan geschmiedet.',
    '🥷 {user} schafft **Level {level}** — Phantom von Chernarus. Niemand sieht dich kommen.',
  ],
  16: [
    '🏴‍☠️ **Level {level}**! {user} ist offiziell ein Bandit. Die Newbies an der Küste zittern schon.',
    '🪖 {user} steigt auf **Level {level}** — Vollausrüstung, halbverrückt.',
    '⚔️ **Level {level}** für {user} — Tisy gestürmt wie Rambo. Loot gesichert.',
    '💀 {user} hat **Level {level}** — Schädelmaske gefunden, Bandit-Look komplett.',
    '🔥 **Level {level}**, {user}! Lager angezündet, Beweise vernichtet, weiter geht\'s.',
    '🦅 {user} ist auf **Level {level}** — Adler-Auge auf 800m. Sniper-Mode aktiviert.',
  ],
  17: [
    '🛡️ **Level {level}**, {user} — Plate Carrier? Hast du. Helm? Hast du. Plan? Vermutlich.',
    '🔥 {user} hat **Level {level}** — Tier-1-Loot-Sammler. Kein Stash zu groß.',
    '⚙️ **Level {level}** für {user} — Waffenpflege-Routine wie ein Uhrwerk.',
    '🚙 {user} ist **Level {level}** — Truck gefunden, Hänger dran, rollende Festung.',
    '🏰 **Level {level}**, {user}! Basis ausgebaut, Codeschloss installiert. Festung.',
    '🪙 {user} steigt auf **Level {level}** — Gold-Tier-Trader. Beans gegen AKs.',
  ],
  18: [
    '🐺 **Level {level}**! {user} ist jetzt der Wolf, nicht das Schaf.',
    '⚔️ {user} steigt auf **Level {level}** — die Tisy-Militärbasis ist dein zweites Wohnzimmer.',
    '🦁 **Level {level}** für {user} — Apex-Predator von Chernarus. Sogar Bären weichen aus.',
    '💎 {user} hat **Level {level}** — Diamant-Status. Andere Spieler wollen dein Autogramm.',
    '🌪️ **Level {level}**, {user}! Schneller als der Wind, leiser als die Nacht.',
    '🏆 {user} ist **Level {level}** — Top 1% der Serverliste. Hall of Fame.',
  ],
  19: [
    '🎖️ **Level {level}**, {user} — fast am Gipfel. Eine Bohne noch, dann Endgame.',
    '💀 {user} hat **Level {level}** — die Server-Legende beginnt sich zu formen.',
    '👁️ **Level {level}** für {user} — du siehst alles, hörst alles, weißt alles.',
    '🧙 {user} ist **Level {level}** — Magier von Chernarus. Loot manifestiert sich um dich.',
    '⚡ **Level {level}**, {user}! Ein Schritt vom Olymp entfernt. Halt durch.',
    '🌟 {user} steigt auf **Level {level}** — kurz vor der Krone. Die Bohnen-Ahnen schauen zu.',
  ],
  20: [
    '👑 **MAX LEVEL {level}!** {user} — du bist die letzte überlebende Legende von Chernarus. Halt die Krone fest.',
    '🏅 **Level {level}** — ENDGAME! {user}, du hast alles gesehen: Hacker, Glitches, Crashes — und überlebt.',
    '🔥 **MAX LEVEL!** {user} ist auf **Level {level}** — selbst die Devs grüßen dich jetzt.',
    '🥇 **Level {level}** — GOAT-Status für {user}. Statue in Cherno wird gerade gebaut.',
    '🌌 **MAX LEVEL {level}!** {user}, du hast Chernarus offiziell durchgespielt. Game beendet.',
    '⚔️ **Level {level}** — {user}, der unbesiegbare Bohnen-König. Server bebt.',
    '🪙 **MAX LEVEL!** {user}, jeder Trader auf der Karte kennt deinen Namen. Respekt.',
  ],
};

/**
 * Generische Backup-Texte falls für ein Level nichts definiert ist.
 */
const FALLBACK_MESSAGES: string[] = [
  '🎉 {user} hat **Level {level}** erreicht — schon wieder Loot? Glückwunsch!',
  '🩸 **Level {level}**! {user} überlebt länger als die meisten Beans im Kühlschrank.',
  '🥫 {user} steigt auf **Level {level}** — eine Bohne, ein Schritt, ein Sieg.',
  '⚡ **Level {level}**, {user} — Chernarus nickt anerkennend.',
  '🪖 {user} hat **Level {level}** — der Loot-Gott ist dir wohlgesonnen.',
  '🔥 **Level {level}** für {user} — die Server-Legende wächst weiter.',
  '🏆 {user} schafft **Level {level}** — XP-Magnet on tour.',
  '👑 **Level {level}**! {user}, du bist offiziell over 9000.',
];

/**
 * Spezielle Glückwunsch-Texte für das Erreichen des Max-Levels samt Rollenvergabe.
 */
const MAX_LEVEL_REWARD_MESSAGES: string[] = [
  '👑 {user} ist jetzt eine **Server-Legende** und bekommt die Rolle <@&{roleId}>! Bohnen für alle!',
  '🏅 Endgame erreicht! {user} trägt ab sofort <@&{roleId}> mit Stolz. Salutiert!',
  '🔥 {user}, du Verrückter — du hast\'s geschafft. <@&{roleId}> gehört jetzt dir.',
  '⚔️ {user} schwingt sich in den Olymp! Ehrenrolle <@&{roleId}> verliehen. Hut ab.',
  '🥇 {user} hat das Endgame gesehen. <@&{roleId}> ist deine wohlverdiente Krone.',
  '🌟 Der Server kniet nieder vor {user} — neue Rolle: <@&{roleId}>. Legendenstatus.',
];

/**
 * Liefert eine zufällige Level-Up-Nachricht für das gegebene Level.
 */
export function getLevelUpMessage(ctx: LevelMessageContext): string {
  const pool = PER_LEVEL_MESSAGES[ctx.level] ?? FALLBACK_MESSAGES;
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template
    .replace(/\{user\}/g, ctx.user)
    .replace(/\{level\}/g, String(ctx.level))
    .replace(/\{username\}/g, ctx.username ?? 'Survivor');
}

/**
 * Liefert eine zufällige Max-Level-Belohnungs-Nachricht (mit Rollen-Mention).
 */
export function getMaxLevelRewardMessage(user: string, roleId: string): string {
  const template = MAX_LEVEL_REWARD_MESSAGES[Math.floor(Math.random() * MAX_LEVEL_REWARD_MESSAGES.length)];
  return template.replace(/\{user\}/g, user).replace(/\{roleId\}/g, roleId);
}
