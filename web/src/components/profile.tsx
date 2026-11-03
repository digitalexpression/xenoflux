import type { Side, SummaryPart } from '@/api/types';
import { cn } from '@/lib/cn';

/** Side colour marks which profile, never quality; always with the name. */
export function ProfileChip({ side, name, meta }: { side: Side; name: string; meta?: string }) {
  return (
    <span className={cn('chip', side === 'a' ? 'chip-a' : 'chip-b')}>
      <span className="chip-dot" aria-hidden="true" />
      <span className={cn('font-mono font-semibold wrap-anywhere', side === 'a' ? 'side-a' : 'side-b')}>{name}</span>
      {meta ? <span className="meta">{meta}</span> : null}
    </span>
  );
}

export function SideText({ side, children, className }: { side: Side; children: React.ReactNode; className?: string }) {
  return <span className={cn('font-semibold wrap-anywhere', side === 'a' ? 'side-a' : 'side-b', className)}>{children}</span>;
}

/** "medium → high" with each value in its side colour. */
export function SideValues({ a, b }: { a?: string; b?: string }) {
  if (a !== undefined && b !== undefined) return <span><SideText side="a">{a}</SideText> <span aria-hidden="true">→</span><span className="sr-only">changed to</span> <SideText side="b">{b}</SideText></span>;
  if (a !== undefined) return <SideText side="a">{a}</SideText>;
  if (b !== undefined) return <SideText side="b">{b}</SideText>;
  return null;
}

/** Side colours only on Different items; otherwise the parts read as plain text. */
export function SummaryText({ parts, colored }: { parts: SummaryPart[]; colored: boolean }) {
  return <>{parts.map((part, index) => part.side && colored ? <SideText key={index} side={part.side}>{part.text}</SideText> : <span key={index}>{part.text}</span>)}</>;
}
