// Pure-software wrtc audio-path check — no mic, no speaker, no account.
// Feeds a synthetic sine wave through RTCAudioSource -> PC1 -> PC2 ->
// RTCAudioSink and counts frames that arrive at the far end. If the receive
// count climbs, WebRTC audio (Opus encode/decode + transport) works on this box.
import wrtc from "@roamhq/wrtc";
const { RTCPeerConnection, nonstandard } = wrtc;
const { RTCAudioSource, RTCAudioSink } = nonstandard;

const RATE = 48000;
const FRAME = RATE / 100; // 10ms = 480 samples

const source = new RTCAudioSource();
const track = source.createTrack();

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);

let received = 0;
b.ontrack = (e) => {
	const sink = new RTCAudioSink(e.track);
	sink.ondata = () => { received++; };
};

a.addTrack(track);
const offer = await a.createOffer();
await a.setLocalDescription(offer);
await b.setRemoteDescription(offer);
const answer = await b.createAnswer();
await b.setLocalDescription(answer);
await a.setRemoteDescription(answer);

// Pump a 440Hz sine, 10ms frames, ~real time.
let phase = 0;
const samples = new Int16Array(FRAME);
const timer = setInterval(() => {
	for (let i = 0; i < FRAME; i++) {
		samples[i] = Math.round(Math.sin(phase) * 8000);
		phase += (2 * Math.PI * 440) / RATE;
	}
	source.onData({ samples, sampleRate: RATE, bitsPerSample: 16, channelCount: 1, numberOfFrames: FRAME });
}, 10);

setTimeout(() => {
	clearInterval(timer);
	console.log(`sent ~200 frames, received ${received} frames at sink`);
	console.log(received > 50 ? "RESULT: PASS — WebRTC audio path works" : "RESULT: FAIL — no audio received");
	// Leave teardown to process exit; wrtc may segfault on exit (known quirk).
	process.exit(received > 50 ? 0 : 1);
}, 2000);
