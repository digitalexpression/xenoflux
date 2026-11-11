# Audit acceptance criteria

These criteria describe observable behavior, not a record of completed checks.
The [product goal](AUDIT-GOAL.md) owns supported scope; the
[developer guide](README.md#checkout-and-checks) lists reusable checks.

| Area | Required observation |
| --- | --- |
| Profiles | Empty and selected-parts creation use visible controls and native sign-in guidance. Preview/cancel preserves state; selected changes preserve unrelated data and support exact Undo. |
| Comparison | Both sides use the declared task, starting revision and settings. Progress, responses, checks, replay and missing evidence remain inspectable. No checks means unverified. |
| Ordinary review | Explicit Start submits once with frozen report inputs and the selected profile. Its captured response and failures retain exact task/report association. Browsing never starts work. |
| Ownership and approvals | Concurrent jobs retain separate sessions, requests and workspaces. Only a matching live user response is consumed once; stale, duplicate or wrong-job replies are refused. |
| Cancellation and recovery | Stop only owned work. Record native acknowledgement, completion, capture and physical shutdown separately. Uncertain ownership retains claims; restart never resends or resumes automatically. |
| Evidence | Export/reopen preserves supported saved evidence after source loss. Missing settings, actors, usage or completion stay unknown; an import is not a successful task. |
| Privacy and local web security | Normal exports omit recorded bodies; explicit inclusion applies redaction and bounds. Local APIs enforce session/Host/Origin guards, and native text remains untrusted data. |
| Delivery | Affected regressions, required engine checks and bundled UI checks pass for the changed source. Verify keyboard behavior, narrow layouts and both themes; inspect actual package contents and isolated installation behavior. |

Use fixtures for protocol failures, unsafe paths and deterministic edge cases.
Real native evidence is needed for changed launch, authentication, approval and
shutdown claims; fixtures, catalog observations or test counts do not prove the
complete user journey. Reuse observations only while their source and behavior
remain applicable. Preserve failed controls and distinguish targeted reruns from
a clean full check.

Retain explicit scope limits from the [app guide](../user/APP.md#400-scope-and-limits).
Deferred or unobserved native checks are not passes. One task pair establishes
neither repeatability, general superiority nor cost guarantees. Documentation
and verification criteria grant no authority for native operations, publication
or installed updates.
