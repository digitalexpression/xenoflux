import { useId, useRef, useState } from 'react';
import type { ReviewTaskDecision, ReviewTaskPendingRequest } from '@/api/types';
import { Disclosure } from '@/components/controls';
import { Button } from '@/components/ui/button';

type Question = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean;
  options?: { label: string; description: string }[] | null };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const labels: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for this session',
  decline: 'Decline', cancel: 'Cancel native action' };

function decisionLabel(value: string | Record<string, unknown>) {
  if (typeof value === 'string') return labels[value] ?? value;
  if (value.acceptWithExecpolicyAmendment) return 'Allow with proposed command rule';
  const network = value.applyNetworkPolicyAmendment;
  if (object(network) && object(network.network_policy_amendment)) {
    const amendment = network.network_policy_amendment;
    return `Apply network rule: ${text(amendment.action)} ${text(amendment.host)}`;
  }
  return 'Apply proposed native decision';
}

function RecordedValue({ value }: { value: unknown }) {
  return <pre className="text-code whitespace-pre-wrap wrap-anywhere m-0">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

/** The server validates every response again against the owning native request. */
export function NativeReviewRequest({ request, busy, onRespond }: {
  request: ReviewTaskPendingRequest; busy: boolean; onRespond: (response: ReviewTaskDecision) => Promise<void>;
}) {
  const id = useId();
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const params = request.params;
  const input = request.method === 'item/tool/requestUserInput';
  const permissions = request.method === 'item/permissions/requestApproval';
  const claude = request.method === 'claude/tool/requestApproval';
  const files = request.method === 'item/fileChange/requestApproval';
  const command = request.method === 'item/commandExecution/requestApproval';
  const questions = input && Array.isArray(params.questions) ? params.questions as Question[] : [];
  const disabled = busy || pending;
  const choices: (string | Record<string, unknown>)[] = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((value): value is string | Record<string, unknown> => typeof value === 'string' || object(value))
    : ['accept', ...(params.kind === 'humanCommand' ? [] : ['acceptForSession']), 'decline', 'cancel'];
  if (command && !Array.isArray(params.availableDecisions)) {
    if (Array.isArray(params.proposedExecpolicyAmendment)) choices.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } });
    if (Array.isArray(params.proposedNetworkPolicyAmendments)) for (const amendment of params.proposedNetworkPolicyAmendments)
      choices.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
  }
  const chosenAnswer = (question: Question) => {
    const selected = answers[question.id];
    if (selected === undefined || selected === '') return '';
    if (question.options?.length) return selected === 'other' ? other[question.id] ?? '' : question.options[Number(selected)]?.label ?? '';
    return selected ?? '';
  };
  const allAnswered = questions.length > 0 && questions.every(question => chosenAnswer(question).trim());
  async function respond(response: ReviewTaskDecision) {
    if (disabled || sending.current) return;
    sending.current = true; setPending(true);
    try { await onRespond(response); }
    catch { /* The task panel retains the request and displays its response error. */ }
    finally { sending.current = false; setPending(false); }
  }

  return <section className="flex flex-col gap-3 min-w-0" aria-label="Native request">
    <h3 className="text-body font-semibold">{input ? 'Codex needs your input' : permissions ? 'Codex requests permissions' : files ? 'Codex requests file changes' : command ? 'Codex requests a command' : claude ? 'Claude Code requests a tool action' : 'Unsupported native request'}</h3>
    {text(params.reason) ? <p className="text-ui wrap-anywhere">{text(params.reason)}</p> : null}
    {text(params.cwd) ? <p className="text-ui wrap-anywhere"><strong>Working directory: </strong>{text(params.cwd)}</p> : null}
    {command ? <>
      {text(params.command) ? <RecordedValue value={params.command} /> : <p className="hint">Command text was not supplied. Inspect the native action details below before deciding.</p>}
      {params.commandActions != null ? <RecordedValue value={params.commandActions} /> : null}
      {params.networkApprovalContext != null ? <div><p className="text-ui font-medium">Requested network connection</p><RecordedValue value={params.networkApprovalContext} /></div> : null}
      {params.additionalPermissions != null ? <div><p className="text-ui font-medium">Additional permissions</p><RecordedValue value={params.additionalPermissions} /></div> : null}
    </> : null}
    {files ? <>
      {text(params.grantRoot) ? <p className="text-ui wrap-anywhere"><strong>Requested access root: </strong>{text(params.grantRoot)}</p> : null}
      {Array.isArray(request.item?.changes) ? request.item.changes.map((change: unknown, index: number) => object(change)
        ? <div key={index} className="flex flex-col gap-2 min-w-0">
          <p className="text-ui wrap-anywhere"><strong>{text(change.path) || 'Path not supplied'}</strong>{object(change.kind) ? ` · ${text(change.kind.type)}` : ''}</p>
          {object(change.kind) && text(change.kind.move_path) ? <p className="hint wrap-anywhere">Move to: {text(change.kind.move_path)}</p> : null}
          <RecordedValue value={typeof change.diff === 'string' ? change.diff : change} />
        </div> : <RecordedValue key={index} value={change} />)
        : <RecordedValue value={request.item ?? 'Native file-change details are unavailable.'} />}
    </> : null}
    {permissions ? <>
      <RecordedValue value={params.permissions} />
      <p className="hint">Allow only the permissions shown above for the selected duration, or decline them.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={() => void respond({ permissions: params.permissions as Record<string, unknown>, scope: 'turn' })}>Allow for this turn</Button>
        <Button disabled={disabled} onClick={() => void respond({ permissions: params.permissions as Record<string, unknown>, scope: 'session' })}>Allow for this session</Button>
        <Button disabled={disabled} onClick={() => void respond({ permissions: {}, scope: 'turn' })}>Decline permissions</Button>
      </div>
    </> : null}
    {claude ? <>
      {text(params.title) ? <p className="text-ui wrap-anywhere">{text(params.title)}</p> : null}
      <p className="text-ui wrap-anywhere">{text(params.toolName)}</p>
      {text(params.blockedPath) ? <p className="text-ui wrap-anywhere"><strong>Requested path: </strong>{text(params.blockedPath)}</p> : null}
      <RecordedValue value={params.input} />
    </> : null}
    {command || files || claude ? <>
      <div className="flex flex-col gap-3">{choices.map((decision, index) => <div key={index} className="flex flex-col gap-2 items-start">
        {typeof decision !== 'string' ? <RecordedValue value={decision} /> : null}
        <Button disabled={disabled || (files && !request.item)} onClick={() => void respond({ decision })}>{decisionLabel(decision)}</Button>
      </div>)}</div>
      {!choices.length ? <p className="hint">No response choices were supplied. You can cancel the review.</p> : null}
    </> : null}
    {input ? <form className="flex flex-col gap-4" onSubmit={event => {
      event.preventDefault();
      if (allAnswered) void respond({ answers: Object.fromEntries(questions.map(question => [question.id, { answers: [chosenAnswer(question)] }])) });
    }}>
      {questions.map((question, index) => <div key={question.id} className="flex flex-col gap-2">
        <label htmlFor={`${id}-${index}`} className="field-label">{question.question}</label>
        {question.options?.length ? <>
          <select className="input" id={`${id}-${index}`} value={answers[question.id] ?? ''} disabled={disabled} required
            aria-describedby={`${id}-${index}-options`} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}>
            <option value="" disabled>Choose an answer</option>
            {question.options.map((option, optionIndex) => <option key={optionIndex} value={optionIndex}>{option.label}</option>)}
            {question.isOther ? <option value="other">Other answer</option> : null}
          </select>
          <ul id={`${id}-${index}-options`} className="hint flex flex-col gap-1">{question.options.map((option, optionIndex) => <li key={optionIndex}>{option.label}: {option.description}</li>)}</ul>
          {answers[question.id] === 'other' ? <label className="flex flex-col gap-2" htmlFor={`${id}-${index}-other`}><span className="field-label">Other answer for {question.header}</span>
            <input className="input" id={`${id}-${index}-other`} type={question.isSecret ? 'password' : 'text'} autoComplete="off" required disabled={disabled}
              value={other[question.id] ?? ''} onChange={event => setOther(current => ({ ...current, [question.id]: event.target.value }))} /></label> : null}
        </> : <input className="input" id={`${id}-${index}`} type={question.isSecret ? 'password' : 'text'} autoComplete="off" required disabled={disabled}
          value={answers[question.id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />}
      </div>)}
      <div><Button type="submit" disabled={disabled || !allAnswered}>Send answers</Button></div>
      {!allAnswered ? <p className="hint">Answer each question before sending. Nothing is selected automatically.</p> : null}
    </form> : null}
    <Disclosure label="Show native request details" expandedLabel="Hide native request details"><RecordedValue value={{ method: request.method, ...params }} /></Disclosure>
  </section>;
}
