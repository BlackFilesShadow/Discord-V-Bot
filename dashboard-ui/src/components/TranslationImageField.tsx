import { ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function TranslationImageField({ file, hasExisting, onFile, onRemove }: { file: File | null; hasExisting: boolean; onFile: (file: File | null) => void; onRemove: () => void }) {
  return <div className="rounded-md border border-border bg-bg-elev p-3 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-white hover:bg-white/5">
        <ImagePlus size={16} /> {hasExisting || file ? 'Bild ersetzen' : 'Bild auswählen'}
        <input className="hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={e => onFile(e.target.files?.[0] ?? null)} />
      </label>
      {(hasExisting || file) && <Button type="button" size="sm" variant="ghost" onClick={onRemove}>Bild entfernen</Button>}
    </div>
    {file ? <p className="text-xs text-white/80">Neu: {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</p> : hasExisting ? <p className="text-xs text-muted">Ein gespeichertes Bild ist hinterlegt und bleibt bestehen, bis du es ersetzt oder entfernst.</p> : <p className="text-xs text-muted">PNG, JPEG, GIF oder WebP · maximal 8 MB. Das Bild wird für geplante und wiederkehrende Posts dauerhaft gespeichert.</p>}
  </div>;
}
