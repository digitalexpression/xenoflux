# Claude/Copilot follow-up — 2026-11-10

**Outcome: current-account approval, running cancellation and companion completion
were observed for both clients; stored public-conversation import passed for
Copilot.** These private harness results do not qualify a product execution
adapter, independent accounts, restart recovery or SDK/ACP execution parity.
Initial source: `f36fe68`; import implementation: `c415f07`; final Copilot retry
recorded at `1d1e622`. The [roadmap](../ROADMAP.md) owns current status and the
[plan](../CLIENT-SUPPORT-PLAN.md) owns product contracts.

Exact native/job identities, prompts, process observations, raw receipts and full
original records remain private. Each evidence locator below retains its frozen
sources and source/artifact hashes. Stopped/false receipts were preserved;
derived assessments and later attempts do not amend them.

## Execution and cancellation results

Unless noted, native tasks used existing connections, 180 seconds/8 MiB per
actor, exact one-action approvals and zero host continuation/resume. No policy,
account, sign-in or Codex batch change was used. Claude SDK 0.3.322/CLI 2.1.319
used Pro; Copilot SDK 1.0.29/CLI 1.0.107/protocol 3 used implicit `gh-cli` and
Auto/balance. Requested effort does not establish applied effort; Copilot account
plan remains unknown. Prompt bounds below overlap only where explicitly stated.

| Phase and private evidence locator | Outcome, failed control and limit |
| --- | --- |
| Initial controls: `local/client-followup-2026-11-10/`, `local/client-followup2-2026-11-10/`, `local/client-followup3-2026-11-10/` | Two initial Copilot prompts stopped separately: broad SDK outcome `approved` was rejected natively; later `approve-once` succeeded but a distinct command handle was misclassified as duplicate. Neither proof action ran. A zero-prompt direct-tool probe returned tool unavailable; no fallback ran within it. This does not disprove model-driven shell availability. |
| Final controls at `c415f07`: `local/client-followup-final-2026-11-10/` | The remaining two prompts exhausted the four-prompt phase. Separate path/command approvals completed the 19-byte proof; a copied 18-byte expectation falsely failed parent grading. Offline assessment verified success without replay. One recovery dispatched only the original unstarted cancellation job. Nullable static tokens caused guard refusal and native abort; held-pending/running cancellation stayed unqualified in this phase. |
| Fresh cancellation at `53888b8`: `local/client-cancellation-2026-11-10/` | Three of four prompts ran before stop. Copilot held-permission cancellation passed with zero grants. Claude target stopped while running and its companion sleep survived, but wording falsely failed grading. Companion tool success preceded an unbound-progress refusal; full completion was unqualified. The fourth Copilot task remained undispatched and its slot was not reused. |
| Finish batch at `ad16cfd`: `local/client-cancellation-finish-2026-11-10/` | Three initial prompts and one recovery of the original unstarted Copilot job, zero task retries. Claude cancellation passed; advisory child-ID heartbeat no longer stopped the guard. A process-exit observation race falsely stopped companion completion before its final response; transcript inspection found no final marker. Copilot birth-qualified running cancellation passed before SDK teardown. |
| Approved Claude pair: `local/claude-companion-final-prepared-2026-11-10/` | Two initial prompts passed: simultaneous sleeps, target interrupt/terminal result/physical cessation, companion survival then successful tool result, final assistant marker and matching native terminal result. No companion interrupt or cleanup signal occurred. Observed models were Haiku 5.5 and Sonnet 5.5. |
| Copilot continuation: `local/copilot-concurrency-final-2026-11-10/` | Two prompts exhausted the same four-prompt ceiling that included the approved Claude pair. Target cancellation passed before teardown while companion survived. Companion first yielded a running shell; later typed exit zero and marker were observed, but a one-tool guard refused its follow-up read and cleanup aborted final idle. The pair remains stopped. Observed Auto routing was `mai-code-1.1-flash`; this was not an explicit model selection. |
| Approved Copilot retry: `local/copilot-completion-live-2026-11-10/`, `local/copilot-completion-live-retry-2026-11-10/` | A separate grant allowed four initial prompts across two pairs, bounded owned-shell reads and one retry. First pair stopped because optional idle `aborted` was absent. Captured SDK contract correction retained absence and rejected true/null/invalid values. The single retry passed: target cancellation before teardown, surviving companion, one owned read, typed exit zero, later marker and normal root interactive idle. Four prompts/eight exact approvals total; one companion read per pair. Auto routed to `gpt-6-luna`. |
| Earlier Claude concurrency stop: `local/client-concurrency-2026-11-10/` | Two initial prompts, no retry. Sonnet tool result and final marker were observed, but simultaneous birth-qualified descendants were not established. Parent stopped without interrupt control; Haiku completion/cancellation remained unknown after bounded cleanup. No cause was established and no Copilot concurrency prompt ran in this phase. |

The corrected Copilot matcher treats path and command requests as distinct exact
handles and permits only approve-once/reject. Nullable-token cancellation can
never grant. Claude unmatched/late/foreign progress is advisory, while proposals,
permissions and results retain strict ownership. Process disappearance between
queries is absence; changed birth/group/arguments still refuse. Offline-only
preparation refused live execution and did not relabel failed native controls.

