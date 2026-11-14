import type { AgentEvidence, AgentSummary } from '@/lib/replay-agent-summary';
import { Button } from '@/components/ui/button';

export function ReplayAgentPanel({ name, profile, summary, onOpen }: {
  name: string; profile: string; summary: AgentSummary; onOpen: (evidence: AgentEvidence) => void;
}) {
  function source(item: AgentEvidence, label: string) {
    return <div className="flex flex-col gap-2">
      <p className="text-ui whitespace-pre-wrap break-words">{item.text}</p>
      <Button variant="ghost-link" onClick={() => onOpen(item)}>{label}</Button>
    </div>;
  }
  return <div className="replay-inspector-content flex flex-col gap-4">
    <p className="text-body font-semibold">{profile} · {name}</p>
    <section aria-label="Assignment" className="flex flex-col gap-2">
      <h3 className="text-body font-semibold">Assignment</h3>
      {summary.assignmentNote ? <p className="hint">{summary.assignmentNote}</p> : null}
      {summary.assignment ? source(summary.assignment, 'View assignment event') : null}
      {summary.parentAssignmentStatement ? <div className="flex flex-col gap-2">
        <p className="text-ui font-semibold">Parent's assignment statement</p>
        <p className="hint">Recorded parent statement before the linked spawn. It does not establish the exact delivered assignment wording.</p>
        {source(summary.parentAssignmentStatement, 'View parent assignment statement')}
      </div> : null}
      {summary.acknowledgement ? <div className="flex flex-col gap-2">
        <p className="text-ui font-semibold">Child's task acknowledgement</p>
        <p className="hint">The child's opening statement before recorded tool activity. It does not recover the exact delivered assignment wording.</p>
        {source(summary.acknowledgement, 'View child acknowledgement')}
      </div> : null}
      {summary.taskContext ? <details><summary className="cursor-pointer text-ui">Opening task (context)</summary>
        {source(summary.taskContext, 'View opening task event')}</details> : null}
    </section>
    <section aria-label="Result" className="flex flex-col gap-2">
      <h3 className="text-body font-semibold">Result</h3>
      {summary.resultNote ? <p className="hint">{summary.resultNote}</p> : null}
      {summary.result ? <><p className="hint">Recorded response. Completion does not establish that its checks passed.</p>{source(summary.result, 'View result event')}</> : null}
    </section>
    <section aria-label="Parent use" className="flex flex-col gap-2">
      <h3 className="text-body font-semibold">How the parent used it</h3>
      {summary.parentNote ? <p className="hint">{summary.parentNote}</p> : null}
      {summary.received ? <div className="flex flex-col gap-2"><p className="text-ui">The parent received this result.</p>
        <Button variant="ghost-link" onClick={() => onOpen(summary.received!)}>View parent receipt</Button></div> : null}
      {summary.parentActions.length ? <p className="hint">After receipt, recorded parent commands reference a file written by this child. This links the actions to the artifact; it does not establish causality or overall verification.</p> : null}
      {summary.parentActions.map((item, index) => <div key={`${item.command.event.id}:${item.artifactPath}`} className="flex flex-col gap-2">
        <p className="text-ui break-words">Child-written file: {item.artifactPath}</p>
        {source(item.command, `View parent command ${index + 1}`)}
        <p className="meta">Recorded whole-command exit code: {item.exitCode}</p>
        <details><summary className="cursor-pointer text-ui">Full recorded command</summary>
          <pre className="text-ui whitespace-pre-wrap break-words">{item.recordedCommand}</pre></details>
        {item.output ? <details><summary className="cursor-pointer text-ui">Recorded command output excerpt</summary>
          <pre className="text-ui whitespace-pre-wrap break-words">{item.output}</pre></details> : null}
        <Button variant="ghost-link" onClick={() => onOpen(item.childChange)}>View child file change {index + 1}</Button>
      </div>)}
      {summary.followUps.length ? <p className="hint">Parent statements naming this agent; integration is not independently verified.</p> : null}
      {summary.followUps.map((item, index) => <div key={item.event.id}>{source(item, `View parent follow-up ${index + 1}`)}</div>)}
    </section>
  </div>;
}
