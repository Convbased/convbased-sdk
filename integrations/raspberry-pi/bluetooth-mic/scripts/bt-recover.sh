#!/usr/bin/env bash
# Recover a failed adapter, with a persistent cooldown to stop reset storms.
set -uo pipefail

COOLDOWN="${CONVBASED_BT_RECOVERY_COOLDOWN_SEC:-60}"
if ! [[ "$COOLDOWN" =~ ^[0-9]+$ ]]; then
  echo "invalid CONVBASED_BT_RECOVERY_COOLDOWN_SEC=$COOLDOWN" >&2
  exit 1
fi

find_bcm_serdev() {
  local adapter="$1"
  local path driver
  path="$(readlink -f "/sys/class/bluetooth/$adapter/device" 2>/dev/null || true)"
  while [ -n "$path" ] && [ "$path" != "/" ]; do
    if [ -L "$path/driver" ]; then
      driver="$(basename "$(readlink -f "$path/driver")")"
      if [ "$driver" = "hci_uart_bcm" ]; then
        basename "$path"
        return 0
      fi
    fi
    path="${path%/*}"
    [ -n "$path" ] || path="/"
  done
  return 1
}

recover() {
  local adapter="$1"
  local now last last_file serdev ready
  last_file="/run/convbased-bt-recover-${adapter}.last"
  now="$(date +%s)"
  last="$(cat "$last_file" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if (( now - last < COOLDOWN )); then
    logger -t convbased-bt "$adapter hardware error ignored during ${COOLDOWN}s cooldown"
    return
  fi
  printf '%s\n' "$now" > "$last_file"

  serdev="$(find_bcm_serdev "$adapter" || true)"
  logger -t convbased-bt "$adapter hardware error detected; recovering"
  systemctl stop bluetooth 2>/dev/null || true
  if [ -n "$serdev" ]; then
    if ! printf '%s\n' "$serdev" > /sys/bus/serial/drivers/hci_uart_bcm/unbind 2>/dev/null; then
      logger -t convbased-bt "$adapter failed to unbind $serdev"
    fi
    sleep 2
    if ! printf '%s\n' "$serdev" > /sys/bus/serial/drivers/hci_uart_bcm/bind 2>/dev/null; then
      logger -t convbased-bt "$adapter failed to bind $serdev"
    fi
    sleep 4
  fi
  systemctl start bluetooth 2>/dev/null || true
  sleep 2
  ready=false
  if CONVBASED_HCI="$adapter" /usr/local/bin/convbased-bt-init.sh "$adapter"; then
    ready=true
  elif /usr/local/bin/convbased-bt-init.sh; then
    ready=true
  fi
  if $ready; then
    logger -t convbased-bt "$adapter recovery finished"
  else
    logger -t convbased-bt "$adapter recovery failed; adapter is not ready"
  fi
}

while IFS= read -r line; do
  if [[ "$line" =~ (hci[0-9]+):\ hardware\ error ]]; then
    adapter="${BASH_REMATCH[1]}"
    if [ -n "${CONVBASED_HCI:-}" ] && [ "$adapter" != "$CONVBASED_HCI" ]; then
      continue
    fi
    if [ -z "${CONVBASED_HCI:-}" ] && [ -r /run/convbased-bt-selected ] \
       && [ "$adapter" != "$(cat /run/convbased-bt-selected)" ]; then
      continue
    fi
    recover "$adapter"
  fi
done < <(journalctl -kf -n0 --no-pager)
