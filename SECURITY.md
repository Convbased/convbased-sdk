# Security

Only the latest commit on `main` receives security fixes.

Report vulnerabilities through GitHub private vulnerability reporting. Include the affected revision,
impact, reproduction steps, and mitigation if known. Never include live credentials, personal audio,
device addresses, or unredacted journals.

Treat API keys, TURN credentials, Bluetooth addresses, call metadata, logs, and audio as sensitive.
Rotate any credential exposed in a commit, issue, screenshot, or shared log.

For Raspberry Pi deployments, use a dedicated unprivileged account, keep pairing windows bounded,
bind the status panel to localhost when remote access is unnecessary, and never expose it directly to
the Internet. See the integration's [security guide](integrations/raspberry-pi/SECURITY.md).
