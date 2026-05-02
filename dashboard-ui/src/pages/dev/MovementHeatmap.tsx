import { AdmToolPage } from '@/components/AdmToolPage';

interface Cell { x: number; y: number; weight: number }

export default function MovementHeatmap() {
  return (
    <AdmToolPage<Cell[]>
      title="Movement Heatmap"
      desc="Aggregierte Positions-Hits in 100m-Zellen. Top 50 als Tabelle, ASCII-Visualisierung."
      tool="heatmap"
      render={(data) => {
        // ASCII-Mini-Heatmap (16x16) ueber max-Bereich.
        const W = 32, H = 16;
        const xs = data.map(c => c.x), ys = data.map(c => c.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const grid: number[][] = Array.from({ length: H }, () => Array(W).fill(0));
        let maxW = 0;
        for (const c of data) {
          const gx = Math.floor(((c.x - minX) / (maxX - minX || 1)) * (W - 1));
          const gy = H - 1 - Math.floor(((c.y - minY) / (maxY - minY || 1)) * (H - 1));
          grid[gy][gx] += c.weight;
          if (grid[gy][gx] > maxW) maxW = grid[gy][gx];
        }
        const SHADES = ['·', '░', '▒', '▓', '█'];
        return (
          <div className="space-y-3">
            <pre className="text-[10px] font-mono leading-3 bg-bg/50 p-2 rounded-md border border-border/30">
              {grid.map(row => row.map(v => SHADES[Math.min(SHADES.length - 1, Math.floor((v / (maxW || 1)) * SHADES.length))]).join('')).join('\n')}
            </pre>
            <table className="w-full text-xs">
              <thead className="text-muted"><tr><th className="text-right">X</th><th className="text-right">Y</th><th className="text-right">Gewicht</th></tr></thead>
              <tbody>
                {data.slice(0, 50).map((c, i) => (
                  <tr key={i} className="border-t border-border/20">
                    <td className="text-right font-mono">{c.x.toFixed(0)}</td>
                    <td className="text-right font-mono">{c.y.toFixed(0)}</td>
                    <td className="text-right">{c.weight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }}
    />
  );
}
