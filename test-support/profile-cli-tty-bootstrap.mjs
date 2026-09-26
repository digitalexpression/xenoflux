// Mark piped subprocess streams as TTYs so the real readline prompts run with
// deterministic test input, without allocating or touching a host terminal.
process.stdin.isTTY = true;
process.stdout.isTTY = true;
