import * as React from 'react';
import { useId, useState } from 'react';

/** Describes its one child on hover and keyboard focus; Escape dismisses it. */
export function Tooltip({ content, children }: { content: React.ReactNode; children: React.ReactElement<React.HTMLAttributes<HTMLElement>> }) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  const child = React.cloneElement(children, {
    'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' '),
    onFocus: (event: React.FocusEvent<HTMLElement>) => { children.props.onFocus?.(event); if (event.currentTarget.matches(':focus-visible')) { setFocused(true); setDismissed(false); } },
    onBlur: (event: React.FocusEvent<HTMLElement>) => { children.props.onBlur?.(event); setFocused(false); },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { children.props.onKeyDown?.(event); if (event.key === 'Escape' && open) setDismissed(true); },
  });
  return (
    <span className="tooltip-anchor" onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)}>
      {child}
      <span id={id} role="tooltip" className="tooltip-bubble" hidden={!open}>{content}</span>
    </span>
  );
}
