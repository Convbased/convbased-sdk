#!/usr/bin/env python3
# convbased-link: keep the persistent null sink "convbased_out" wired into the
# transient Bluetooth HFP uplink node, so audio written to convbased_out is sent to
# the phone as its call / VoIP microphone -- and ONLY that audio.
#
# Why this is needed -- the non-obvious part of the whole approach:
# When a call is active, PipeWire exposes the HFP SCO endpoints as TRANSIENT *Stream*
# nodes, not as stable device sinks/sources:
#   bluez_input.<MAC>.N   media.class = Stream/Output/Audio  role=Communication  (phone -> Pi, downlink)
#   bluez_output.<MAC>.N  media.class = Stream/Input/Audio   role=Communication  (Pi -> phone mic, UPLINK)
# They appear only during a call and are recreated (the node id changes) mid-call.
# `pw-play --target <that node>` is therefore unreliable: when the node is recreated
# the stream loses its target and PipeWire falls back to the default sink, which
# leaks the audio out the Pi's local speaker instead of sending it to the phone.
#
# So we keep one stable null sink (convbased_out) that the app always writes to, and
# (re)link its monitor to whatever bluez_output.<MAC>.N currently exists, twice a
# second. Two non-obvious details, both learned the hard way on a Pi 4 + OPPO:
#
#  1. The HFP uplink is MONO -- its input port is `input_MONO`, not input_FL/input_FR.
#     The old FL/FR linking silently failed, so the converted audio never reached the
#     phone. We discover the real input port name instead of assuming FL/FR.
#
#  2. WirePlumber's default policy auto-links the *raw* default source (the USB mic)
#     straight into the uplink. If we don't remove that, the far end hears the
#     untransformed voice mixed with (or instead of) the converted one. So every tick
#     we also DISCONNECT any feeder of the uplink that isn't our convbased_out sink.
#
# (Separately, the Pi's BCM4345C0 needs a vendor HCI command to route SCO over HCI or
#  the host transmits 0 uplink packets -- see convbased-btclass.service. Without that,
#  no amount of correct linking makes the phone hear anything.)
#
# Optional: set CONVBASED_TEST_TONE=/path/to/tone.wav to also loop a test tone into
# the sink -- handy for bring-up before the real converted audio is wired in.
import os
import re
import subprocess
import time

os.environ.setdefault('XDG_RUNTIME_DIR', '/run/user/%d' % os.getuid())
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:path=%s/bus' % os.environ['XDG_RUNTIME_DIR'])

SINK = os.environ.get('CONVBASED_SINK', 'convbased_out')
TONE = os.environ.get('CONVBASED_TEST_TONE')  # optional wav to loop for testing
UPLINK_RE = re.compile(r'bluez_output\.[0-9A-Fa-f_]+\.\d+')


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout


def uplink_input_ports():
    """Current HFP uplink input ports, e.g. ['bluez_output.<MAC>.1:input_MONO']."""
    ports = []
    for line in sh('pw-link', '-i').splitlines():
        p = line.strip()
        if UPLINK_RE.match(p) and ':input' in p:
            ports.append(p)
    return ports


def sink_monitor_ports():
    """Current monitor outputs for the stable Convbased sink."""
    prefix = SINK + ':monitor_'
    return [line.strip() for line in sh('pw-link', '-o').splitlines()
            if line.strip().startswith(prefix)]


def sources_for_input(input_port, monitors):
    """Map mono/stereo sink monitors to the actual HFP input channel."""
    channel = input_port.rsplit(':input_', 1)[-1]
    exact = [port for port in monitors if port.endswith(':monitor_' + channel)]
    if exact:
        return exact
    mono = [port for port in monitors if port.endswith(':monitor_MONO')]
    if mono:
        return mono
    # A legacy stereo convbased_out feeding a mono HFP port must include both channels.
    return monitors if channel == 'MONO' else monitors[:1]


def feeders():
    """Map every input port -> list of output ports currently feeding it (from `pw-link -l`)."""
    feeds = {}
    cur = None
    for line in sh('pw-link', '-l').splitlines():
        if not line.strip():
            continue
        if not line[0].isspace():
            cur = line.strip()
        else:
            s = line.strip()
            if s.startswith('|<-') and cur:
                feeds.setdefault(cur, []).append(s[3:].strip())
    return feeds


tone = None
prev = None
print('[convbased-link] started; sink=%s tone=%s' % (SINK, TONE or '(none)'), flush=True)
while True:
    if TONE and (tone is None or tone.poll() is not None):
        tone = subprocess.Popen(['pw-play', '--target', SINK, TONE],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ports = uplink_input_ports()
    monitors = sink_monitor_ports()
    feeds = feeders()
    cur = []
    for ip in ports:
        sources = sources_for_input(ip, monitors)
        # 1) make sure every required converted channel is linked in.
        for src in sources:
            subprocess.run(['pw-link', src, ip], capture_output=True, text=True)
        # 2) kick out anything else feeding the uplink (e.g. the raw mic auto-linked by WirePlumber)
        for other in feeds.get(ip, []):
            if not other.startswith(SINK + ':'):
                subprocess.run(['pw-link', '-d', other, ip], capture_output=True, text=True)
        cur.append(ip)
    cur = tuple(sorted(cur))
    if cur != prev:
        print(time.strftime('%H:%M:%S'), 'uplink ->', cur or '(no active call)', flush=True)
        prev = cur
    time.sleep(0.5)
