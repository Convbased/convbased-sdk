# Raspberry Pi Bluetooth voice-changing headset

The Pi appears to a phone as the **Convbased Mic** HFP headset. During a call:

- the phone's downlink plays through a USB headset connected to the Pi;
- the USB headset microphone enters the Convbased real-time service;
- the converted track returns through the phone's HFP microphone uplink.

The Pi 4 and Android test matrix is in
[`../docs/VALIDATION.md`](../docs/VALIDATION.md).

## Requirements

- Raspberry Pi 4 with 64-bit Debian 13/Raspberry Pi OS.
- PipeWire, WirePlumber, and BlueZ.
- A USB headset with capture and playback devices.
- Ethernet or 5 GHz Wi-Fi.
- A Convbased API key with an accessible model and no account-level usage block.
- A phone that exposes HFP/HSP call audio.

## Install

Run the idempotent setup as the service user:

```bash
cd ~/convbased-sdk/integrations/raspberry-pi/bluetooth-mic
./setup.sh
```

It installs dependencies, audio policy, systemd units, adapter recovery, and the
pairing agent. It preserves `~/convbased-bt/convbased-app.env`.

Configure credentials and audio:

```bash
nano ~/convbased-bt/convbased-app.env
chmod 600 ~/convbased-bt/convbased-app.env
```

Set:

```dotenv
OUTPUT=pipewire
PW_TARGET=convbased_out
MIC_DEVICE=plughw:CARD=Device,DEV=0
API_KEY=your_key
MODEL_ID=your_model_if_no_server_profile_is_bound
```

Keep real keys out of the repository, shell history, screenshots, and issue logs.

The device's web-console **Realtime service** switch controls billing. Off disconnects
conversion and leaves only profile polling; on reconnects within about 20 seconds.

## Pair the phone

The agent opens a five-minute Just Works window:

```bash
systemctl --user restart convbased-btagent.service
bluetoothctl show
```

Select **Convbased Mic** and enable **Phone calls**. No PIN is required. The window
closes automatically; paired devices remain trusted.

For a wrong PIN or pairing-key error, forget **Convbased Mic** on the phone, remove
the Pi bond, and pair again:

```bash
bluetoothctl devices
bluetoothctl remove <PHONE_MAC>
systemctl --user restart convbased-btagent.service
```

## Start the converter

```bash
systemctl --user enable --now convbased-app.service
systemctl --user status convbased-app.service
```

A healthy session reaches `connected` and writes 48 kHz audio to `convbased_out`.
Configuration and credential failures exit with status `78` without retries.

## Start a call and verify the route

Start a cellular or compatible VoIP call, select **Convbased Mic**, then run:

```bash
wpctl status
pw-link -l | grep -A3 -B1 -E 'bluez_(input|output)|convbased_out'
hciconfig -a
```

Expected active routes:

```text
bluez_input.<MAC>  -> USB headset playback
convbased_out:monitor_MONO -> bluez_output.<MAC>:input_MONO
```

SCO RX and TX counters should rise with zero errors. Confirm at the far end that only
the converted voice is audible; routing data cannot prove audio content.

## Headset volume

`setup.sh` selects the USB headset. Start at 80% and adjust cautiously:

```bash
wpctl set-mute @DEFAULT_AUDIO_SINK@ 0
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.80
wpctl get-volume @DEFAULT_AUDIO_SINK@
```

Avoid gain above 100% until clipping and hearing safety are checked.

## Services

| Unit | Scope | Responsibility |
| --- | --- | --- |
| `convbased-app` | user | USB mic -> SDK -> `convbased_out`. |
| `convbased-btagent` | user | Bounded Just Works pairing and trust. |
| `convbased-link` | user | Converted sink monitor -> transient HFP uplink. |
| `convbased-btclass` | system | Adapter readiness, headset class, SCO-over-HCI. |
| `convbased-scoroute@` | system | Reapply readiness after adapter appearance. |
| `convbased-bt-recover` | system | Cooldown-limited controller recovery. |

Inspect logs without printing the environment:

```bash
journalctl --user -u convbased-app.service -f
journalctl --user -u convbased-btagent.service -f
journalctl --user -u convbased-link.service -f
sudo journalctl -u convbased-btclass.service -u convbased-bt-recover.service -f
```

Application logs redact signaling credentials.

## Adapter policy

Edit `/etc/default/convbased-bt`, then restart affected units. Empty
`CONVBASED_HCI` selects an adapter automatically; `hci1` pins one. In `auto` mode,
the SCO vendor route applies only to compatible UART Broadcom/Cypress controllers.
Never set `CONVBASED_PAIRING_WINDOW_SEC=0` outside a controlled area.

## Next references

- [Architecture](../docs/ARCHITECTURE.md)
- [Operations and troubleshooting](../docs/OPERATIONS.md)
- [Validation evidence](../docs/VALIDATION.md)
- [Security](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
