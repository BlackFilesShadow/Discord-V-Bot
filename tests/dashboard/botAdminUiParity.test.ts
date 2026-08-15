import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'dashboard-ui/src/components/BotAdminCommandCenter.tsx'),
  'utf8',
);

describe('Bot-Admin UI parity and mobile safety', () => {
  it('verwendet verifizierte Trigger-Channel-Optionen statt frei eingegebener Channel-IDs', () => {
    expect(source).toContain('interface TriggerListResponse');
    expect(source).toContain('channelOptions: Array<{ id: string; name: string; type: number }>');
    expect(source).toContain('list.data?.channelOptions');
    expect(source).toContain('Alle erlaubten Channels');
    expect(source).not.toContain('placeholder="Channel-ID optional"');
  });

  it('verwirft die Trigger-Channel-Auswahl beim Guild-Wechsel', () => {
    expect(source).toContain('useEffect(() => {');
    expect(source).toContain("setChannelId('')");
    expect(source).toContain('}, [guildId]);');
  });

  it('laedt bestehende Feedback-Channelwerte und bietet Guild-Channels als Auswahl an', () => {
    expect(source).toContain('interface FeedbackChannelResponse');
    expect(source).toContain("setGlobalChannel(cfg.data.globalChannelId ?? '')");
    expect(source).toContain("setGuildChannel(cfg.data.guildChannelId ?? '')");
    expect(source).toContain('cfg.data?.channelOptions');
    expect(source).toContain('Guild-Feedback deaktivieren');
    expect(source).toContain('(nicht erreichbar)');
  });

  it('fordert echte CLEAR-/DELETE-Eingaben statt fest codierter Ein-Klick-Bestaetigung', () => {
    expect(source).toContain('confirm: clearConfirm');
    expect(source).toContain("disabled={clearConfirm !== 'CLEAR'}");
    expect(source.match(/confirm: deleteConfirm/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("deleteConfirm !== 'DELETE'");
    expect(source).toContain("api.del(`${center}/uploads/${uploadId}`, { confirm: deleteConfirm })");
    expect(source).not.toContain("confirm: 'CLEAR'");
    expect(source).not.toContain("confirm: 'DELETE'");
  });

  it('stapelt kritische Maintenance-Aktionen auf kleinen Displays', () => {
    expect(source.match(/sm:grid-cols-\[minmax\(0,1fr\)_auto_auto\]/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('disabled={!packageId || deleteConfirm !==');
    expect(source).toContain('disabled={!uploadId || deleteConfirm !==');
    expect(source).toContain('disabled={!userId || deleteConfirm !==');
  });

  it('vermeidet starre horizontale Server- und Feedback-Zeilen auf Mobil', () => {
    expect(source).toContain('flex flex-col items-stretch gap-2 sm:flex-row sm:items-center');
    expect(source.match(/flex flex-col gap-2 sm:flex-row/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
