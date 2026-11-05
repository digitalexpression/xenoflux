import { useId } from 'react';
import type { ExecutionSelection } from '@/api/types';

export function ExecutionFields({ value, onChange, disabled }: {
  value: ExecutionSelection; onChange: (value: ExecutionSelection) => void; disabled?: boolean;
}) {
  const id = useId();
  return <div className="flex flex-wrap gap-3">
    <div className="flex-1 min-w-[140px]">
      <label className="field-label" htmlFor={`${id}-model`}>Model ID</label>
      <input id={`${id}-model`} className="input font-mono" placeholder="Use profile default" maxLength={100}
        value={value.model ?? ''} disabled={disabled} onChange={event => onChange({ ...value, model: event.target.value || undefined })} />
    </div>
    <div className="flex-1 min-w-[140px]">
      <label className="field-label" htmlFor={`${id}-effort`}>Reasoning effort</label>
      <select id={`${id}-effort`} className="input" value={value.reasoningEffort ?? ''} disabled={disabled}
        onChange={event => onChange({ ...value, reasoningEffort: event.target.value || undefined })}>
        <option value="">Use profile default</option>
        {['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(effort => <option key={effort}>{effort}</option>)}
      </select>
    </div>
  </div>;
}
