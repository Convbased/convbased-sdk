# Contributing

Make the integration easier to reproduce, operate, or audit. Keep changes scoped and
report observations.

## Before changing code

1. Read [Architecture](docs/ARCHITECTURE.md) and [Security](SECURITY.md).
2. Open or reference an issue for hardware-specific behavior.
3. Record test hardware, OS, kernel, BlueZ, PipeWire, WirePlumber, Node.js, and network.
4. Remove keys, relay credentials, addresses, call details, and recorded speech.

## Code and comments

- Match `.editorconfig`; use UTF-8, LF endings, and the existing indentation.
- Prefer standard Node.js, Python, Bash, BlueZ, and PipeWire interfaces.
- Bound retries, buffers, timeouts, and privileged operations.
- Treat transient HFP nodes and mid-stream sample-rate changes as normal events.
- Explain hardware constraints and non-obvious policy, not syntax.
- Keep logs actionable and redact credentials before logging.
- Preserve idempotence in `setup.sh` and graceful shutdown in long-running processes.

## Tests

Run from the repository root:

```bash
npm run check --workspace convbased-raspberry-pi
npm run build
npm run typecheck
git diff --check
```

On Linux/Pi:

```bash
./integrations/raspberry-pi/bluetooth-mic/check.sh
```

Test failure policy, buffering, lifecycle, redaction, and HTTP controls deterministically.
Hardware claims need sanitized runtime evidence; mocks cannot prove routing or audio.

## Pull request checklist

- [ ] The title states the user-visible outcome.
- [ ] The body links the issue and separates verified facts from assumptions.
- [ ] New configuration has a safe default and documentation.
- [ ] Code, comments, examples, and service units agree.
- [ ] No credentials, personal identifiers, captured audio, or generated dependencies
      are committed.
- [ ] Portable checks pass.
- [ ] Pi/Linux checks pass, or the missing hardware boundary is explicit.
- [ ] Operational and security effects are described.
- [ ] The change remains covered by the repository's MIT License.

Use a draft PR when evidence is incomplete. Merge only after code and hardware review.
