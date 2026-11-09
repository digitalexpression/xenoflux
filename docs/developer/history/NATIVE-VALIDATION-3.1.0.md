# Same-profile native validation

Development evidence for 3.1.0, based on `0e061876a3ae717845f01a1d3ae9a89c358e75be` plus concurrency changes, not the final packaged candidate. Full receipts/source hashes/failures remain private. Vendor: signed Codex 26.1029.61003/build 24614, CLI 0.166.0-alpha.6.

| Campaign | Observed result |
| --- | --- |
| Initial model preflight | Requested models absent; stopped before any turn. |
| Supported models | Eight turns with `gpt-6.1-sol`/`gpt-6-luna`; distinct results/sessions, approvals and two completed reviews. Three interrupted attempts exposed ownership/admission defects; full four-job execution not yet proved. |
| Additional five turns | Two comparisons and two reviews reached approvals together alongside Desktop. Cancelling one preserved the other three; surviving sides used distinct threads and both reviews completed. |
| Refresh/recovery, three turns | Synthetic invalid/expired cached-token refresh and live coordinator SIGKILL recovery; an independent review completed. |

## Observed behavior

- Model/effort confirmed before turns; saved configuration hashes preserved. Job-scoped UI IDs disambiguated reused native request ID `0`; only inspected commands were accepted, once, without policy amendments.
- Repeated Start/reopen returned existing attempts/results. Cancellation rejected stale approvals and skipped its second side; reservations blocked rename.
- Paused live orphans blocked recovery/mutation after coordinator death. After pipe closure and confirmed exit, review became interrupted and explicit comparison recovery preserved partial evidence without replay; unanswered commands did not execute.
- Owned cleanup and SQLite integrity checks passed; observed pre-existing clients were preserved. The later cross-controller journal correction has regression coverage, not new native acceptance.

## Token fault and evidence limits

JWT payload editing expired the cached token and invalidated its signature; native refresh rotated credentials without sign-in. This does not establish natural expiry of an otherwise valid signed token. Comparison skill capture stayed partial; completion is not task correctness. Escaped descendants and unobserved provider builds remain outside the proof.

Final package checks: [3.1.0 release](RELEASE-3.1.0.md).
