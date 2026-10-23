# Xenoflux profiles and audit: shared product goal

Goal ID: `XFX-AUDIT` (retained for existing references). Established and clarified:
2026-10-22. Scope: profile management, full setup comparison and behavioral audit.

This is the shared product goal and acceptance contract across sessions and
agents. The filename remains stable. Current user instructions determine scope
and authorization; this definition grants neither. Progress, proposals, run
results and next delivery steps belong in the [active roadmap](ROADMAP.md).
Operational receipts and consumed grants remain in historical records.

## Current release boundary

Deliver the complete profile-diff and audit workflow below for **Codex CLI and
Codex Desktop on macOS first**. Both clients are release acceptance targets;
neither a CLI-only implementation nor a single successful pilot completes it.
xfx-started execution may use the existing Codex runner; client-started acceptance
must cover tasks started directly in both CLI and Desktop. A separate Desktop
automation runner is not implied.

After that release, assess the UI and additional providers such as Claude and
Copilot against actual needs and interfaces. Their assessment and implementation
are not prerequisites for this release. The earlier Evidence Workbench design is
a retained proposal to reassess then, not an instruction to build it now.

## User-visible outcome

Let users create multiple AI coding profiles, change each independently, inspect
the full differences between their setups, and compare what those profiles
actually did and produced on the same task. Users should understand the result
without an engineer or AI agent reconstructing it from scattered records.

**Create/select profiles → change setups → inspect setup differences → run a task
through xfx or directly in a client → select sessions → compare behavior and
outcomes → optionally obtain AI review, human review or both.**

Profile comparison and behavioral audit are both primary outcomes. A particular
workflow skill, coding fixture, provider or benchmark is a validation case, not
the product goal. Profile management and client controls remain readily
accessible; comparison does not silently copy, activate or modify profile state.

## Full profile setup comparison

Show clear differences in configuration, instructions, available/installed tools,
skills, MCPs, memory settings and other relevant profile settings. Include
applicable profile, user, project, system and plugin sources with origin and
scope where observable. Independent changes can use the provider's normal
configuration flow or supported xfx management operations; a generic editor is
not an assumed prerequisite.

- Explain safe setting values and changed source content, rather than relying
  only on hashes, counts or names. Include relevant skill package resources;
  matching `SKILL.md` files alone do not establish full package equality.
- Distinguish added, removed, changed and identical from partial, unknown,
  unavailable, redacted and not applicable. Claim absence only when discovery
  establishes it for that scope. Omitted settings are not identical settings.
- Distinguish configured, installed, enabled, available, loaded, invoked/read and
  followed. A cache entry or definition does not prove runtime availability,
  authentication, effective precedence or use.
- Keep provider-specific settings inspectable without forcing false equivalence.
  Show effective values only where evidence supports them; otherwise show
  declared sources and unresolved precedence.
- Memory settings are in scope. Bulk memory-content export, credential comparison
  and conversation/runtime-state transfer are not implied.
- Observation is broader than copying. The [profile copy policy](PROFILE-COPY-POLICY.md)
  still governs creation/copy mutations. Non-copyable integrations remain in
  discovery/comparison scope; full diff does not mean automatic synchronization,
  installation, connection or activation.

“Full” means all relevant discoverable categories with useful detail and explicit
limits, not inference of hidden state or exposure of secrets.

## Two equal audit entry paths

1. **xfx-started:** run the same task on selected profiles through xfx and compare
   the resulting sessions.
2. **Client-started:** run the task directly in a CLI or Desktop application and
   supply task/session IDs to xfx afterward. An xfx launcher, wrapper or prior xfx
   experiment is not required to inspect those sessions.

Resolve identities with owning provider, client and profile as necessary; session
IDs may not be globally unique. Both paths feed the same report, optional review
and export/reopen experience. Discovery must not start a model task or silently
fall back to another profile.

Keep recorded run-time setup separate from today's setup. State whether same-task
association comes from recorded input identity, a user declaration or unknown
evidence. A matching title/declaration is not independent proof of identical inputs.
Historical gaps remain visible; the current checkout is not a historical task-end
result.

The audit must answer:

1. **How did these profiles behave on the same task?**
2. **What differed in behavior, how consistently did it differ, and did that
   produce a better outcome?**

Different model, reasoning, provider, tools or instructions can be the intended
comparison. Show those conditions without automatically suppressing supported
descriptive findings. Determine eligibility per claim: task association, action
attribution, named checks, rubric outcomes and measurement accounting have
different evidence needs. Missing context may limit one claim or delta without
discarding all positive observations. No eligibility label alone proves causality.

## Providers, clients and local execution

The longer-term product direction includes Codex Desktop/CLI, Claude Desktop/CLI,
Copilot and further supported integrations. The current release is Codex on macOS
only. Future integrations each need actual profile/discovery/session/
execution evidence; shared report support alone does not mean a client is
integrated. State unsupported clients and unavailable evidence explicitly.
Cross-provider profile cloning is not implied.

