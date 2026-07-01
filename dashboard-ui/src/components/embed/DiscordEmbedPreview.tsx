/**
 * Discord-getreue Live-Vorschau eines Embeds. Rein visuell — spiegelt die
 * Felder des Embed-Builders wider, ohne eigene Datenlogik.
 *
 * Wird vom EmbedBuilderTab (und spaeter Reaktions-Embeds) genutzt.
 */

export interface EmbedPreviewField {
  name: string;
  value: string;
  inline: boolean;
}

export interface EmbedPreviewData {
  content?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: string | null;
  authorName?: string | null;
  authorIconUrl?: string | null;
  authorUrl?: string | null;
  footerText?: string | null;
  footerIconUrl?: string | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  showTimestamp?: boolean;
  fields?: EmbedPreviewField[];
}

/** #RRGGBB / #AARRGGBB -> gueltige CSS-Farbe, sonst Discord-Default. */
function cssColor(hex: string | null | undefined): string {
  const v = (hex ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
  if (/^[0-9a-fA-F]{8}$/.test(v)) return `#${v.slice(2)}`; // AARRGGBB -> RRGGBB
  return '#4f545c';
}

const MENTION_RE = /(<#\d{17,20}>|<@!?\d{17,20}>|<@&\d{17,20}>)/g;

/** Rendert Text mit Zeilenumbruechen + Discord-Mention-Pills (rein optisch). */
function renderRich(text: string, channels?: Record<string, string>): React.ReactNode {
  const parts = text.split(MENTION_RE);
  return parts.map((part, i) => {
    const ch = /^<#(\d{17,20})>$/.exec(part);
    if (ch) {
      const name = channels?.[ch[1]] ?? 'channel';
      return (
        <span key={i} className="rounded px-1 bg-[#5865f2]/30 text-[#c9cdfb]">
          #{name}
        </span>
      );
    }
    if (/^<@&\d{17,20}>$/.test(part)) {
      return <span key={i} className="rounded px-1 bg-[#5865f2]/30 text-[#c9cdfb]">@role</span>;
    }
    if (/^<@!?\d{17,20}>$/.test(part)) {
      return <span key={i} className="rounded px-1 bg-[#5865f2]/30 text-[#c9cdfb]">@user</span>;
    }
    return <span key={i}>{part}</span>;
  });
}

export function DiscordEmbedPreview({
  data,
  channels,
}: {
  data: EmbedPreviewData;
  channels?: Record<string, string>;
}) {
  const fields = (data.fields ?? []).filter(f => f.name.trim() || f.value.trim());
  const hasEmbed =
    !!(data.title || '').trim() ||
    !!(data.description || '').trim() ||
    !!(data.authorName || '').trim() ||
    !!(data.footerText || '').trim() ||
    !!(data.thumbnailUrl || '').trim() ||
    !!(data.imageUrl || '').trim() ||
    fields.length > 0;

  const content = (data.content ?? '').trim();
  const timestamp = data.showTimestamp
    ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date())
    : '';

  return (
    <div className="rounded-lg bg-[#313338] p-4 font-sans text-[#dbdee1]" aria-label="Embed-Vorschau">
      {/* Nachrichtentext ausserhalb des Embeds */}
      {content && (
        <div className="mb-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
          {renderRich(content, channels)}
        </div>
      )}

      {!hasEmbed && !content && (
        <p className="text-sm text-[#949ba4] italic">Noch kein Inhalt — fülle links den Editor aus.</p>
      )}

      {hasEmbed && (
        <div
          className="relative max-w-[520px] rounded border-l-4 bg-[#2b2d31] py-3 pl-3 pr-4"
          style={{ borderLeftColor: cssColor(data.color) }}
        >
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              {/* Author */}
              {(data.authorName || '').trim() && (
                <div className="mb-1.5 flex items-center gap-2">
                  {(data.authorIconUrl || '').trim() && (
                    <img src={data.authorIconUrl!} alt="" className="h-6 w-6 rounded-full object-cover" />
                  )}
                  {(data.authorUrl || '').trim() ? (
                    <a href={data.authorUrl!} target="_blank" rel="noreferrer" className="text-sm font-semibold text-white hover:underline">
                      {data.authorName}
                    </a>
                  ) : (
                    <span className="text-sm font-semibold text-white">{data.authorName}</span>
                  )}
                </div>
              )}

              {/* Title */}
              {(data.title || '').trim() && (
                (data.url || '').trim() ? (
                  <a href={data.url!} target="_blank" rel="noreferrer" className="mb-1 block text-base font-semibold text-[#00a8fc] hover:underline">
                    {data.title}
                  </a>
                ) : (
                  <div className="mb-1 text-base font-semibold text-white">{data.title}</div>
                )
              )}

              {/* Description */}
              {(data.description || '').trim() && (
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#dbdee1]">
                  {renderRich(data.description!, channels)}
                </div>
              )}

              {/* Fields */}
              {fields.length > 0 && (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {fields.map((f, i) => (
                    <div key={i} className={f.inline ? '' : 'sm:col-span-2'}>
                      <div className="text-xs font-semibold text-white">{f.name || '\u200b'}</div>
                      <div className="whitespace-pre-wrap break-words text-sm text-[#dbdee1]">
                        {renderRich(f.value || '\u200b', channels)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Thumbnail */}
            {(data.thumbnailUrl || '').trim() && (
              <img src={data.thumbnailUrl!} alt="" className="h-16 w-16 shrink-0 rounded object-cover" />
            )}
          </div>

          {/* Image */}
          {(data.imageUrl || '').trim() && (
            <img src={data.imageUrl!} alt="" className="mt-3 max-h-64 w-full rounded object-cover" />
          )}

          {/* Footer */}
          {((data.footerText || '').trim() || timestamp) && (
            <div className="mt-2 flex items-center gap-2">
              {(data.footerIconUrl || '').trim() && (
                <img src={data.footerIconUrl!} alt="" className="h-5 w-5 rounded-full object-cover" />
              )}
              <span className="text-xs text-[#949ba4]">
                {(data.footerText || '').trim()}
                {(data.footerText || '').trim() && timestamp ? ' • ' : ''}
                {timestamp}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
