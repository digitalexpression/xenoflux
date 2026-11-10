# Claude/Copilot native route investigation — 2026-11-10

**Outcome: native subscription/catalog discovery and sessionless history reads
were observed; ACP execution and restored-session behavior were not qualified.**
Initial source: `8053084`; later ACP discovery: `b5d2a1e`; restore-source read:
`e2de84d` plus provider-guard fix `f84940c`. The
[plan](../CLIENT-SUPPORT-PLAN.md) owns supported contracts and the
[roadmap](../ROADMAP.md) owns current status.

## Subscription and catalog discovery

| Route | Observation | Limit or failed control |
| --- | --- | --- |
| Claude | SDK 0.3.322 initialized unmodified CLI 2.1.319 with existing implicit native user context and normal settings. It reported Pro, first-party routing and 13 model entries with sparse effort metadata. | Zero user messages or model tasks. An earlier probe stripped user context and lost account attribution; its failed receipt remains unchanged. SDK account/model methods reuse the initialization snapshot. |
| Copilot | CLI 1.0.107/protocol 3 exposed enabled visible Auto/balance routing, a hidden fast tier, disabled Fusion tiers and zero explicit conversation models. Three bounded metadata probes retained the existing `gh-cli` route. | Matching the SDK connect handshake did not populate explicit models. Quota and Auto-only metadata do not establish account plan or inference entitlement. No guessed model IDs or policy changes were used. |

Private sources and original receipts are under
`local/client-route-investigation-2026-11-10/`. Claude policy metadata stayed
unchanged, but native startup rewrote its state file; byte equivalence was not
established. Startup hooks/MCP may initialize normally. Zero user frames does not
prove zero effects or cost. Owned shutdown was observed; escaped descendants and
independent-account isolation remain unverified.

The recorded route review used the vendor's
[subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
[authentication guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
and [Copilot model-access guidance](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-access-to-ai-models).
These historical observations do not grant credential intermediation or qualify
an arbitrary SDK integration. Bare mode was excluded from the subscription probe.
Protocol self-tests, harness syntax and packaged-document checks passed. No
product change required a new engine/browser run for this initial investigation.

## ACP metadata and stored-session identity

Two separately bounded CLI 1.0.107 probes used the supported
[ACP entry point](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server),
10 seconds/8 MiB each, with zero prompts, session creation/load, authentication
calls or grants. Initialization advertised protocol-v1 metadata and a login
method; this does not prove authenticated execution. A single cwd-filtered list
page returned the same stored-session identity as the earlier SDK observation.
Exact native IDs, cwd and raw metadata remain private.

| Private evidence locator | Manifest SHA-256 | Receipt SHA-256 |
| --- | --- | --- |
| `local/client-transport-zero-task-2026-11-10/` | `e9d8e14cc02d348ac92d10f498c3a6644f806f9c0cff906e38e13660612c533f` | `bf9bebc96ca6311787500900e8a1826a4f28f90d8b00119b6e24c4709b2b7cc3` |
| `local/client-acp-history-zero-task-2026-11-10/` | `5898dbb2f3b1c30d4e0aefd6c0741f23f484691b7398a8c9325ed0214151a2b6` | `99478c1dcd3c598509b261168ebb8ae7a121b789ac48b4c5dc4e9cb93e71cdeb` |

Both processes exited zero with joined close, absent recorded PIDs and unchanged
policy/runtime stat identities. No cursor was returned; pagination and a full
history index were not tested. Protocol fixtures covered request bounds,
versions, unexpected requests, cwd filtering, duplicate IDs and projection
privacy. They do not prove SDK/ACP execution parity. Product source was unchanged
from `c415f07`; full product suites were not rerun for these probes.
The [session-load contract](https://agentclientprotocol.com/protocol/v1/session-setup)
includes replay and connection parameters; zero activation/inference was not
established, so loading remained deferred. A private proposal is not execution.

## Restore-source preservation and provider guard

The production sessionless reader preserved one completed qualification source:
21 events and 72,878 serialized page bytes in a complete pinned generation.
Session identity, event uniqueness, prompt hash and final marker were validated
privately. Evidence and exact sources remain under
`local/client-restore-source-2026-11-10/`.

| Artifact | SHA-256 |
| --- | --- |
| Manifest | `bcece6082828ef658bf2367504b845acf16e6b198f618f2c64822954e763f17f` |
| Receipt | `42a6cadef12efcc6e475a8c0d540c8934016be964ae12d1339cf5b70d7c2d3e2` |
| Raw journal page | `cbc8cdd506122d85f4dd1b84accd1ea6a066fa3ca9e5caa2d1788b7f27499a9d` |

SDK 1.0.29/CLI 1.0.107 read through the existing implicit `gh-cli` route with
zero activations, prompts, grants or authentication actions. SDK/child close
joined and recorded processes/groups were absent; policy/runtime identities
matched. This is a journal snapshot, not vendor-database bytes, a complete profile
backup or restore/restart acceptance. Source must be revalidated before activation.

Review found missing provider-environment exclusions. The shared import guard
now refuses known/future provider overrides, including empty values, before both
outer importer and native reader startup. Three archive-verifier and nine focused
importer checks passed. Final product checks passed: syntax, native integrity,
42 packaged Markdown files, Node (1,560 passed, zero failures, one opt-in skip)
and sequential UI (69 journeys, types/tokens/bundle parity). An earlier UI run
overlapped Node fixtures and remains provisional; private `ui-sequential.log`
owns the qualified browser result. No load runner or additional model task ran.
