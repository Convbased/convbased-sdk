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

Run setup as the service user:

```bash
git clone https://github.com/Convbased/convbased-sdk.git ~/convbased-sdk
cd ~/convbased-sdk/integrations/raspberry-pi/bluetooth-mic
./setup.sh
```

Setup preserves `~/convbased-bt/convbased-app.env`.

Configure credentials and audio:

```bash
nano ~/convbased-bt/convbased-app.env
chmod 600 ~/convbased-bt/convbased-app.env
```

Set `API_KEY`, select the USB headset in `MIC_DEVICE`, and set `MODEL_ID` if no server profile is bound. Other options are in [convbased-app.env.example](convbased-app.env.example).

Keep real keys out of the repository, shell history, screenshots, and issue logs.

The web-console **Realtime service** switch controls billing. Keep profile polling enabled; see [Realtime billing switch](../README.md#realtime-billing-switch).

## Pair the phone

The agent opens a five-minute Just Works window:

```bash
systemctl --user restart convbased-btagent.service
bluetoothctl show
```

Select **Convbased Mic** and enable **Phone calls**. No PIN is required. The window
closes automatically; paired devices remain trusted.

For pairing errors, see [pairing and reconnection](../docs/OPERATIONS.md#pairing-and-reconnection).

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

## Operation

Service definitions are in [systemd/](systemd/). See Operations for [audio level](../docs/OPERATIONS.md#audio-level), [logs](../docs/OPERATIONS.md#logs), [service lifecycle](../docs/OPERATIONS.md#service-lifecycle) and [rollback](../docs/OPERATIONS.md#safe-rollback).

## Adapter policy

Edit `/etc/default/convbased-bt`, then restart affected units. Options are in [convbased-bt.default](config/convbased-bt.default). Never set `CONVBASED_PAIRING_WINDOW_SEC=0` outside a controlled area.

## Next references

- [Architecture](../docs/ARCHITECTURE.md)
- [Operations and troubleshooting](../docs/OPERATIONS.md)
- [Validation evidence](../docs/VALIDATION.md)
- [Security](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
