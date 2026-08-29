import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Faction media contract', () => {
  const routes = read('src/dashboard/routes/v2/factions.ts');
  const embed = read('src/modules/factions/factionEmbed.ts');
  const ui = read('dashboard-ui/src/components/FactionsTab.tsx');

  it('accepts only image/GIF uploads for Discord embed media', () => {
    expect(routes).toContain("const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])");
    expect(routes).toContain('Videos sind fuer Discord-Embed-Bilder nicht zulaessig');
    expect(routes).toContain("code: 'INVALID_ASSET_CONTENT'");
    expect(routes).toContain("code: 'ASSET_TOO_LARGE'");
  });

  it('exposes GIF uploads for flag, armband and the animated embed banner without advertising blocked MP4 uploads', () => {
    expect(ui).toContain("label=\"Embed-Banner (optional, GIF animiert) — JPG, PNG, GIF, WEBP · max. 25 MB\"");
    expect(ui).toContain("onUpload={f => handleUpload('mediaUrl', f)}");
    expect(ui).toContain('accept="image/jpeg,image/png,image/gif,image/webp"');
    expect(ui).not.toContain('accept="image/jpeg,image/png,image/gif,image/webp,video/mp4"');
  });

  it('materializes remote assets through the SSRF-safe fetch path and magic-byte validation', () => {
    expect(routes).toContain("safeAxiosGet(value");
    expect(routes).toContain("}, 'faction-asset')");
    expect(routes).toContain('detectImage(buffer)');
    expect(routes).toContain("parsed.protocol !== 'https:'");
    expect(routes).toContain('isBlockedHost(parsed.hostname)');
  });

  it('adopts draft assets into the exact guild/faction owner and rejects cross-faction references', () => {
    expect(routes).toContain("ownerId !== '_drafts' && ownerId !== factionId");
    expect(routes).toContain('Asset gehoert zu einer anderen Fraktion.');
    expect(routes).toContain('writePermanentAsset(guildId, factionId, kind');
    expect(routes).toContain('draftPath: sourcePath');
    expect(routes).toContain('cleanupPaths(assets.draftPaths)');
  });

  it('renders mediaUrl as the large Discord image with bannerUrl as fallback', () => {
    expect(embed).toContain('mediaUrl: string | null;');
    expect(embed).toContain('url: f.mediaUrl ?? f.bannerUrl');
    expect(embed).toContain('usableRemoteImageUrl(f.mediaUrl) ?? usableRemoteImageUrl(f.bannerUrl)');
    expect(embed).toContain('LEGACY_VIDEO_URL_RE');
  });
});
