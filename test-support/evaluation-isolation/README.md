# Historical isolation test support

Dormant campaign support, not a product prerequisite. [Outcome and limits](../../docs/developer/history/README.md#offline-isolation); full original runbook/receipts remain privately preserved. No paid execution or daemon startup is authorized here.

| Helper | Boundary |
| --- | --- |
| `verify-apple.mjs` | Known disposable offline VM controls only; verifies stopped VM configuration before execution. |
| `guest-probes.mjs` | Guest-only; never run on the host. |
| `prepare-envelope.mjs` | Freezes a separate pending 12-slot envelope; optional runtime metadata binds retained worker evidence. Does not alter the original campaign. |
| `check-isolated.mjs` | Validates pending envelope/candidate in the VM with safety controls; cannot launch a model or approve paid work. |
| `snapshot-candidate.py` | Bounded descriptor-relative/no-follow acquisition using macOS Python; never imports candidate code. |
| `native-policy.mjs` | Restricted whole-client policy; managed-preference synchronization blocked actual native startup. No working native-isolation claim. |

Preserve blocked launchers and frozen gates. Do not replace host isolation with model-task sandboxing, start another installation's services, copy credentials or weaken production preservation controls. Recovery requires the original private runtime/ownership receipts and current authorization.
