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

## Beta-exit checklist

Use this checklist to review promotion from the 4.0.0 beta line to stable 4.0.0.
It describes required observations, not completed work. Record source-bound
results, open blockers, evidence limits and the promotion decision for the exact
candidate. Green CI or a beta package version alone does not complete this review.

- [ ] **Installed-user setup:** follow the published installation and native
  sign-in guidance on Apple Silicon using the packaged app and supported
  prerequisites. Reach a usable profile without a checkout, development server,
  private harness, authored JSON or maintainer-only transfer step.
- [ ] **Core web journey:** for every advertised CLI client, create/select a
  profile, discover models, preview/start a comparison, read responses/checks,
  explicitly request an ordinary review, then export and reopen its evidence.
  Verify documented same-client copy/Undo and the retained mixed-client scope.
  Distinguish current native observations from fixtures and applicable prior proof.
- [ ] **Failures and recovery:** signed-out, rate-limited, unsupported, busy and
  changed-context states provide an understandable next action. Exact approvals,
  pending/running cancellation, shutdown and restart preserve independent work
  without duplicate submission or automatic resume. Uncertain state stays visible.
- [ ] **Preservation and privacy:** verify the existing acceptance criteria for
  unrelated profiles/clients, credentials, workspaces, copy/Undo, local web access
  and default/explicit-content export. No known data-loss, security or privacy
  blocker remains in the supported journey.
- [ ] **Usable guidance:** install, setup, supported operations, limitations and
  recovery instructions agree with the actual UI/CLI. Keyboard navigation, narrow
  layouts and both themes pass the required checks. Track and resolve remaining
  blocking user-facing issues; this requires no uncoached participant study.
- [ ] **Release delivery:** required local/hosted checks and source-bound npm,
  offline and managed-install fixtures pass on the combined source. Review actual
  artifacts, SDK/native dependencies and licenses, architecture, public-input
  boundaries and channel/version metadata. Retain failed controls and provenance.
- [ ] **Explicit stable decision:** review the documented native gaps, including
  credential refresh, expanded pair/mode and overlap checks, controller-kill
  reviews, copied-setup native loading, distinct-account independence and any
  synthetic-only Desktop claims. Keep accepted deferrals explicit; this checklist
  does not silently reinstate them or turn them into passes. Record which limits
  remain acceptable for the stable supported scope before separately authorizing
  promotion, publication or installed updates.
