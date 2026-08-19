/**
 * Diagnose: ermittelt fuer aktive Nitrado-Verbindungen die Server-Stammdaten und
 * sucht das ADM-Verzeichnis (wo die .ADM-Logs liegen). Gibt NIE den Token aus.
 * Ausfuehrung im Container: node dist/src/scripts/nitradoDiag.js
 *
 * Nitrado-1Y: `nitradoServerId` ist die einzige kanonische Remote-Service-ID.
 * Der globale Scan ist nur Kandidatenfindung; Token + Service werden unter dem
 * gleichen kurzen Connection-Lock wie Runtime-Mutationen frisch gelesen.
 */
import prisma from '../database/prisma';
import { config } from '../config';
import { decrypt } from '../utils/security';
import { NitradoClient } from '../modules/nitrado/nitradoClient';
import { tryAcquireNitradoConfigMutationLock } from '../modules/nitrado/configMutationLock';

// Kandidaten-Unterordner fuer DayZ-Profile/Configs (Plattformen), relativ zum Spielpfad.
const CANDIDATE_SUBDIRS = ['', 'config', 'profiles', 'dayzxb', 'dayzps', 'dayzstandalone'];

interface DiagSnapshot {
  id: string;
  guildId: string;
  alias: string;
  nitradoServerId: string;
  encryptedToken: string;
}

async function readDiagSnapshot(candidate: { id: string; guildId: string }): Promise<DiagSnapshot | null | 'BUSY'> {
  const lock = await tryAcquireNitradoConfigMutationLock(candidate.id);
  if (!lock) return 'BUSY';
  try {
    const conn = await prisma.nitradoConnection.findFirst({
      where: {
        id: candidate.id,
        guildId: candidate.guildId,
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      },
      select: {
        id: true,
        guildId: true,
        alias: true,
        nitradoServerId: true,
        encryptedToken: true,
      },
    });
    if (!conn?.nitradoServerId) return null;
    return {
      id: conn.id,
      guildId: conn.guildId,
      alias: conn.alias,
      nitradoServerId: conn.nitradoServerId,
      encryptedToken: conn.encryptedToken,
    };
  } finally {
    await lock.release();
  }
}

async function findAdmDir(client: NitradoClient, serviceId: string, basePath: string): Promise<string | null> {
  const bases = new Set<string>();
  for (const sub of CANDIDATE_SUBDIRS) {
    bases.add(sub ? `${basePath.replace(/\/$/, '')}/${sub}` : basePath);
  }
  for (const dir of bases) {
    try {
      const entries = await client.listDir(serviceId, dir);
      const adm = entries.filter(e => e.type === 'file' && e.name.toLowerCase().endsWith('.adm'));
      const subdirs = entries.filter(e => e.type === 'dir').map(e => e.name);
      console.log(`  dir ${dir}: ${entries.length} Eintraege, ${adm.length} .ADM, subdirs=[${subdirs.join(', ')}]`);
      if (adm.length > 0) return dir;
      for (const sd of subdirs) {
        const deep = `${dir.replace(/\/$/, '')}/${sd}`;
        try {
          const de = await client.listDir(serviceId, deep);
          const dadm = de.filter(e => e.type === 'file' && e.name.toLowerCase().endsWith('.adm'));
          console.log(`    dir ${deep}: ${de.length} Eintraege, ${dadm.length} .ADM`);
          if (dadm.length > 0) return deep;
        } catch { /* Diagnose ist best-effort pro Unterordner. */ }
      }
    } catch (e) {
      console.log(`  dir ${dir}: FEHLER ${(e as Error).message}`);
    }
  }
  return null;
}

async function main(): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler read-only Kandidatenscan; jeder Kandidat wird danach frisch per Guild+Connection unter Lock gelesen.
  const candidates = await prisma.nitradoConnection.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, guildId: true },
    orderBy: [{ guildId: 'asc' }, { slot: 'asc' }],
  });
  console.log(`[diag] ${candidates.length} aktive Verbindung(en)`);

  for (const candidate of candidates) {
    let snapshot: DiagSnapshot | null | 'BUSY';
    try {
      snapshot = await readDiagSnapshot(candidate);
    } catch (error) {
      console.log(`\n=== ${candidate.id} ===\n  SNAPSHOT-FEHLER ${(error as Error).message}`);
      continue;
    }
    if (snapshot === 'BUSY') {
      console.log(`\n=== ${candidate.id} ===\n  BUSY -> uebersprungen`);
      continue;
    }
    if (!snapshot) {
      console.log(`\n=== ${candidate.id} ===\n  nicht mehr ACTIVE oder keine kanonische Service-ID`);
      continue;
    }

    const svc = snapshot.nitradoServerId;
    console.log(`\n=== ${snapshot.alias} (guild ${snapshot.guildId}, service ${svc}) ===`);
    let token: string;
    try { token = decrypt(snapshot.encryptedToken, config.security.encryptionKey); }
    catch { console.log('  DECRYPT-FEHLER'); continue; }
    const client = new NitradoClient(token);

    try {
      const info = await client.getGameserverInfo(svc);
      console.log(`  game=${info.game} status=${info.status} username=${info.username}`);
      console.log(`  game_specific.path=${info.path || '(leer)'}`);
      const base = info.path || `/games/${info.username}/noftp`;
      const admDir = await findAdmDir(client, svc, base);
      if (admDir) {
        const files = await client.listAdmFiles(svc, admDir);
        console.log(`  >>> ADM-VERZEICHNIS: ${admDir}  (${files.length} .ADM-Dateien)`);
        for (const f of files.slice(-3)) console.log(`      ${f.name}  (${f.size}B, mtime ${f.modified_at})`);
      } else {
        console.log('  >>> KEIN ADM-Verzeichnis gefunden (Pfad manuell pruefen).');
      }
    } catch (e) {
      console.log(`  Server-Info-FEHLER: ${(e as Error).message}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[diag] Fehler:', (e as Error).message); process.exit(1); });
