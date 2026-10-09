# Profile creation and copy policy

Accepted: 2026-10-02. Scope: profile creation, comparison, copy, and their user flows.
This is the development and review contract. The local implementation follows it;
the published `0.3.0-rc.6` release predates these changes. See
[current copy behavior](ADVANCED-COPY.md) and the evidence boundary below.

## Purpose

Optimize first for creating a new profile, either fresh or from selected parts of
another profile. Once activated, profiles evolve independently. A later copy is a
reviewed update with a clear source/destination diff, not synchronization or a clone
of effective runtime state. Prefer a new profile or a small reliable update over
complex migration of integrations and internal state. Do not maintain ongoing
profile relationships, a synchronization baseline, or a generic migration framework.

## Rules

1. **One preservation policy across all entry points.** Creation from a source and
   subsequent copies use explicit selections and the same preservation semantics.
   Unselected settings and destination-only items remain unchanged. Category options
   may select supported items but must not implicitly delete destination-only items.
   `Default` remains a source and restoration destination, not a copy target.

2. **Show the diff before changing an existing profile.** Identify the source,
   destination, item origin, and proposed additions, changes, removals, identical
   items, and items kept at the destination. Show before/after supported config
   values and reviewable file changes without exposing secrets. Identify limitations,
   missing dependencies, manual setup, and unknown state separately. Apply only
   selected operations whose effects and recovery are understood and verified;
   otherwise provide guidance or omit the operation with a reason. Do not infer
   deletions from absence in the source. Identical selections are no-ops.

3. **Replace selected skill packages exactly, never overlay them.** A selected
   standalone skill includes its supported files, resources, scripts, and relevant
   modes. For a differing existing package, offer keep/skip or explicit replacement.
   Replacement makes the destination package match the source: preview and remove
   destination-only files inside that package, while preserving everything outside
   it. Refuse unsafe, unsupported, or partial packages before mutation. Do not resolve
   ambiguous same-name sources silently. If exact replacement and recovery cannot
   be guaranteed, refuse replacement rather than falling back to an overlay.

4. **Use native/manual setup for plugins, hooks, and MCP.** Xenoflux must not copy,
   install, enable, connect, or migrate their definitions or internal state as part
   of profile copying, including through a broad config copy. Print only necessary,
   conditional setup steps for integrations the user wants. Identify the actual
   source/marketplace and version when known; distinguish installation, enablement,
   trust, dependencies, and account connection. Group plugin-provided skills, hooks,
   and MCP definitions under their parent plugin. Do not turn them into standalone
   copies. Do not generate installation tasks from cache presence alone. Automating
   these operations later requires an explicit revision of this policy.

5. **Respect ownership and isolation.** Keep project resources in the project and
   rely on existing native sharing only where the effective roots and scope support
   it. Do not add cross-profile symlinks or a shared-storage manager. Do not transfer
   credentials, granted permissions, cached authorizations, project/hook trust,
   generated memory, conversation stores, databases, or runtime caches. Explicitly
   selected supported policy settings and rule files are definitions, not migrated
   grants; their effects must be visible in the preview. Preserve destination storage
   and authentication routing. Human-reviewed durable guidance may be transferred as
   instructions or a handover, not as a bulk memory migration.

6. **State only what the evidence establishes.** Presence, configuration,
   installation, enablement, discovery, and runtime availability are separate facts.
   A publisher, path, manifest, or cache entry alone does not prove personal ownership
   or built-in status. Keep unknown origin/state explicit. Report bounded discovery
   and unavailable paths rather than claiming completeness. Do not promise that
   copied files install dependencies or rewrite external references. A resumed or
   forked conversation is not a clean destination context; recommend a fresh
   conversation with a user-reviewed handover when that is the desired outcome.

7. **Keep the flow and recovery small.** Reuse the existing preview, transaction,
   conflict, journal, undo, and recovery mechanisms. Revalidate reviewed inputs before
   applying. Undo must restore replaced and removed package files and relevant modes,
   and refuse to overwrite subsequent user edits. Preserve existing recovery records
   and compatibility with their readers. Manual setup is outside copy undo. End with
   a concise result and conditional setup guide, not a persistent todo database.
   Preparation, copying, sign-in, and activation remain distinct outcomes; a later
   setup failure must not silently discard a completed copy.

