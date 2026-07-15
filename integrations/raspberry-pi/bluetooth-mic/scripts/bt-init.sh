#!/usr/bin/env bash
# Select and ready one Bluetooth adapter with bounded retries.
set -euo pipefail

log() {
  echo "[convbased-bt-init] $*"
}

retry() {
  local attempts="$1"
  local delay="$2"
  shift 2
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    [ "$attempt" -lt "$attempts" ] && sleep "$delay"
  done
  return 1
}

is_brcm_uart_adapter() {
  local adapter="$1"
  local device_path modalias
  device_path="$(readlink -f "/sys/class/bluetooth/$adapter/device" 2>/dev/null || true)"
  [[ "$device_path" == *serial* || "$device_path" == *uart* ]] || return 1

  # Raspberry Pi's Broadcom-derived controllers can report their manufacturer
  # as Cypress. The device-tree modalias remains the stable hardware identity.
  modalias="$(cat "/sys/class/bluetooth/$adapter/device/modalias" 2>/dev/null || true)"
  if [[ "${modalias,,}" == *brcm,* ]]; then
    return 0
  fi
  hciconfig -a "$adapter" 2>/dev/null | grep -qiE 'Manufacturer: (Broadcom|Cypress)'
}

auto_adapter() {
  local powered
  powered="$(hciconfig 2>/dev/null | awk '
    /^hci[0-9]+:/ { adapter=$1; sub(/:$/, "", adapter) }
    /UP RUNNING/ && adapter != "" { print adapter; exit }
  ')"
  if [ -n "$powered" ]; then
    printf '%s\n' "$powered"
    return 0
  fi

  local path
  for path in /sys/class/bluetooth/hci*; do
    [ -e "$path" ] || continue
    basename "$path"
    return 0
  done
  return 1
}

configured="${CONVBASED_HCI:-}"
requested="${1:-}"
for candidate in "$configured" "$requested"; do
  if [ -n "$candidate" ] && ! [[ "$candidate" =~ ^hci[0-9]+$ ]]; then
    log "invalid adapter name: $candidate"
    exit 1
  fi
done
if [ -n "$requested" ] && [ -n "$configured" ] && [ "$requested" != "$configured" ]; then
  log "ignoring $requested; CONVBASED_HCI selects $configured"
  exit 0
fi
if [ -n "$requested" ] && [ -z "$configured" ]; then
  selected="$(auto_adapter || true)"
  if [ -n "$selected" ] && [ "$requested" != "$selected" ]; then
    log "ignoring $requested; automatic selection is $selected"
    exit 0
  fi
fi

adapter="${configured:-$requested}"
for ((attempt = 1; attempt <= 30; attempt++)); do
  if [ -z "$adapter" ]; then
    adapter="$(auto_adapter || true)"
  fi
  if [[ "$adapter" =~ ^hci[0-9]+$ ]] && [ -e "/sys/class/bluetooth/$adapter" ]; then
    break
  fi
  if [ -n "$configured" ] || [ -n "$requested" ]; then
    adapter="${configured:-$requested}"
  else
    adapter=""
  fi
  sleep 1
done

if ! [[ "$adapter" =~ ^hci[0-9]+$ ]] || [ ! -e "/sys/class/bluetooth/$adapter" ]; then
  log "no usable Bluetooth adapter after 30s"
  exit 1
fi

rfkill unblock bluetooth >/dev/null 2>&1 || true
if ! retry 10 1 hciconfig "$adapter" up; then
  log "$adapter did not become ready"
  exit 1
fi

route_mode="${CONVBASED_SCO_ROUTE:-auto}"
route_sco=false
case "$route_mode" in
  always) route_sco=true ;;
  never) ;;
  auto)
    if is_brcm_uart_adapter "$adapter"; then
      route_sco=true
    fi
    ;;
  *)
    log "invalid CONVBASED_SCO_ROUTE=$route_mode"
    exit 1
    ;;
esac

if $route_sco; then
  if ! retry 5 1 hcitool -i "$adapter" cmd 0x3f 0x1c 0x01 0x02 0x00 0x01 0x01; then
    log "SCO-over-HCI command failed on $adapter"
    exit 1
  fi
  log "SCO routed over HCI on $adapter"
else
  log "SCO vendor routing not needed on $adapter"
fi

if ! retry 5 1 hciconfig "$adapter" class 0x240404; then
  log "failed to set headset class on $adapter"
  exit 1
fi
printf '%s\n' "$adapter" > /run/convbased-bt-selected
log "$adapter ready"
