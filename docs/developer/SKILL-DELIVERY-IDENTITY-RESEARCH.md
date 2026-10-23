# Skill delivery identity research

Date: 2026-10-20. Status: research complete; journal recovery and scoped delivery
accounting implemented locally; source-time projection is now implemented, with
verification described below.

The current skill telemetry supports **received-record identity and stable replay of successfully journaled receipt IDs**.
It cannot establish unique skill executions or complete delivery. Keep
`observationId` as a receipt identity, keep skill-use coverage partial, and do not
deduplicate native events by a timestamp/name/turn tuple or payload hash.
A detection event also does not certify successful file access or task completion;
keep separate tool outcomes as independent evidence.

This research uses the pinned native `0.163.0-alpha.10.2`, its corresponding
source revision `4ebc485ca321243727539187169425fcf972f2c4`, and disposable
credential-free local-provider controls. Native source files were verified
against that revision's Git blob IDs. Dependency source archives were verified
against its lockfile checksums. Raw transcripts, request bodies, actor IDs,
profiles, paths and failure evidence remain private. The installed CLI and
existing product source/tests were preserved during the research phase.

## What the original research established

| Question | Evidence and result | Limit |
| --- | --- | --- |
| Does every definition read emit an event? | Four successful plain `cat` reads across two turns of one resumed native thread produced one received implicit event per turn. Native source keeps a per-turn set keyed by host scope/path/name or resource ID. | Same-turn reads are deliberately suppressed. This does not cover every possible read or use pathway. |
| Is there a producer occurrence ID? | The supported skill event contains conversation, turn, name, scope, optional plugin, type and a timestamp attribute. Its constructor/emitter supplies no occurrence ID or sequence. | A timestamp or trace context cannot substitute for a supported unique occurrence contract. |
| What does an observer ID identify? | Two identical synthetic POSTs, each containing two identical timestamp-free rows, retained four distinct observer IDs. Replaying the journal retained those IDs and merging the replay did not add rows. | IDs distinguish receiver receipts, including retransmissions, not unique producer detections or executions. |
| Are caps and invalid rows visible to the sender? | Synthetic event-cap and invalid-row controls returned HTTP 200 with empty `partialSuccess`; local reports were partial. | `rejectedRequests` counts rejected requests, not omitted rows. A successful HTTP response does not prove every relevant row was retained. |
| Is acknowledgement equivalent to durable replay? | An isolated injected fsync failure after a write returned 503 and removed the row from memory, while the local filesystem still exposed the line. A retry returned 200 with a new receipt ID after the journal descriptor closed, but was not journaled. | This proves acknowledgement/replay ambiguity in that failure path. It does not prove crash or power-loss durability. |
| Does native HTTP failure guarantee a retry? | A real native read completed in each fault control. Returning 503 produced one observed POST and no receiver rows. Accepting one row and then dropping its acknowledgement produced one observed POST and one receiver row. | No retry appeared within each five-second post-run observation window. Requests were not time-correlated to shutdown; this is not a universal no-retry or shutdown-flush guarantee. |
| Does the receiver retain native event time? | The received native samples contain an ISO-8601 `event.timestamp`, numeric `timeUnixNano=0` and an SDK observed timestamp. The current receiver accepts positive numeric nanoseconds and omits this ISO timestamp. | Preserved raw native samples contain time that the normalized receipt currently lacks. Time is still not an occurrence ID. |


The native implicit control used six scripted provider responses, no selected
explicit skill or plugin, four terminal command items with exit 0 and expected
fixture output, one thread and two distinct turns. The second turn followed
native thread resume. A separate explicit-plugin control retained root, child and
grandchild events; it does not substitute for the implicit suppression control.

Synthetic controls are receiver experiments, not native emission or execution
proof. Distinct random stream IDs were observed in two receivers; this is not a
global collision-free identity guarantee. Frozen metadata is not signed source
authentication.

## Pinned exporter behavior

The verified native provider uses the SDK batch log exporter. SDK 0.31.0 defaults
are a 2,048-record queue, 512-record batch and 1-second schedule, with startup
`OTEL_BLRP_MAX_QUEUE_SIZE`, `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` and
`OTEL_BLRP_SCHEDULE_DELAY` overrides. These are source defaults, not measured
settings for historical runs.

Queue overflow drops new records and records a drop diagnostic. Failed exports
clear their batch without processor-level retry/requeue. The inspected HTTP log
exporter makes one send and treats 2xx as success without parsing `partialSuccess`.
This matches the bounded native fault observations. Retries inside a separately
configured managed HTTP client remain unverified. The bounded native shutdown
wrapper may return before its worker finishes and ignores underlying shutdown
errors; shutdown completion or timeout is not a per-event delivery receipt.

The native tracing bridge leaves the event-time field unset; the SDK supplies an
observed timestamp. Neither the native timestamp attribute, SDK observed time,
trace/span context nor an unkeyed payload hash establishes unique execution.

