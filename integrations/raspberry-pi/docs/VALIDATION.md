# Validation record

These results were observed on 2026-07-15. They do not imply support for other
hardware, kernels, or networks.

## Reference system

| Layer | Tested value |
| --- | --- |
| Computer | Raspberry Pi 4 Model B Rev 1.5 |
| OS | Debian 13, arm64 |
| Kernel | `6.12.75+rpt-rpi-v8` |
| Node.js / npm | `20.20.2` / `10.8.2` |
| Bluetooth | BlueZ `5.82` |
| Audio | PipeWire `1.4.2`, WirePlumber `0.5.8` |
| Phone | OPPO Find X8, Android |
| Local audio | USB Composite Device headset |
| Network | LAN with reachable Convbased HTTPS, WSS, and TURN endpoints |

Record test source with `git rev-parse HEAD`; branch names are insufficient.

## Verified end-to-end

One real call verified:

- bounded Just Works pairing, bonding, trust, reconnection, and pairing-window closure;
- phone HFP call downlink to both USB-headset playback channels;
- USB microphone capture to the SDK at 48 kHz mono;
- API authentication, device-profile resolution, WSS signaling, TURN relay, and media;
- converted remote track playback into `convbased_out`;
- `convbased_out:monitor_MONO` to the transient phone HFP microphone input;
- rising SCO RX and TX counters for five seconds, with zero errors;
- far-end receipt of converted speech without a parallel raw-microphone link;
- SDK signaling logs with the API-key query value replaced by `<redacted>`;
- USB-headset software playback volume set and confirmed at 80%.

Paid, unblocked usage was a test prerequisite, not a software fix.

## Reproducible checks

Portable repository checks:

```bash
npm run check --workspace convbased-raspberry-pi
npm run build
npm run typecheck
git diff --check
```

Linux/Pi checks:

```bash
./integrations/raspberry-pi/bluetooth-mic/check.sh
systemd-analyze --user verify \
  integrations/raspberry-pi/bluetooth-mic/systemd/convbased-app.service \
  integrations/raspberry-pi/bluetooth-mic/systemd/convbased-link.service \
  integrations/raspberry-pi/bluetooth-mic/systemd/convbased-btagent.service
sudo systemd-analyze verify \
  integrations/raspberry-pi/bluetooth-mic/systemd/convbased-btclass.service \
  integrations/raspberry-pi/bluetooth-mic/systemd/convbased-bt-recover.service \
  integrations/raspberry-pi/bluetooth-mic/systemd/convbased-scoroute@.service
```

Capture sanitized runtime evidence from:

```bash
systemctl --user is-active convbased-app convbased-link
wpctl status
pw-link -l
hciconfig -a
```

Redact keys, TURN credentials, addresses, call participants, and recorded speech.

## Not yet verified

- USB Bluetooth adapter selection and unplug/replug recovery;
- injected Bluetooth hardware errors and recovery cooldown;
- a continuous 30-minute call soak test;
- USB-microphone removal and reinsertion during a session;
- phones and headsets outside the reference matrix;
- wideband HFP codecs; the maintained compatibility path uses CVSD.

To close a boundary, record hardware, versions, commands, sanitized evidence, duration,
and result.
