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

## Quick start: Bluetooth phone case

```bash
git clone https://github.com/Convbased/convbased-sdk.git ~/convbased-sdk
cd ~/convbased-sdk/integrations/raspberry-pi/bluetooth-mic
./setup.sh

nano ~/convbased-bt/convbased-app.env
systemctl --user enable --now convbased-app.service
```

Set `API_KEY`, plus `MODEL_ID` if the device profile has no model. The mode-`0600`
environment file lives outside the repository.

Pair **Convbased Mic**, enable **Phone calls**, and start a call. HFP ports exist only
while call audio is active.

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

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `API_KEY` | yes | none | Convbased API credential. |
| `MODEL_ID` | conditional | server profile | Fallback model when no device profile is bound. |
| `RATE` | no | `48000` | Capture and advertised sample rate. |
| `MIC_DEVICE` | no | ALSA default | Capture device. |
| `SPK_DEVICE` | no | ALSA default | Playback device for `OUTPUT=alsa`. |
| `OUTPUT` | no | `alsa` | `alsa` or `pipewire`. |
| `PW_TARGET` | no | `convbased_out` | PipeWire sink for converted audio. |
| `PITCH` | no | `12` | Initial pitch; server profile or cache may override it. |
| `PROFILE_POLL_MS` | no | `20000` | Device-profile refresh interval; `0` disables it. |
| `WEBUI_PORT` | no | `8080` | Status panel port; `0` disables it. |
| `WEBUI_HOST` | no | `0.0.0.0` | Bind address; use `127.0.0.1` for local-only access. |
| `WEBUI_TOKEN` | no | empty | Optional token protecting mute and sidetone mutations. |
| `SIGNALING_URL` | no | production | Self-hosted signaling override. |

Template: [`bluetooth-mic/convbased-app.env.example`](bluetooth-mic/convbased-app.env.example).

## Realtime billing switch

The web console owns `realtime_enabled` for each device profile. Turning it off
disconnects the billable session. The Pi then polls only the profile; it does not
capture audio, fetch TURN credentials, or open signaling. Turning it on reconnects
within `PROFILE_POLL_MS` (20 seconds by default).

Keep `PROFILE_POLL_MS` above zero when using the switch. A missing profile preserves
legacy API-key behavior. New profiles start off; migrated profiles keep their prior
running state until changed.

## Development and checks

```bash
npm run check --workspace convbased-raspberry-pi
```

```bash
./integrations/raspberry-pi/bluetooth-mic/check.sh
```

The Linux check adds Bash syntax, Python bytecode, and optional ShellCheck.

Useful diagnostics:

```bash
node synth-loopback.mjs   # software-only WebRTC audio path
node loopback.mjs         # real ALSA mic -> local WebRTC -> speaker
```

## Documentation

- [Bluetooth appliance quick start](bluetooth-mic/README.md)
- [Architecture and design decisions](docs/ARCHITECTURE.md)
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
