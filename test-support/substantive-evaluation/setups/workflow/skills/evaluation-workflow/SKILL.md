---
name: evaluation-workflow
description: Complete a bounded coding change from its contract and verify observable behavior.
---
Read the task's README and existing source/tests. Identify the public API,
state and error contract before editing. Keep changes within the named editable
files. Implement the complete requested behavior with existing runtime features.
Check boundary conditions, input mutation, error paths and observable integration
behavior that follow from the contract. Run visible checks, inspect the final diff
and explain what passed and what remains unverified. Do not inspect outside the
workspace, install dependencies, access the network or modify Git metadata.
