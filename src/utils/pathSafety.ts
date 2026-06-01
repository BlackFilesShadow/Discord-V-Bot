import path from 'path';
import { config } from '../config';

/**
 * Zentrale Path-Boundary-Pruefung (P0-Haertung).
 *
 * Verhindert Path-Traversal: Ein aus der DB stammender oder anderweitig
 * manipulierter Dateipfad darf niemals ausserhalb eines erlaubten Root-
 * Verzeichnisses liegen. Wird ein Pfad ausserhalb erkannt, gilt er als
 * nicht vertrauenswuerdig.
 *
 * Implementierungshinweis: Vergleich erfolgt auf dem aufgeloesten,
 * normalisierten Pfad und mit angehaengtem Pfad-Separator, damit
 * `/uploads-evil` nicht faelschlich als innerhalb von `/uploads`
 * akzeptiert wird.
 */

/**
 * Prueft, ob `target` innerhalb von `root` liegt (inklusive `root` selbst).
 */
export function isInsideRoot(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot) return true;
  return resolvedTarget.startsWith(resolvedRoot + path.sep);
}

/**
 * Prueft, ob `target` innerhalb des Upload-Verzeichnisses (`config.upload.dir`)
 * liegt.
 */
export function isInsideUploadRoot(target: string): boolean {
  return isInsideRoot(target, config.upload.dir);
}

/**
 * Wirft, falls `target` nicht innerhalb von `root` liegt. Gibt den
 * aufgeloesten Pfad zurueck, damit Aufrufer direkt damit weiterarbeiten.
 */
export function assertInsideRoot(target: string, root: string): string {
  if (!isInsideRoot(target, root)) {
    throw new PathBoundaryError(target, path.resolve(root));
  }
  return path.resolve(target);
}

/**
 * Wirft, falls `target` nicht innerhalb des Upload-Verzeichnisses liegt.
 */
export function assertInsideUploadRoot(target: string): string {
  return assertInsideRoot(target, config.upload.dir);
}

/**
 * Fehler, der bei einer verletzten Pfadgrenze geworfen wird.
 */
export class PathBoundaryError extends Error {
  readonly target: string;
  readonly root: string;
  constructor(target: string, root: string) {
    super(`Pfad ausserhalb des erlaubten Verzeichnisses: ${path.resolve(target)} (Root: ${root})`);
    this.name = 'PathBoundaryError';
    this.target = path.resolve(target);
    this.root = root;
  }
}
