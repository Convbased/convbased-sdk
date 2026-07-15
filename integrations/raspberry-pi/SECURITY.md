# Security

This integration controls a microphone, Bluetooth pairing, audio routes, and an API
credential. Treat the Pi as an appliance.

## Credentials

- Store `API_KEY` only in `~/convbased-bt/convbased-app.env` with mode `0600`.
- Keep credentials out of commits, command lines, and shell history.
- Do not post the environment, TURN response, or raw journal.
- Rotate a key immediately if it appears in a commit, issue, screenshot, or shared log.
- Logs redact `api_key` and `token` query values. Redaction does not make logging safe.

Reject keys, bearer tokens, private keys, and captured audio during review.

## Network surface

The status panel binds to all interfaces by default. For local-only use, set:

```dotenv
WEBUI_HOST=127.0.0.1
WEBUI_TOKEN=a-long-random-value
```

For LAN access, use a host firewall. Do not expose the panel to the Internet. The token
protects mutation routes; same-origin checks do not authenticate users.

Allow only required Convbased API, signaling, and TURN traffic. Do not disable TLS.

## Bluetooth

- Keep `CONVBASED_PAIRING_WINDOW_SEC` bounded; the default is five minutes.
- Reopen pairing only while physically present.
- Remove unknown bonds with `bluetoothctl remove <MAC>`.
- Just Works does not authenticate device identity. Use it only in a controlled area.
- Pin `CONVBASED_HCI` when multiple adapters make automatic selection ambiguous.

## Host controls

- Use a dedicated, unprivileged service account and keep the OS patched.
- Limit `sudo` access. Only adapter setup and recovery require system services.
- Protect the journal and home directory; both contain operational metadata.
- Review systemd, udev, WirePlumber, and `/usr/local/bin` changes before `setup.sh`.
- Lock dependency versions through the repository lockfile and review lockfile changes.

## Reporting a vulnerability

Report credential leaks and exploitable flaws privately. Include the revision, impact,
reproduction, and mitigation if known; omit live secrets and personal audio. Coordinate
disclosure and key rotation with maintainers.
