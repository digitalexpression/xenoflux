# Desktop launcher history

Historical observations, not current instructions or proof for later vendor builds.
Full originals/private receipts remain retained; [current rules](../DESKTOP-IMPLEMENTATION.md)
own supported launch, identity and cleanup behavior.

| Record | Outcome / limit |
| --- | --- |
| 2026-10-11/12 native checks | Concurrent open and repeat-open focus confirmed; two profiles remained running with unchanged PID/start identity. No claim about current processes, sign-in/reboot or all isolation boundaries. |
| Re-signed vendor bundles | Nested-framework signing caused library-validation failures missed by static checks. The copied-main workaround is retired; the current path launches the original signed vendor app. |
| Desktop HOME | Isolated HOME triggered “Keychain Not Found”; account HOME restored native keychain discovery. Account/group state can remain shared. |
| Process observation | ASCII output corrupted Unicode paths; UTF-8 labels and kernel-derived start times fixed receipt matching. |
| Legacy bootstrap | Same-PID exec and nested-signature/routing behavior had synthetic fixtures. Stopped legacy caches could be replaced; running instances retained pinned executables/helpers. Finder/Dock could not refresh an executing bootstrap. |

Later source-bound concurrency evidence: [3.1.0 native validation](NATIVE-VALIDATION-3.1.0.md).