Do not pin supported third-party versions or maintain a release-by-release
compatibility matrix. Record observed versions as context when available, use
supported protocols/formats/capabilities, and address breaking changes when
encountered. An unfamiliar version string alone must not reject a profile, run
or comparison. Do not guess accounting semantics either: retain source counters
and mark unsupported derived totals unknown. Immutable historical evidence and
xfx's own versioned report schemas remain valid mechanisms.

Run and audit directly on the user's machine/environment. Containers, VMs,
whole-client isolation, isolated-environment provisioning and generic recovery
platforms are not requirements of the product or roadmap. Separate profile
storage and ordinary task workspaces are local workflow state, not a mandate
to provision an isolated execution platform. Respect normal permissions and
preserve profiles, credentials, running clients and unrelated work. Address a
concrete unsafe/unsupported action without blocking unrelated comparison work
or creating a platform prerequisite.

## Report, review and consistency

**Comparison conditions → behavioral findings → paired action evidence → verification → time and tokens → outcome and code changes**

| Section | What the user must learn |
| --- | --- |
| Comparison conditions | Profiles/provider/client sessions, task association, relevant recorded controls/differences and supported claims. Keep the summary short; detailed inventories remain inspectable. |
| Behavioral findings | Material differences and similarities, uncertainty, and whether observations recur across comparable pairs. |
| Paired action evidence | Left/right actions, verified actor ownership, within-source sequence, results and references. Unmatched/unavailable evidence stays explicit. |
| Verification | Agent claims, native completion, original checks, supplemental checks and AI/human reviews as distinct evidence classes. |
| Time and tokens | Scoped observations, eligible comparisons, accounting limits and missingness; repeated comparisons include counts and descriptive distributions. |
| Outcome and code changes | Artifacts/task-end changes, inspected criteria, tradeoffs and reviewer judgments supporting a scoped better/worse/inconclusive conclusion. Code diff stays last. |

Use this order in the primary report and Markdown export. JSON, compaction and
frozen reopen retain claims, references and limits. Put coverage beside the claim
it qualifies. Preserve originals while presenting a coherent current comparison
that includes later review and supplemental evidence.

Review is optional: human only, another AI agent only, both, or not reviewed.
Identify type, reviewer/model where known, method, evidence, rubric when used,
scope and revisions. Keep AI and human judgments distinct, retain disagreement,
and never fabricate human ratings. A pilot's requirement for both is not universal.
An automatic judge is not required to support review of an exported packet and
attachment of its attributed result.

A single pair is useful with consistency marked unmeasured. Repeated evidence
shows all selected/planned samples, eligible pairs, failures, incomplete/unknown
observations, recurring and contradictory behavior, and associated outcomes.
Existing sessions need not have been scheduled by xfx to contribute; disclose the
selected corpus and any unknown planning denominator. Synthetic controls and
passing tests alone do not establish actual behavioral consistency.

## Observable acceptance

The Codex macOS release meets the product contract when users can:

- Create/change profiles independently and inspect setup differences across the
  requested categories, with sources, useful safe detail and explicit gaps.
- Use both audit entry paths, including directly started CLI and Desktop sessions, and
  understand task association and recorded conditions without reconstruction.
- Follow material behavior findings to paired evidence; intentional setup
  differences do not erase supported observations.
- Inspect outcomes and optional AI/human review, distinguish original failures
  from supplemental results, and make a scoped decision or accept inconclusiveness.
- Assess consistency across comparable repetitions/tasks with all sample states;
  one real pair alone does not complete this acceptance.
- Export/reopen comparison and review evidence after original sources disappear,
  retaining unavailable artifact states rather than fabricating them.
- Complete normal local use and interruption handling with user-owned state preserved.

Acceptance needs actual Codex CLI/Desktop evidence plus meaningful fixture
controls, usable command-line reports and user documentation. The roadmap also
requires preserved profile/client state, interruption/recovery checks and a
verified installable package from the final source. Historical evidence must be
reassessed for the changed paths; test counts or a mockup cannot replace that.
Release-ready means those gates pass with no unresolved blocker to these outcomes;
publication and updating an existing installation are separate authorized actions.
Future provider releases apply the same outcome contract to their declared scope.

## Privacy, uncertainty and drift guard

Raw prompts/transcripts, tool arguments/results, secrets, private paths and
sensitive artifacts are not automatically public report material. Local setup
diff may show selected safe configuration/source content; public exports require
sanitization and an explicit content boundary. Do not silently turn normalized
audit payloads into full transcript or secret storage to implement readable diffs.

Do not invent actor ownership, one-to-one matches, synchronized clocks, intent,
active/waiting time, billed cost or universal winners. Faster execution or fewer
tokens do not establish better quality. Relate behavior to outcomes only at the
supported scope; preserve failures and originals rather than rewriting failures
as successes.

Before adding work, state which setup-diff or audit question it improves, what
observable result proves it, and why any supporting dependency is necessary.
Reuse current discovery, session, comparison, review and persistence paths;
avoid duplicate pipelines and infrastructure projects. Keep one active roadmap;
historical receipts and old resume instructions do not control new work.

This definition grants no permission to execute model tasks, operate accounts/
clients, spend money, commit, publish, release or update installed applications.
Current authorization governs those actions; old grants do not renew.
