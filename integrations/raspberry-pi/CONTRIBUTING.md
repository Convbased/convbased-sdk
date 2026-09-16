# Contributing

Follow the [repository conventions](../../CONTRIBUTING.md), [architecture](docs/ARCHITECTURE.md) and [security requirements](SECURITY.md).

- Reuse standard Node.js, Python, Bash, BlueZ and PipeWire interfaces.
- Bound retries, buffers, timeouts and privileged operations; preserve setup idempotence and graceful shutdown.
- Handle transient HFP nodes and mid-stream sample-rate changes. Explain hardware constraints and policy in comments.
- Track hardware-specific changes in an issue and record the device, OS, kernel, audio stack and network.

Run the [reproducible checks](docs/VALIDATION.md#reproducible-checks). Hardware claims require sanitized runtime evidence and far-end audio verification. Keep credentials, device addresses, call details and recordings out of shared evidence.
