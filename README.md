# Convbased SDK

Browser SDK for real-time voice conversion, file conversion, and text-to-speech, with a Raspberry Pi Bluetooth integration.

```bash
npm install @convbased/sdk
```

Version 0.3 uses short-lived SDK tokens and one-time signaling tickets. Replace browser `apiKey` options with `auth.tokenProvider`; keep long-lived keys on your backend. See the [SDK guide](packages/sdk-js/README.md) for usage and migration.

| Path | Contents |
| --- | --- |
| [packages/sdk-js](packages/sdk-js/) | Browser SDK published as `@convbased/sdk`. |
| [integrations/raspberry-pi](integrations/raspberry-pi/) | Pi 4 Bluetooth HFP voice-conversion integration. |
| [examples](examples/) | H5 and TypeScript examples. |

## Raspberry Pi

A Pi 4 acts as an HFP headset named **Convbased Mic**. A USB headset provides local capture and playback; the phone call receives the converted voice. Follow the [setup guide](integrations/raspberry-pi/README.md) for Debian 13 arm64, Node.js 20, BlueZ, PipeWire, and WirePlumber.

## Development

```bash
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run check --workspace convbased-raspberry-pi
git diff --check
```

On Linux, run `./integrations/raspberry-pi/bluetooth-mic/check.sh` for Bash and Python checks.

[Developer documentation](https://docs.weights.chat/) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
