# Architecture

## Purpose

Bluetooth mode turns a Pi into a phone headset: the caller hears converted speech,
and the local user hears the call through a USB headset. The design favors bounded
latency and recovery over lossless buffering.

## Audio path

```text
USB microphone
  -> arecord (48 kHz, mono, signed 16-bit PCM)
  -> RTCAudioSource
  -> Convbased SDK / WebRTC / TURN
  -> converted MediaStreamTrack
  -> RTCAudioSink
  -> pw-cat
  -> convbased_out monitor
  -> transient bluez_output HFP input
  -> phone microphone uplink

phone HFP downlink
  -> transient bluez_input output
  -> USB headset playback
```

HFP nodes exist only during calls and can change IDs. The app therefore writes to the
persistent `convbased_out` PipeWire sink. The linker attaches its monitor to each
current uplink and removes WirePlumber's raw-microphone link.

## Components

| Component | Role |
| --- | --- |
| `index.mjs` | Resolves configuration and owns the SDK session and output. |
| `polyfill.mjs` | Installs Node.js WebRTC globals before the browser-oriented SDK loads. |
| `alsa.mjs` | Converts ALSA capture chunks into 10 ms WebRTC frames. |
| `pcm-pipe.mjs` | Restarts the output player when track format changes. |
| `bounded-pcm-writer.mjs` | Drops frames while a player pipe is blocked. |
| `webui.mjs` | Exposes status plus local mute and sidetone controls. |
| `bluetooth-mic/scripts/linker.py` | Reconciles transient HFP links every 500 ms. |
| systemd units | Start, recover, and stop user and adapter services. |

## Session lifecycle

1. Load the mode-`0600` environment file outside the checkout.
2. Resolve settings: server profile, local cache, then environment.
3. Fetch TURN credentials and give the SDK UDP/TCP relay URLs.
4. Start ALSA capture and one WebRTC session.
5. Write converted tracks to ALSA or `convbased_out`.
6. On session failure, exit so systemd starts a fresh client.

Exit status `78` marks local configuration or rejected credentials. The service unit
does not retry that status. Network and session failures remain retryable.

## Real-time behavior

- Capture produces 10 ms mono PCM frames.
- `arecord` restarts with bounded exponential backoff after transient exits.
- A blocked playback pipe causes frame drops instead of an unbounded queue.
- Some sessions begin with a 16 kHz preamble before settling at 48 kHz. The player is
  relaunched on a format change; that expected exit is not logged as a failure.

## Bluetooth control plane

The adapter advertises a headset class and uses CVSD. The pairing agent exposes a
bounded Just Works window; paired devices remain trusted afterward.

Some UART Broadcom/Cypress controllers need an HCI vendor command for SCO-over-HCI.
`auto` applies it only to compatible hardware. Recovery is rate-limited.

## Trust boundaries

- The API key reaches only the local process and Convbased HTTPS/WSS endpoints.
- TURN credentials must not enter logs.
- The status page is intended for LAN use.
- Bluetooth Just Works pairing authenticates proximity, not identity.
- The linker owns the HFP uplink and removes competing feeders.

See [Security](../SECURITY.md) for deployment controls and
[Validation](VALIDATION.md) for tested boundaries.
