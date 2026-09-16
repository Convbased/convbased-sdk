# Real-time voice conversion on Raspberry Pi

This integration sends ALSA PCM through the Convbased JavaScript SDK and plays the
converted track through ALSA or PipeWire. In Bluetooth mode, a Pi 4 acts as an HFP
headset: phone audio plays through a USB headset, and converted microphone audio
returns to the phone.

> Keep API keys outside the repository. Read [Security](SECURITY.md) before exposing
> the status panel or pairing agent.

## Operating modes

| Mode | Output | Purpose |
| --- | --- | --- |
| Headless audio | `OUTPUT=alsa` | Play converted speech on a local ALSA device. |
| Bluetooth appliance | `OUTPUT=pipewire` | Feed a phone's HFP microphone during a call. |

For the phone case, read [`bluetooth-mic/README.md`](bluetooth-mic/README.md).

## Reference platform

The tested path is a Pi 4 with 64-bit Debian, PipeWire, WirePlumber, BlueZ, Node.js
20, and a USB headset. See [`docs/VALIDATION.md`](docs/VALIDATION.md).

## Quick start: plain ALSA mode

```bash
npm install
npm run build --workspace @convbased/sdk

cd integrations/raspberry-pi
API_KEY=your_key \
MODEL_ID=your_model \
MIC_DEVICE=plughw:CARD=Device,DEV=0 \
SPK_DEVICE=plughw:CARD=Device,DEV=0 \
OUTPUT=alsa \
npm start
```

List devices with `arecord -l` and `aplay -l`. Prefer stable `CARD=` names.

Configuration: [convbased-app.env.example](bluetooth-mic/convbased-app.env.example).

The integration exchanges `API_KEY` for short-lived SDK tokens; signaling uses one-time tickets. Keep the key in the mode-`0600` environment file outside the repository.

## Realtime billing switch

The web console owns `realtime_enabled` for each device profile. Turning it off disconnects the billable session. Turning it on reconnects at the next profile poll.

Keep `PROFILE_POLL_MS` above zero when using the switch.

## Development and checks

Run the [reproducible checks](docs/VALIDATION.md#reproducible-checks) from the repository root.

Useful diagnostics:

```bash
node synth-loopback.mjs   # software-only WebRTC audio path
node loopback.mjs         # real ALSA mic -> local WebRTC -> speaker
```

## Documentation

- [Bluetooth appliance quick start](bluetooth-mic/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations and troubleshooting](docs/OPERATIONS.md)
- [Validation matrix and evidence](docs/VALIDATION.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Known limits

- Phone microphone audio requires an HFP/HSP call-type session.
- CVSD provides call-quality, not hi-fi, audio.
- Pi 4 Bluetooth and 2.4 GHz Wi-Fi share radio resources; use Ethernet or 5 GHz Wi-Fi.
- End-to-end service requires a paid, valid account, an accessible model, and TURN.

## License

This integration is covered by the repository's [MIT License](../../LICENSE).