Known worker/native streams, child close and owned groups joined or were checked
absent as recorded per phase; policy metadata remained unchanged. Native startup
state was not proved byte-identical and escaped descendants remain unverified.
Current-account concurrency is not independent-account isolation. No inferred
billing total or enforced token/credit cap is claimed.

| Selected artifact | SHA-256 |
| --- | --- |
| Final Copilot controls manifest | `7875b715f084060a329409b2da0584617453c9085ef78066563b4fc7201c817a` |
| Fresh cancellation manifest | `d0d81146718313ba2c7f5165a8e78a60b3a43a5122038e1bfcc9ddf2b76a811c` |
| Finish batch manifest | `d12c496651780fb843f61930a4e6d422ad204c3a84c9af8ecc3a5422c419ea46` |
| Approved Claude manifest | `258694a7d6d595c3642c3c185fddd2a92afcf614f4d3567a1e0f7ff5b36c6f80` |
| Approved Claude passed result | `620e2c9a0cff02581ad195408a3d919187b49185776268eed0f230c7ed4abe9a` |
| Stopped Copilot continuation result | `efdc3667905520530d4584ff40d83450566e3f98557fc53e2e3c6621c9242d08` |
| First Copilot retry-phase stopped result | `7075c7f96fb855c8a07c66a076c5e051ef30494533b047dbd8a1b6ba99d2b4be` |
| Passed Copilot retry manifest | `3cca092f2f80cb2604bfbc72a331e5e233e727f9acc88666297fa407f5429be5` |
| Passed Copilot retry result | `67621d885c575c9f3119f202531f70ebd691f934bfa275c8518e9a847634df1b` |
| Retry-history export | `90117af73a2ff55ad1f6e85a91ed42aa35a283ef5c4155e4687fd45bcd7d9de9` |

## Desktop and conversation-source boundaries

Claude Desktop Code's inspected resume picker showed no local sessions. The UI
tool refused Terminal for the interactive handoff check; no bypass was attempted.
Redirected CLI handoff was also refused. Exact Desktop association remains
unqualified. A selected existing Chat offered an artifact-only Markdown download,
not a complete transcript or immutable conversation interface. Its 2,202 bytes
omit surrounding messages and attribution; original account/model/effort remain
unknown. No Cowork source was available. Conversation title, native identity and
download filename remain private under `local/client-followup-final-2026-11-10/`;
artifact SHA-256: `9e0b4fc5fd841cbf95632aa45817b77389c5b1d1e7cfdfbdbaa5204667094775`.
No message, share/access change, new task or account action occurred.

At `847ea0c`, signed Copilot app 1.1.35 opened the same existing synthetic session
through the product's revalidated app-local route. Native UI confirmed saved
content with an empty disabled composer. The product still reports link-opened,
not programmatic association or completion. App-local, workspace and GitHub task
identities remain distinct and private. Ordinary opening is not automated control.
Evidence remains under `local/client-desktop-positive-2026-11-10/`.

A sessionless source read returned 29 durable events through the supported journal
API with zero activations, prompts, tools or grants. Production HTTP acceptance
read the same existing synthetic source twice, not independent jobs/accounts.
Both original event sets and public-text projection survived opt-in export/cold
reopen after owned import copies became unavailable, with native spawning blocked.
Private reasoning/system/tool data stayed outside the public projection. Reports
remain partial: account, original surface, full execution outcome/usage and applied
effort are unknown; executable provenance is a stat hash, not binary content hash.
A wrapper syntax error was fixed before native dispatch; its original is preserved.

| Import artifact | SHA-256 |
| --- | --- |
| Sessionless source manifest | `70986f628532adc5e30b749e422128a74e058415b5ae67b852bf83a0ada1f3cb` |
| HTTP acceptance manifest | `b4709340bfd7c2ed0eebadae784cb9101e578cb3af588ad1dfc56da8cd9c17df` |
| Frozen export | `09cf4024a212e82b6da304cbe142eb6d2b1951056e19c1815fa637527fa14af8` |

## Verification and limits

Execution preparation passed captured-request/SDK pipeline, owner/scope mutations,
process-exit and heartbeat controls. The final Copilot retry passed 67 actor guard
mutations, six coordinator checks, captured-stream regression, syntax and source-loss
cold reopen without product/UI changes. Intermediate phase-specific checks remain
with their private evidence; none converts a stopped native phase into a pass.

Import implementation passed 34 focused Node checks, six affected browser journeys,
then final Node (1,559 passed, zero failures, one opt-in skip) and built UI
(69 journeys, types/tokens/bundle parity). Syntax, universal native integrity,
42 packaged Markdown files and 320px light/dark screenshots passed. Earlier
sandboxed Node (1,533 passes, 26 failures, one skip) and Chromium-start failures
remain preserved separately; permitted reruns do not erase them.
Detached package smoke installed with scripts disabled, loaded importer/SDK and
ran CLI help without native construction. Development tarball SHA-1:
`4397f8b30c3ab0de42866f176206145b49202980`, 197 members; implementation matched the
accepted source, with documentation finalized afterward. No publication or
installed update occurred. The [route record](CLIENT-ROUTES-2026-11-10.md) owns
later provider-guard/source-read verification.

Two-account isolation cannot be inferred from two configurations. Managed
callbacks, mixed execution, restart/recovery, SDK/ACP parity and unobserved Desktop
controls remain separate acceptance requirements. Historical grants authorize no
new task attempts.
