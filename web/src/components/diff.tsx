import type { DiffLine } from '@/api/types';
import { SideText } from './profile';

const HIDDEN = { '-': 'Removed: ', '+': 'Added: ', '~': 'Changed: ', ' ': '' } as const;
const SIGN = { '-': '−', '+': '+', '~': '~', ' ': '' } as const;

/** Lines only on one side use that side's tint and edge, not green/red. */
export function DiffBlock({ lines, a, b, label }: { lines: DiffLine[]; a: string; b: string; label?: string }) {
  return (
    <figure className="flex flex-col gap-2">
      <div className="diff" role="group" aria-label={label ?? 'Line differences'}>
        {lines.map((line, index) => (
          <div key={index} className="diff-line" data-kind={line.kind}>
            <span className="diff-sign" aria-hidden="true">{SIGN[line.kind]}</span>
            <span><span className="sr-only">{HIDDEN[line.kind]}</span>{line.text || ' '}</span>
          </div>
        ))}
      </div>
      <figcaption className="meta">
        − only in <SideText side="a">{a}</SideText> · + only in <SideText side="b">{b}</SideText>
      </figcaption>
    </figure>
  );
}
