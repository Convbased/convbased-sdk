#!/usr/bin/env python3
# Generate a 1 kHz mono test tone (s16, 48 kHz, 20 s) for HFP uplink bring-up tests.
#   python3 make-tone.py [/tmp/tone.wav]
import math
import struct
import sys
import wave

path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/tone.wav'
fr, dur, freq, amp = 48000, 20, 1000.0, 12000
w = wave.open(path, 'wb')
w.setnchannels(1)
w.setsampwidth(2)
w.setframerate(fr)
w.writeframes(b''.join(struct.pack('<h', int(amp * math.sin(2 * math.pi * freq * n / fr)))
                       for n in range(fr * dur)))
w.close()
print('wrote', path, dur, 's', freq, 'Hz')
