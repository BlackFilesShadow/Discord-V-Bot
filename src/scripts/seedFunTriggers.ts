/**
 * One-Shot Seed: F\u00fcgt 4 Fun-Trigger f\u00fcr eine Guild ein.
 * Ausf\u00fchrung:  GUILD_ID=<id> node dist/scripts/seedFunTriggers.js
 */
import prisma from '../database/prisma';
import { listTriggers, saveTriggers, AiTrigger } from '../modules/ai/triggers';

const GUILD_ID = process.env.GUILD_ID;
if (!GUILD_ID) {
  console.error('GUILD_ID environment variable required');
  process.exit(1);
}

const now = new Date().toISOString();
const createdBy = 'system-seed';

const FUN_TRIGGERS: AiTrigger[] = [
  {
    id: 'order66',
    trigger: 'order 66',
    triggerType: 'keyword',
    responseMode: 'text',
    responseText: [
      'Lang lebe das Imperium.',
      'Die Jedi werden fallen.',
      'Befehl best\u00e4tigt. Eliminierung eingeleitet.',
      'F\u00fcr das Imperium gibt es kein Zur\u00fcck.',
      'Die Ordnung wird wiederhergestellt.',
    ].join(' ||| '),
    cooldownSeconds: 15,
    createdAt: now,
    createdBy,
  },
  {
    id: 'handwerk',
    trigger: 'was ist euer handwerk',
    triggerType: 'keyword',
    responseMode: 'text',
    responseText: [
      'ARHUUUU!',
      'Spartaner! Was ist euer Handwerk?!',
      'Kampf. Ehre. Ruhm.',
      'Wir k\u00e4mpfen im Schatten und siegen im Licht.',
      'Heute k\u00e4mpfen wir, morgen erinnern sie sich an uns.',
    ].join(' ||| '),
    cooldownSeconds: 15,
    createdAt: now,
    createdBy,
  },
  {
    id: 'erschaffer',
    trigger: 'wer hat dich (gebaut|erschaffen|erstellt|programmiert|gemacht)',
    triggerType: 'regex',
    responseMode: 'text',
    responseText:
      'Ich wurde von **Void_Architect** erschaffen.\n' +
      'Meine Aufgabe ist es, zu unterst\u00fctzen, zu helfen und Informationen bereitzustellen \u2013 effizient, klar und zuverl\u00e4ssig. ' +
      'Gleichzeitig bin ich darauf ausgelegt, interaktiv zu sein und ein gewisses Ma\u00df an Charakter und Pers\u00f6nlichkeit mitzubringen.',
    cooldownSeconds: 30,
    createdAt: now,
    createdBy,
  },
  {
    id: 'commands',
    trigger: 'wie funktionieren deine commands',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt:
      'Erkl\u00e4re kurz und freundlich, wie deine Commands grunds\u00e4tzlich funktionieren. ' +
      'Erw\u00e4hne, dass du Slash-Commands (/) verwendest, dass es User-, Admin- und Developer-Commands gibt, ' +
      'und dass Developer-Commands nur f\u00fcr berechtigte Nutzer zug\u00e4nglich sind. ' +
      'Schreibe in einer kurzen, klaren Liste mit ein paar Beispielen wie /help, /level, /ai. ' +
      'Maximal 800 Zeichen. Keine Halluzinationen \u2013 nur Standard-Bot-Funktionalit\u00e4t.',
    cooldownSeconds: 30,
    createdAt: now,
    createdBy,
  },
];

async function main() {
  const guildId = GUILD_ID as string;
  const existing = await listTriggers(guildId);
  console.log(`Bestehende Trigger: ${existing.length}`);

  // Nur neue hinzuf\u00fcgen, bestehende mit gleicher ID ersetzen
  const merged: AiTrigger[] = existing.filter(e => !FUN_TRIGGERS.some(f => f.id === e.id));
  for (const t of FUN_TRIGGERS) {
    merged.push(t);
    console.log(`  + ${t.id} (${t.triggerType}, ${t.responseMode})`);
  }

  if (merged.length > 10) {
    console.error(`\u274c W\u00fcrde ${merged.length} Trigger ergeben (Limit: 10). Abbruch.`);
    process.exit(1);
  }

  await saveTriggers(guildId, merged, createdBy);
  console.log(`\u2705 ${merged.length}/10 Trigger gespeichert.`);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
