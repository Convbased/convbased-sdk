#!/usr/bin/env bash
# Turn a fresh Raspberry Pi 4 into a Bluetooth headset whose microphone is the
# Convbased real-time voice-conversion output.
#
# One command on a new Pi (Raspberry Pi OS / Debian 13 trixie, PipeWire + WirePlumber
# + BlueZ -- the default), after cloning this repo to ~/convbased-sdk:
#
#   cd ~/convbased-sdk/integrations/raspberry-pi/bluetooth-mic && ./setup.sh
#
# Idempotent: safe to re-run. Installs system deps (incl. Node 20), the audio/BT stack,
# all systemd units, and the Node app deps; then you fill the API key and start the app.
# Uses sudo for the system-level bits (you'll be prompted). See README.md for the why.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../bluetooth-mic
APPDIR="$(cd "$HERE/.." && pwd)"                          # .../integrations/raspberry-pi
REPO="$(cd "$APPDIR/../.." && pwd)"                       # monorepo root (npm workspaces)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

echo "==> System dependencies (sudo)"
sudo apt-get update -qq
# pipewire/wireplumber/bluez ship by default on RPi OS desktop; ensure the rest.
sudo apt-get install -y --no-install-recommends \
  alsa-utils rfkill python3-dbus python3-gi bluez pipewire wireplumber pipewire-pulse

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource.sh
  sudo -E bash /tmp/nodesource.sh
  sudo apt-get install -y nodejs
fi
NODE="$(command -v node)"
echo "    node $($NODE --version) at $NODE"

echo "==> Enable linger (so the user PipeWire/agent/app services run headless)"
sudo loginctl enable-linger "$USER"

echo "==> Helper scripts -> ~/convbased-bt, tone -> /tmp/tone.wav"
mkdir -p ~/convbased-bt
cp "$HERE"/scripts/*.py ~/convbased-bt/
chmod +x ~/convbased-bt/*.py
python3 ~/convbased-bt/make-tone.py /tmp/tone.wav || true

echo "==> BT readiness + recovery helpers -> /usr/local/bin (sudo)"
sudo install -m 0755 "$HERE"/scripts/bt-init.sh /usr/local/bin/convbased-bt-init.sh
sudo install -m 0755 "$HERE"/scripts/bt-recover.sh /usr/local/bin/convbased-bt-recover.sh

echo "==> Bluetooth policy -> /etc/default/convbased-bt (sudo)"
if [ ! -e /etc/default/convbased-bt ]; then
  sudo install -m 0644 "$HERE"/config/convbased-bt.default /etc/default/convbased-bt
fi

echo "==> WirePlumber config (present as a headset, HFP HF, CVSD)"
mkdir -p ~/.config/wireplumber/wireplumber.conf.d
cp "$HERE"/config/wireplumber-51-convbased-bluez.conf \
   ~/.config/wireplumber/wireplumber.conf.d/51-convbased-bluez.conf

echo "==> PipeWire config (persistent convbased_out null sink)"
mkdir -p ~/.config/pipewire/pipewire.conf.d
cp "$HERE"/config/pipewire-51-convbased-out.conf \
   ~/.config/pipewire/pipewire.conf.d/51-convbased-out.conf

echo "==> modprobe disable_esco (optional / documented; sudo)"
sudo cp "$HERE"/config/modprobe-convbased-bt.conf /etc/modprobe.d/convbased-bt.conf

echo "==> systemd --user units (agent, link, app)"
mkdir -p ~/.config/systemd/user
cp "$HERE"/systemd/convbased-btagent.service ~/.config/systemd/user/
cp "$HERE"/systemd/convbased-link.service    ~/.config/systemd/user/
# Point the app unit at THIS checkout and the detected node.
sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$APPDIR|" \
    -e "s|^ExecStart=.*|ExecStart=$NODE index.mjs|" \
    "$HERE"/systemd/convbased-app.service > ~/.config/systemd/user/convbased-app.service
systemctl --user daemon-reload

echo "==> systemd system units + udev (sudo): device class / SCO routing / recovery"
sudo cp "$HERE"/systemd/convbased-btclass.service    /etc/systemd/system/
sudo cp "$HERE"/systemd/convbased-scoroute@.service  /etc/systemd/system/
sudo cp "$HERE"/systemd/convbased-bt-recover.service /etc/systemd/system/
sudo cp "$HERE"/udev/99-convbased-sco.rules          /etc/udev/rules.d/
sudo systemctl disable --now convbased-scoroute.service >/dev/null 2>&1 || true
sudo rm -f /etc/systemd/system/convbased-scoroute.service
sudo systemctl daemon-reload
sudo udevadm control --reload-rules

echo "==> Workspace deps + build the SDK (npm workspaces at $REPO)"
# The app imports @convbased/sdk as a workspace dependency, so install the whole
# workspace (links @convbased/sdk + installs @roamhq/wrtc) and build the SDK's dist.
( cd "$REPO" && npm install --no-audit --no-fund && npm run build --workspace @convbased/sdk )

echo "==> App env -> ~/convbased-bt/convbased-app.env (fill API_KEY / MODEL_ID)"
if [ ! -f ~/convbased-bt/convbased-app.env ]; then
  install -m 600 "$HERE"/convbased-app.env.example ~/convbased-bt/convbased-app.env
fi

echo "==> Restart audio stack"
systemctl --user restart pipewire wireplumber
sleep 2

echo "==> Enable + start agent, linker, recovery, device-class units"
systemctl --user enable convbased-btagent.service convbased-link.service
systemctl --user restart convbased-btagent.service convbased-link.service
sudo systemctl enable convbased-bt-recover.service
sudo systemctl restart convbased-bt-recover.service
sudo systemctl enable convbased-btclass.service

echo "==> Apply runtime now (so you don't have to reboot)"
sudo systemctl restart convbased-btclass.service
[ -w /sys/module/bluetooth/parameters/disable_esco ] && echo 1 | sudo tee /sys/module/bluetooth/parameters/disable_esco >/dev/null || true
# Route the phone's call audio (downlink) to the USB headset by default.
USB_SINK="$(wpctl status 2>/dev/null | grep -iE 'USB.*Analog|USB Composite Device Analog' | grep -oE '[0-9]+' | head -1)"
[ -n "${USB_SINK:-}" ] && wpctl set-default "$USB_SINK" 2>/dev/null || true

echo
echo "== Done =="
echo " 1) Find your USB mic device:  arecord -l   (set MIC_DEVICE in the env if not"
echo "    plughw:CARD=Device,DEV=0)."
echo " 2) Fill credentials:          nano ~/convbased-bt/convbased-app.env"
echo "       API_KEY=...   MODEL_ID=...   (PITCH=12 by default; tune to taste)"
echo " 3) Start the voice changer:   systemctl --user enable --now convbased-app"
echo " 4) Pair your phone -> 'Convbased Mic' (Just Works, no PIN). On Android make sure"
echo "    'Phone calls'/HFP is enabled for it. Make a CELLULAR call and talk."
echo "    Pairing closes after 5 minutes; restart convbased-btagent to reopen it."
echo "    Adapter policy: sudo nano /etc/default/convbased-bt"
echo
echo " Logs:   journalctl --user -u convbased-app -f"
echo " Tone bring-up test (far end hears 1 kHz on a cellular call):"
echo "   systemctl --user stop convbased-link"
echo "   CONVBASED_TEST_TONE=/tmp/tone.wav python3 ~/convbased-bt/linker.py"
echo "   ...call... then Ctrl-C and: systemctl --user start convbased-link"
