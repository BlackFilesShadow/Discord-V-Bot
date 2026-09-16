import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';

interface DiscordMember {
  discordId: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

function avatarUrl(member: { discordId: string; avatar: string | null }): string {
  if (member.avatar) return `https://cdn.discordapp.com/avatars/${member.discordId}/${member.avatar}.png?size=64`;
  try { return `https://cdn.discordapp.com/embed/avatars/${(BigInt(member.discordId) >> 22n) % 6n}.png`; }
  catch { return 'https://cdn.discordapp.com/embed/avatars/0.png'; }
}

/** Guild-Mitglieder-Suche + Auswahl fuer Kontoverwalter beliebiger virtueller Konten (CUSTOM, Serverbank, Haendler). */
export function ManagerPicker({
  guildId,
  slot,
  managers,
  onChange,
  disabled,
}: {
  guildId: string;
  slot: string;
  managers: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const members = useQuery({
    queryKey: ['economy-virtual-manager-members', guildId, slot, query],
    queryFn: () => api.get<{ members: DiscordMember[] }>(
      `/api/v2/guilds/${guildId}/economy/virtual-accounts/control/members?slot=${encodeURIComponent(slot)}&limit=20${query ? `&q=${encodeURIComponent(query)}` : ''}`,
    ),
    placeholderData: previous => previous,
    retry: false,
  });
  const options = useMemo<ComboboxOption[]>(() => (members.data?.members ?? [])
    .filter(member => !managers.includes(member.discordId))
    .map(member => ({
      id: member.discordId,
      label: member.displayName || member.username,
      hint: member.discordId,
      avatar: avatarUrl(member),
    })), [members.data?.members, managers]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {managers.length === 0 && <span className="text-xs text-muted">Keine Kontoverwalter zugewiesen.</span>}
        {managers.map(id => (
          <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-bg-elev px-2.5 py-1 text-[11px] text-white">
            <span className="truncate">{id}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(managers.filter(value => value !== id))}
              className="rounded px-1 text-muted hover:text-danger disabled:opacity-40"
              aria-label={`Kontoverwalter ${id} entfernen`}
            >×</button>
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Combobox
          value={selected}
          onChange={(id) => setSelected(id)}
          options={options}
          onSearch={setQuery}
          loading={members.isFetching}
          disabled={disabled}
          placeholder="Guild-Mitglied suchen…"
          emptyText="Kein menschliches Mitglied gefunden."
          className="flex-1"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !selected || managers.includes(selected)}
          onClick={() => {
            if (!selected) return;
            onChange([...managers, selected]);
            setSelected(null);
            setQuery('');
          }}
        >
          <Users className="h-3.5 w-3.5 mr-1" />Hinzufügen
        </Button>
      </div>
      {members.isError && <p className="text-[11px] text-danger">Member-Suche nicht verfügbar: {(members.error as Error).message}</p>}
    </div>
  );
}
