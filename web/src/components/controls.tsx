import { useId, useState, type ReactNode } from 'react';
import type { Counts } from '@/api/types';
import { cn } from '@/lib/cn';

export function SegmentedControl<T extends string>({ label, options, value, onChange }:
  { label: string; options: { value: T; label: string }[]; value: T | null; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="segmented">
      {options.map(option => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Native button with aria-expanded; the label says what clicking does next. */
export function Disclosure({ label, expandedLabel, children, defaultOpen = false, className }:
  { label: string; expandedLabel: string; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div>
        <button type="button" className="btn btn-link" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
          {open ? expandedLabel : label}
        </button>
      </div>
      <div id={id} hidden={!open} className={open ? 'notice-enter' : undefined}>{open ? children : null}</div>
    </div>
  );
}

export type TileKey = 'different' | 'same' | 'cannotCompare';
const TILES: { key: TileKey; title: string; caption: string }[] = [
  { key: 'different', title: 'Different', caption: 'Where the two differ. Start here.' },
  { key: 'same', title: 'Same', caption: 'Identical within what was read' },
  { key: 'cannotCompare', title: 'Could not compare', caption: 'Not readable or not comparable; each says why' },
];

/** Summary-first strip. Toggle buttons filter a list; or anchor links on the report. */
export function SummaryTiles({ counts, active, onFilter, hrefs, captions, loading }:
  { counts: Counts | null; active?: TileKey | null; onFilter?: (key: TileKey | null) => void;
    hrefs?: Partial<Record<TileKey, string>>; captions?: Partial<Record<TileKey, string>>; loading?: boolean }) {
  return (
    <div className="flex flex-wrap gap-4" role="group" aria-label="Summary">
      {TILES.map(tile => {
        const count = counts ? counts[tile.key] : null;
        const body = (
          <>
            <span className={cn('tile-count', tile.key === 'different' && count ? '' : 'muted')}>{loading || count === null ? '–' : count}</span>
            <span className="font-semibold">{tile.title}</span>
            <span className="hint">{loading ? 'Reading…' : captions?.[tile.key] ?? tile.caption}</span>
          </>
        );
        const style = { flex: tile.key === 'different' ? '2 1 300px' : '1 1 200px' };
        const className = cn('tile', tile.key === 'different' && 'tile-primary');
        if (hrefs?.[tile.key]) return <a key={tile.key} href={hrefs[tile.key]} className={className} style={style}>{body}</a>;
        return (
          <button key={tile.key} type="button" className={className} style={style} disabled={loading}
            aria-pressed={active === tile.key} onClick={() => onFilter?.(active === tile.key ? null : tile.key)}>
            {body}
          </button>
        );
      })}
    </div>
  );
}
