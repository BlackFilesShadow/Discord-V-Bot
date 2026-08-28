import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy Emoji-/Emote-Auswahl — Dashboard-Gate', () => {
  const serverSlot = read('dashboard-ui/src/pages/ServerSlot.tsx');
  const virtualAccounts = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
  const picker = read('dashboard-ui/src/components/ui/EmojiPicker.tsx');

  it('verwendet fuer die Server-Waehrung den zentralen EmojiPicker', () => {
    expect(serverSlot).toContain("import { EmojiPicker } from '@/components/ui/EmojiPicker'");
    expect(serverSlot).toContain('<EmojiPicker value={draft.emoji}');
  });

  it('verwendet fuer virtuelle Waehrung und Konto ebenfalls den zentralen Picker', () => {
    expect(virtualAccounts).toContain("import { EmojiPicker } from '@/components/ui/EmojiPicker'");
    expect(virtualAccounts).toContain('<EmojiPicker value={draft.currencyEmoji}');
    expect(virtualAccounts).toContain('<EmojiPicker value={draft.accountEmoji}');
  });

  it('unterstuetzt Unicode sowie statische und animierte Discord-Custom-Emotes', () => {
    expect(picker).toContain('EMOJI_CATEGORIES');
    expect(picker).toContain('ALL_EMOJIS');
    expect(picker).toContain('/^<a?:\\w+:\\d{17,20}>$/');
  });
});
