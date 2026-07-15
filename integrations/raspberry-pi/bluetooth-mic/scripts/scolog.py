#!/usr/bin/env python3
# Diagnostic: log the bluez nodes / links that PipeWire creates during a call, and
# (optionally) inject a tone into the HFP uplink. This is the tool that revealed how
# the HFP audio is exposed (transient Stream nodes) -- keep it for next time.
#
# Run it, then make a CELLULAR call (cellular calls reliably use HFP; many VoIP apps
# do not route their mic to the Bluetooth headset). Watch /tmp/scolog.log.
#
#   python3 scolog.py
#
# On first detection of an uplink node it writes a full snapshot (pw-dump fields +
# pw-link -l + wpctl status) to /tmp/snap.txt.
import json
import os
import subprocess
import time

os.environ.setdefault('XDG_RUNTIME_DIR', '/run/user/%d' % os.getuid())
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:path=%s/bus' % os.environ['XDG_RUNTIME_DIR'])
SNAP = '/tmp/snap.txt'


def run(*a):
    try:
        return subprocess.check_output(a, stderr=subprocess.STDOUT, text=True)
    except Exception as e:
        return 'ERR %s' % e


def dump():
    try:
        return json.loads(run('pw-dump'))
    except Exception:
        return []


snapped = False
print('[scolog] make a CELLULAR call now (~30s)', flush=True)
while True:
    d = dump()
    uplink = None
    blnodes = []
    for o in d:
        if o.get('type', '') != 'PipeWire:Interface:Node':
            continue
        p = (o.get('info', {}) or {}).get('props', {}) or {}
        nm = p.get('node.name') or ''
        if nm.startswith('bluez') or 'api.bluez.transport' in p:
            blnodes.append(o)
            if nm.startswith('bluez_output'):
                uplink = (o['id'], nm)
    if uplink and not snapped:
        snapped = True
        with open(SNAP, 'w') as f:
            f.write('=== TIME %s ===\n' % time.strftime('%H:%M:%S'))
            for o in blnodes:
                p = (o.get('info', {}) or {}).get('props', {}) or {}
                f.write('\nNODE id=%s\n' % o['id'])
                for k in ('node.name', 'media.class', 'audio.channels', 'audio.rate',
                          'api.bluez.codec', 'api.bluez.profile', 'media.role', 'node.description'):
                    if k in p:
                        f.write('  %s = %s\n' % (k, p[k]))
            f.write('\n=== pw-link -l ===\n')
            f.write(run('pw-link', '-l'))
            f.write('\n=== wpctl status ===\n')
            f.write(run('wpctl', 'status'))
        print(time.strftime('%H:%M:%S'), 'SNAPSHOT ->', SNAP, flush=True)
    time.sleep(1)
