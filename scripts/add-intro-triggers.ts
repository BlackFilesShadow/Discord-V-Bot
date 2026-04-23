/// <reference types="node" />
// Script zum automatischen Hinzufügen von 4 individuellen "stell dich vor" AI-Triggern
// Ausführen mit: npx ts-node scripts/add-intro-triggers.ts

import prisma from '../src/database/prisma';
import { AiTrigger, MAX_TRIGGERS_PER_GUILD } from '../src/modules/ai/triggers';

const GUILD_ID = '1366021241630363720'; // Deine Guild-ID hier eintragen
const USER_ID = 'DEINE_DISCORD_ID'; // Deine Discord-ID als Ersteller

const introPrompts: string[] = [
  `Du bist V-Bot, der freundliche Assistent dieses Discord-Servers. Stelle dich locker, sympathisch und mit maximal einem passenden Emoji vor. Halte dich kurz, sei nicht steif, sondern einladend und cool. Beispiel: „Hey, ich bin V-Bot – dein digitaler Helfer hier! Sag Bescheid, wenn du was brauchst. 😎“`,
  `Du bist V-Bot, der smarte Discord-Bot. Begrüße die Nutzer locker, stelle dich mit maximal einem Emoji vor und erwähne, dass du für Fragen und Hilfe da bist. Sei freundlich, nicht zu förmlich, und bring einen Hauch Humor ein.`,
  `Du bist V-Bot, der entspannte Bot auf diesem Server. Stell dich kurz und sympathisch vor, nutze ein Emoji, und lade die Nutzer ein, dich bei Fragen oder Problemen einfach zu taggen. Kein Standardtext, sondern immer ein bisschen anders!`,
  `Du bist V-Bot, der digitale Kumpel für diesen Server. Begrüße die Nutzer mit einem lockeren Spruch und einem Emoji, stelle dich vor und sag, dass du immer ein offenes Ohr hast. Sei dabei freundlich und nicht zu steif.`
];

async function main() {
  // Bestehende Trigger laden
  const cfg = await prisma.botConfig.findUnique({ where: { key: `triggers:${GUILD_ID}` } });
  let triggers: AiTrigger[] = [];
  if (cfg && Array.isArray(cfg.value)) triggers = cfg.value as unknown as AiTrigger[];

  // Prüfen, ob schon zu viele Trigger existieren
  if (triggers.length + introPrompts.length > MAX_TRIGGERS_PER_GUILD) {
    throw new Error(`Zu viele Trigger: Es sind bereits ${triggers.length} vorhanden, maximal ${MAX_TRIGGERS_PER_GUILD} erlaubt.`);
  }

  // Neue Trigger anlegen
  const now = new Date().toISOString();
  const newTriggers: AiTrigger[] = introPrompts.map((aiPrompt, i) => ({
    id: `intro${i+1}`,
    trigger: 'stell dich vor',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt,
    cooldownSeconds: 10,
    createdAt: now,
    createdBy: USER_ID,
  }));

  // Trigger hinzufügen
  const updated = [...triggers.filter(t => !newTriggers.some(nt => nt.id === t.id)), ...newTriggers];
  await prisma.botConfig.upsert({
    where: { key: `triggers:${GUILD_ID}` },
    create: {
      key: `triggers:${GUILD_ID}`,
      value: updated as unknown as object,
      category: 'ai_triggers',
      description: `AI-Trigger für Guild ${GUILD_ID}`,
      updatedBy: USER_ID,
    },
    update: { value: updated as unknown as object, updatedBy: USER_ID },
  });
  console.log('Intro-Trigger erfolgreich gespeichert!');
}

main().catch(e => { console.error(e); process.exit(1); });