## Implementation order from the research

1. **Make durable receipt acknowledgement honest.** When capture requires a
   journal, a write/fsync failure must prevent later 200 acknowledgements from
   silently becoming memory-only acceptance. Preserve the failed attempt and
   expose uncertain/uncommitted tails on recovery. Define what a durable commit
   means before changing the journal format; do not replay uncertain tails as
   confidently accepted receipts. Optional journal-disabled operation must be
   explicitly distinguishable from required-journal failure. Define file and
   directory synchronization and the commit/recovery boundary for the chosen
   durability claim; successful local reads are not a power-loss test. Require
   a 200 acknowledgement to follow the configured durable commit, while treating
   acknowledgement loss and failure tails as uncertain; do not promise that
   sender acknowledgements and replay-visible records form identical sets.
2. **Expose receive/loss accounting with explicit scopes.** Separate HTTP request
   rejection, relevant records received, accepted receipts, durable receipts,
   invalid relevant rows, unclassified invalid records, cap/budget omissions and
   intentionally ignored non-skill records. Count a row as relevant only when a
   trustworthy event classifier supports that claim; invalid attribute maps and
   unexamined records need unknown/unclassified buckets. Exact counts require
   complete bounded traversal; otherwise report a lower bound or unknown. Return meaningful OTLP
   partial-success data
   for known rejected rows, while retaining local counters: this pinned native
   exporter ignores the response body. HTTP errors, timeouts and missing
   producer records
   cannot provide an exact upstream-loss count. Native queue drops, detector
   suppression and failed export batches are separate upstream loss domains
   that receiver counters cannot quantify.
3. **Keep receipt identity separate from native identity.** Preserve existing
   observer IDs and replay behavior. A future producer ID needs a pinned schema
   with process/session namespace, occurrence sequence or random ID, retry-stable
   retransmission semantics and a declared retention/reset boundary. Only that
   supported identity can justify producer-event deduplication. Even then,
   detection suppression prevents interpreting event count as read/execution
   count. Request upstream capability or use a separately approved instrumented
   native build; do not invent IDs from payload hashes.
4. **Preserve informative time without turning it into identity.** A separately
   tested pinned-format projection may retain the native ISO timestamp, with a
   source/clock label and explicit unknowns. Do not conflate it with the SDK
   observed time or use it for deduplication.
5. **Verify the complete frozen path.** Faults before/during/after append and
   fsync, restart, partial tails, cap/invalid rows, duplicate transport delivery,
   repeated merge, independent streams and JSON/Markdown/compact reopen must
   retain identities, uncertainty, counter scopes and omission bounds. Reopen
   after source removal. Use disposable native success/failure controls and
   preserve partial exit 2.

A privacy-safe implementation must allowlist bounded identifiers/counters and
reasons, reject caller-supplied receipt IDs on native ingress, and retain no raw
OTLP payloads, prompts, outputs, user/account identifiers, filesystem paths,
credentials or receiver tokens in public/frozen delivery metadata. Correlation
hashes and logical metadata can still reveal private context; document their
scope and avoid exporting raw-request fingerprints as identity.

## Source map

- Xenoflux: `src/audit-telemetry.js`, `src/audit-skill-usage.js`,
  `src/audit-statistics.js`, `src/audit-experiment.js`,
  `src/audit-telemetry-journal.js`, `src/audit-delivery.js`,
  `src/audit-source-time.js`.
- Pinned native: `codex-rs/core/src/skills.rs`,
  `codex-rs/core/tests/suite/skills_extension.rs`,
  `codex-rs/otel/src/skill_invocation.rs`,
  `codex-rs/otel/src/provider.rs`, `codex-rs/otel/src/otlp.rs`.
- Pinned dependency source: `opentelemetry_sdk0.31.0`,
  `opentelemetry-otlp0.31.0`, `opentelemetry-appender-tracing0.31.1`.

