/**
 * Diagnose: ermittelt fuer aktive Nitrado-Verbindungen die Server-Stammdaten und
 * sucht das ADM-Verzeichnis (wo die .ADM-Logs liegen). Gibt NIE den Token aus.
 * Ausfuehrung im Container:  node dist/src/scripts/nitradoDiag.js
 */
import prisma from '../database/prisma';
import { config } from '../config';
import { decrypt } from '../utils/security';
import { NitradoClient } from '../modules/nitrado/nitradoClient';

// Kandidaten-Unterordner fuer DayZ-Profile/Configs (Plattformen), relativ zum Spielpfad.
const CANDIDATE_SUBDIRS = ['', 'config', 'profiles', 'dayzxb', 'dayzps', 'dayzstandalone'];

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
      // Eine Ebene tiefer in gefundene Unterordner schauen.
      for (const sd of subdirs) {
        const deep = `${dir.replace(/\/$/, '')}/${sd}`;
        try {
          const de = await client.listDir(serviceId, deep);
          const dadm = de.filter(e => e.type === 'file' && e.name.toLowerCase().endsWith('.adm'));
          console.log(`    dir ${deep}: ${de.length} Eintraege, ${dadm.length} .ADM`);
          if (dadm.length > 0) return deep;
        } catch { /* ignore */ }
      }
    } catch (e) {
      console.log(`  dir ${dir}: FEHLER ${(e as Error).message}`);
    }
  }
  return null;
}

async function main(): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Diagnose ueber alle Guilds; nur Lesevorgaenge.
  const conns = await prisma.nitradoConnection.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, guildId: true, alias: true, nitradoServerId: true, serviceId: true, encryptedToken: true },
  });
  console.log(`[diag] ${conns.length} aktive Verbindung(en)`);

  for (const c of conns) {
    const svc = c.serviceId ?? c.nitradoServerId;
    console.log(`\n=== ${c.alias} (guild ${c.guildId}, service ${svc}) ===`);
    if (!svc) { console.log('  keine Service-ID'); continue; }
    let token: string;
    try { token = decrypt(c.encryptedToken, config.security.encryptionKey); }
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
