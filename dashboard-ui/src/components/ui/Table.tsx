/**
 * Generic enterprise data table.
 *
 * - Sticky header
 * - Density-aware (CSS-Vars setzen Padding/Font)
 * - Optional Sortierung pro Column
 * - Optional Row-Click
 * - Server-driven pagination NICHT im Lieferumfang (Page-Specific).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { twMerge } from 'tailwind-merge';

export interface Column<T> {
  id: string;
  header: ReactNode;
  /** Wert-Renderer (Default: row[id] als String). */
  cell?: (row: T) => ReactNode;
  /** Comparator fuer Sortierung. Default: lexicographic per cell-Render. */
  sortFn?: (a: T, b: T) => number;
  /** Wenn true, Spalte wird als Zahlen-Spalte (rechtsbuendig, mono) gerendert. */
  numeric?: boolean;
  /** Tailwind-Klassen fuer die td. */
  className?: string;
  /** Tailwind-Klassen fuer die th. */
  headerClassName?: string;
}

interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  className?: string;
  /** Initiale Sortierung. */
  defaultSort?: { id: string; dir: 'asc' | 'desc' };
}

export function DataTable<T>({
  columns, rows, rowKey, empty, onRowClick, className, defaultSort,
}: TableProps<T>) {
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.id === sort.id);
    if (!col || !col.sortFn) return rows;
    const arr = [...rows].sort(col.sortFn);
    return sort.dir === 'desc' ? arr.reverse() : arr;
  }, [rows, columns, sort]);

  const toggleSort = (id: string): void => {
    setSort(prev => {
      if (!prev || prev.id !== id) return { id, dir: 'asc' };
      if (prev.dir === 'asc') return { id, dir: 'desc' };
      return null;
    });
  };

  if (rows.length === 0 && empty !== undefined) {
    return <>{empty}</>;
  }

  return (
    <div className={twMerge('overflow-auto rounded-lg border border-white/[0.06]', className)}>
      <table className="table-enterprise">
        <thead>
          <tr>
            {columns.map(c => {
              const sortable = !!c.sortFn;
              const active = sort?.id === c.id;
              return (
                <th
                  key={c.id}
                  className={twMerge(c.numeric && 'text-right', c.headerClassName)}
                  scope="col"
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.id)}
                      className="inline-flex items-center gap-1 hover:text-white focus-ring rounded"
                    >
                      {c.header}
                      {active
                        ? (sort?.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                        : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'cursor-pointer' : undefined}
            >
              {columns.map(c => (
                <td key={c.id} className={twMerge(c.numeric && 'col-num', c.className)}>
                  {c.cell ? c.cell(row) : String((row as unknown as Record<string, unknown>)[c.id] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
