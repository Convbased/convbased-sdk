# Operations

## Service lifecycle

```bash
systemctl --user status convbased-app convbased-link convbased-btagent
sudo systemctl status convbased-btclass convbased-bt-recover

systemctl --user restart convbased-app
systemctl --user stop convbased-app
```

`setup.sh` enables user lingering and preserves the credential file. Re-run it after
pulling integration changes.

```bash
cd ~/convbased-sdk
git pull --ff-only
./integrations/raspberry-pi/bluetooth-mic/setup.sh
./integrations/raspberry-pi/bluetooth-mic/check.sh
```

## Health checks

```bash
systemctl --user is-active convbased-app convbased-link
journalctl --user -u convbased-app.service -n 100 --no-pager
wpctl status
pw-link -l | grep -A3 -B1 -E 'bluez_(input|output)|convbased_out'
```

A healthy call has:

- the app reports `connected` and receives a converted track;
- `pw-cat` writes to `convbased_out`;
- the phone downlink feeds USB-headset playback;
- `convbased_out:monitor_MONO` feeds the phone HFP uplink;
- rising SCO RX and TX counters without controller errors;
- a far-end listener hears the converted voice, not the raw microphone.

The far-end check is decisive; links prove routing, not content.

## Pairing and reconnection

Open a new five-minute pairing window:

```bash
systemctl --user restart convbased-btagent.service
```

For a wrong PIN or pairing-key error, forget **Convbased Mic** on the phone and remove
the Pi bond:

```bash
bluetoothctl devices
bluetoothctl remove <PHONE_MAC>
systemctl --user restart convbased-btagent.service
```

## Audio level

Select and unmute the USB sink. Start at `0.80` and adjust cautiously.

```bash
wpctl set-mute @DEFAULT_AUDIO_SINK@ 0
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.80
wpctl get-volume @DEFAULT_AUDIO_SINK@
```

Avoid gain above `1.0` until clipping and hearing safety are checked.

## Troubleshooting

| Symptom | Check | Action |
| --- | --- | --- |
| Wrong PIN or pairing key | Old bonds on the phone or Pi | Forget/remove both bonds, then reopen pairing. |
| Service exits with `78` | Missing config, rejected key, or fatal capture setup | Correct the environment or ALSA device; restart the service. |
| Valid key but session is blocked | Usage state, model access, or unpaid orders | Resolve the account condition, then restart. |
| Connected but no HFP nodes | No active call-type audio session | Start a cellular or supported VoIP call and select **Convbased Mic**. |
| Far end hears silence | Uplink link or SCO routing absent | Inspect `pw-link`, adapter logs, and SCO TX counters. |
| Far end hears the raw voice | Another source feeds the HFP input | Restart `convbased-link`; confirm only `convbased_out` feeds the uplink. |
| Local call audio is quiet | Wrong default sink or low volume | Select the USB sink, unmute it, and raise volume gradually. |
| Bluetooth drops under load | Shared Pi 4 2.4 GHz radio | Use Ethernet or 5 GHz Wi-Fi and retest. |
| Repeated capture exits | USB headset missing or unstable | Check `arecord -l`, cabling, power, and `MIC_DEVICE`. |

## Logs

```bash
journalctl --user -u convbased-app.service -f
journalctl --user -u convbased-link.service -f
journalctl --user -u convbased-btagent.service -f
sudo journalctl -u convbased-btclass.service -u convbased-bt-recover.service -f
```

Logs redact API-key and token query values. Review logs before posting; never attach
the env file or process environment.

## Safe rollback

Stop the integration without removing Bluetooth bonds:

```bash
systemctl --user disable --now convbased-app convbased-link convbased-btagent
sudo systemctl disable --now convbased-btclass convbased-bt-recover
```
