export interface AdmRemoteFile {
  name: string;
  modified_at: number;
  size: number;
  path?: string;
}

export interface NitradoListedEntryLike {
  name: string;
  type: string;
  modified_at: number;
  size: number;
  path?: string;
}

/**
 * Behält bei ADM-Listings den von Nitrado gelieferten kanonischen Remote-Pfad.
 * Der FileServer kann logische Verzeichnisse auf interne Mount-/noftp-Pfade
 * abbilden; ein rekonstruiertes `${profileDir}/${name}` muss deshalb nicht mit
 * dem Download-Pfad identisch sein.
 */
export function selectAdmRemoteFiles(entries: NitradoListedEntryLike[]): AdmRemoteFile[] {
  return entries
    .filter(entry => entry.type === 'file' && entry.name.toLowerCase().endsWith('.adm'))
    .map(entry => {
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      return {
        name: entry.name,
        modified_at: entry.modified_at,
        size: entry.size,
        ...(path ? { path } : {}),
      };
    });
}

/**
 * Nutzt bevorzugt `entry.path` aus Nitrados file_server/list. Nur wenn Nitrado
 * keinen brauchbaren Pfad liefert, bleibt das bisherige profileDir/name-Verhalten
 * als kompatibler Fallback erhalten.
 */
export function resolveAdmRemoteFilePath(profileDir: string, file: AdmRemoteFile): string {
  const listedPath = typeof file.path === 'string' ? file.path.trim() : '';
  if (listedPath && !/[\r\n\0]/.test(listedPath)) return listedPath;

  const base = profileDir.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return `${base}/${file.name}`;
}