Public pinned references: [native skill event](https://github.com/openai/codex/blob/4ebc485ca321243727539187169425fcf972f2c4/codex-rs/otel/src/skill_invocation.rs)
and [native exporter configuration](https://github.com/openai/codex/blob/4ebc485ca321243727539187169425fcf972f2c4/codex-rs/otel/src/provider.rs).
The saved plan points to the private source-integrity receipts, native controls,
receiver probes and SDK supplements. No authenticated provider was called.

## Evidence integrity and verification

One native two-turn probe had a harness cleanup error. Its receipt was amended
in place during correction, and the original receipt bytes cannot be recovered.
Raw native streams, tool responses, OTLP requests and findings remain retained;
the cleanup correction explicitly discloses the limitation. Treat that receipt
as corrected research evidence, rather than an immutable original. Other raw
attempts and failed download/source reports remain preserved.

The 45 existing focused telemetry/skill-usage/statistics tests passed. Native
controls and receiver replay/export checks provide separate bounded integration
evidence. Product source/tests stayed byte-identical to the start of this
research; the earlier full-suite result was not rerun for a documentation-only
change. The research itself introduced no identity feature or durability repair.
The subsequently authorized local implementation is described below.


## Local implementation following the research

The receiver now commits a v2 journal and hash-bound sidecar before HTTP 200.
Required write, sync or checkpoint failures latch subsequent admissible batches at 503,
including empty batches. Recovery verifies the pair, replays only its committed
prefix and retains uncertain tail bytes. Legacy event-only files remain
unverified; broken v2 files cannot silently become legacy input. The journal
requires an existing private run directory and a single writer. File sync,
checkpoint sync, atomic publication and directory sync define the local commit
boundary; process-kill and fault controls do not establish real power-loss safety.
A valid checkpoint may survive a failed final sync or lost response, so recovered
rows and sender acknowledgements are not asserted to be identical sets.

Scoped accounting separates request admission/rejection from examined and
relevant records, accepted/durable receipts, invalid relevant rows, unclassified
records, ignored events, cap drops and persistence rejections. Bounded traversal
keeps unexamined counts unknown. Recovery counters describe the published
checkpoint snapshot, rather than reconstructing a complete receiver lifetime or
HTTP response history. Upstream loss and acknowledgements remain unknown. Fixed
projections preserve counters and scope through persistence, full and compact
JSON, Markdown, comparisons and source-free reopen, while stripping unapproved
nested fields. Receipt identity, partial skill-use coverage and exit 2 remain.

The original failure controls above describe the pre-fix receiver. New storage
fault controls cover post-write sync failure, checkpoint publication failure,
latched retries, process interruption on both sides of publication, uncertain
tails and ambiguous final directory sync. A disposable pinned-native control
also verifies root/child/grandchild receipts, durable accounting, journal replay,
exports and offline reopen after the fixture source/cache is removed. Raw
attempts and original failure evidence remain private and preserved. At that milestone, optional source-time projection and a supported upstream
producer identity remained open; the source-time continuation below addresses
the former.
No commit, push, release or installed-xfx update is part of this implementation.

Final local verification: the full suite passed with 885 tests, no failures and
one existing opt-in Desktop skip; syntax, native-launcher and diff checks passed.
The final native control retained three actor receipts and their scoped counters
through journal replay, full/compact export and source-free reopen. Review also
found and resolved a duplicate capture-metadata projection gap; only the canonical
run diagnostics survive frozen exports. Privacy/package checks exclude private
handover files, originals, raw evidence and tests. The installed application and
existing clients were preserved; no account-backed provider was called.


## Source-time implementation

The subsequent source-time continuation adds `sourceTime.schemaVersion = 1` to
new receiver receipts. It retains native `event.timestamp`, OTLP `timeUnixNano`
and OTLP `observedTimeUnixNano` separately, with fixed reported-domain labels and
exact decimal nanoseconds. UTC `Z` calendar parsing validates dates and preserves
up to nine fractional digits; zero/unset, malformed, unsupported or out-of-range
time becomes null. Numeric OTLP JSON values are rejected to avoid silent integer
rounding. SDK observation time does not fill either event-time field. Arbitrary
nested data is removed before journaling, merging, comparison and frozen export.

The native timestamp helper remains unavailable in the retained pinned source.
The bridge copies the attribute without setting OTLP event time; verified SDK
source fills observation time when absent. The labels identify reported domains
and `clockRelationship` stays unknown. No hardware calibration, latency,
chronology, precision or upstream producer identity is inferred. Canonical ISO
output can zero-pad milliseconds without asserting a more precise clock.
Legacy `timestampNs` and receipt keys remain unchanged; historical rows lacking
the new projection stay unlabeled. Existing coverage/exit-2 boundaries remain.

Meaningful regressions cover strict calendar/fraction/range parsing, leading-zero
numeric strings, missing or conflicting domains, same-time distinct receipts,
idempotent merge/compact paths and malformed nested values in full/compact and
comparison evidence. Source-time privacy projection is shared by frozen storage
and embedded comparison runs, preserving the caller's original evidence.
A disposable pinned-native control retains the actual OTLP wire, verifies all
three actor receipts against its fields, replays the committed journal, and
reopens full/compact JSON and Markdown after source/cache removal. Raw timestamps,
actor IDs, requests and profiles remain private. No account-backed provider,
commit, push, release or installed-xfx update is involved.

Final source-time verification: 892 tests passed, zero failed and one existing
opt-in Desktop test skipped. Syntax, native-launcher, diff, privacy and package
exclusion checks passed. The pinned-native wire control verifies three actor
receipts with exact native and observed time values; real clock synchronization,
delivery latency and a producer occurrence identity remain unverified. Private
originals, installed xfx, profile settings and existing clients were preserved.