8. **Verify the promised path.** Use fixture-backed checks for exact changes,
   preservation, conflicts, interruption, and undo. Native discovery and actual
   execution/enforcement require their own evidence for the relevant client version
   and interface. Neither a passing file-copy test nor a discovery listing proves
   runtime behavior. Retain required repository checks; add checks for meaningful
   uncovered behavior, not implementation mirrors. Documentation or fixture work
   does not authorize live profile mutation, client shutdown, installation, or release.

## Action boundary

| Item | Copy policy |
| --- | --- |
| Supported config keys, global instructions, agent definitions, rule files | Selected reliable changes with a diff, explicit conflict decisions, and undo. No arbitrary whole-config migration. |
| Standalone skills, including self-contained third-party skills | Add, no-op, skip, or exact package replacement under rule 3. Ownership and external dependency uncertainty remain visible. |
| Plugins, standalone hooks, MCP definitions/connections | Native/manual setup guide only. No automatic definition or activation transfer. |
| Plugin-provided components | Handle once through the parent plugin. |
| Project resources and client-provided built-ins | Leave with their existing owner. Shared availability must not be assumed across different CLI/desktop environments. |
| Generated memory and conversations | No copy/import. Retain native resume in the owning profile; use a reviewed handover for a fresh destination conversation. |
| Unknown artifacts, caches, credentials, trust, runtime state | No automatic transfer. Explain relevant unknowns without exposing private contents. |

## Concrete acceptance cases

- Creating from another profile copies only the selected supported items. Inspection
  and preview do not create a profile, close clients, or activate integrations.
- After activation, changing a supported config value in the destination produces a
  clear before/after diff on the next copy. Applying that selected key preserves
  other settings and destination-only agents across every copy entry point.
- Replacing `skills/review-helper` lists an obsolete destination-only script for
  removal. The resulting package matches the source; another skill remains untouched.
  Undo restores the old package, including that script and its mode. An intervening
  edit causes a safe refusal, not silent data loss.
- A changed plugin or MCP entry produces a conditional native setup instruction,
  not a config write. Exact identity prevents duplicate plugin/component todos;
  known existing destination state suppresses redundant actions. When that state
  cannot be established, say "check first; install only if absent." Do not claim a
  complete integration diff from partial metadata.
- A source conversation or generated memory file cannot be selected for transfer.
  A continuation guide does not claim that destination instructions erase history.

## Implementation and evidence boundary

Baseline: Xenoflux `0.3.0-rc.6`, commit `96a90204`, inspected 2026-10-02.
The `codex/profile-copy-policy` implementation changes that baseline as follows:

- [Selected skill copy](../src/advanced-copy.js) replaces supported packages exactly,
  including removals and supported directory modes. Its v3 journal supports undo and
  interruption recovery; the reader retains v1/v2 compatibility. File/directory
  type transitions, unsafe contents and directories without owner read/write/execute
  permissions are refused before mutation.
- [Category copy](../src/native-copy.js) selects items through the same planner and
  preserves source-absent destination settings, instructions and agents. An identical
  or empty selection does not prepare clients or create a transaction.
- [Copy selection](../src/advanced-command.js) uses bounded settings/standalone
  inventory and separate [manual setup guidance](../src/setup-guidance.js). It does
  not scan conversations, memory, project contents or plugin caches. Full diagnostic
  inspection retains its broader scope. Local plugin manifest versions describe the
  source package only; installed versions and runtime availability remain unknown.
- Fixture and package checks establish transfer/preservation behavior only. On
  2026-10-02, candidate `2074a34` passed a disposable native CLI `0.157.1` check:
  the destination skill appeared in native context, its resource was read, its
  executable ran, and the copied rule rejected its harmless marker command. Undo
  restored the prior package and removed the rule; a fresh session then ran the
  same marker successfully. Copy used the candidate planner/executor with isolated
  locks; this does not verify live desktop client coordination.
- The subsequent desktop check passed on app `26.930.21537` (12776), backend
  `0.159.0-alpha.12.1`: Advanced Check was observed active, native context discovered
  the synthetic profile skill, its resource/script produced the expected tool
  outputs, and a separate task received the exact native rule denial. Default
  restoration and guarded fixture cleanup passed. Tasks used desktop-created
  folders under Documents/Codex. Fixtures were staged directly; this establishes
  native profile loading in those contexts, not arbitrary project precedence or
  another interactive copy test. Existing profile data and sign-in were preserved.

Record candidate-specific check results in the local handover. Do not present this
unpublished implementation or fixture evidence as released native acceptance.
