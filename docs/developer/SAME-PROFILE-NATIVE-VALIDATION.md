# Same-profile native validation

## Scope and source

This public summary describes the separately authorized native checks performed
on disposable profiles during development of 3.1.0. Private receipts preserve
source hashes, exact native thread/turn identities and original failed outcomes;
those operational records are excluded from the package. The implementation was
based on source revision `0e061876a3ae717845f01a1d3ae9a89c358e75be` with the
same-profile execution changes applied. It was not the final packaged candidate.

The vendor was the original signed Codex app, version 26.1029.61003/build 24614,
with bundled CLI 0.166.0-alpha.6. Its signature remained valid. Passing these
checks does not establish support for every provider build or exhaustive capture.

## Campaign outcomes

| Campaign | Observed outcome |
| --- | --- |
| Initial model preflight | Both initially approved models were absent from the native catalog. Execution stopped before any model turn. |
| Supported-model campaign | Eight turns using `gpt-6.1-sol` and `gpt-6-luna` established same-profile A/B results, four initialized sessions alongside Desktop, independent approvals and two completed reviews. Three interrupted attempts exposed ownership/admission defects that were corrected before the later campaigns. Full four-job model execution was not established within this grant. |
| Additional five-turn campaign | Four model jobs on one profile reached native approval together alongside Desktop: two comparisons and two reviews. Cancelling one comparison preserved the other three jobs. Both sides of the surviving comparison executed in distinct threads and both reviews completed. Exactly five turns ran. |
| Refresh/recovery campaign | Exactly three turns using the same supported models established native recovery from an injected invalid/expired cached access token and live coordinator SIGKILL recovery for a comparison and a review. An independent review completed. |

## Observed behavior

- Native sessions confirmed each requested model and reasoning effort before its
  model turn. Overrides remained local to their processes; saved configuration
  hashes matched before and after execution.
- Simultaneous jobs retained separate threads, turns, frozen inputs, approval
  requests and results. Native processes reused request ID `0`; UI request IDs
  scoped decisions to the correct job. Only inspected disposable marker commands
  were accepted, once each, without accepting a policy amendment.
- Cancelling a comparison rejected its stale approval reply, did not launch its
  second side and preserved independent jobs. Profile rename was refused while
  execution reservations existed.
- Recreating services and reopening from separate coordinator processes returned
  existing attempts for repeated Start tokens, retaining captured review responses
  without another model turn.
- For crash recovery, two owned native groups were paused with SIGSTOP to hold a
  live-orphan condition, then their coordinator was killed with SIGKILL. Reopening
  reported the review as uncertain and the comparison as unable to tidy while
  native ownership remained live. It rejected stale approvals and mutation.
  After SIGCONT, both groups exited following coordinator pipe closure. The review
  became interrupted; explicit comparison recovery preserved partial evidence
  without resuming work. Neither unanswered command executed.
- Campaign-owned process groups stopped, owned Desktop instances closed and
  pre-existing Desktop identities were preserved where observed. Idle checks and
  read-only integrity checks of the state and diagnostic SQLite databases passed.
  Disposable credentials, profiles, workspaces and generated launcher caches were
  removed under the corresponding cleanup grants.

## Token fault and evidence limits

Only the disposable profile's cached access-token JWT payload was changed: its
expiry became a past value while its original signature, refresh token and refresh
timestamp were retained. The payload change also invalidates the signature.
Native execution replaced it with a different, future-expiring access token,
rotated the refresh token and advanced the saved refresh timestamp without another
sign-in. Both model jobs reached approval. Diagnostic records contained 401 and
refresh mentions; only aggregate counts were retained in the sanitized receipt.
This proves native refresh after rejection of a synthetic expired/invalid cached
token. Natural expiry of an otherwise valid signed token was not observed.

The surviving comparison retained `finished-partial` status because exhaustive
skill-use capture remained partial. Completion is concurrency/model-execution
evidence, not proof of exhaustive capture or task correctness. Escaped descendants
remain outside the process observer's proof. No implementation change was required
by the final five-turn and three-turn campaigns. A subsequent source review fixed
an owning-controller journal lookup for different registry IDs on the same home;
that correction is covered by a regression test rather than a new native campaign.

The [3.1.0 candidate record](RELEASE-3.1.0.md) owns candidate checks and packaging
status. This summary grants no publication, installed update or further live work.
