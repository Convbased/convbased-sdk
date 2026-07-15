// wrtc + ALSA smoke test — no Convbased account needed.
//
// Builds two local RTCPeerConnections (sender + receiver), routes the mic
// through a real WebRTC audio path (Opus encode -> DTLS/SRTP -> decode) and
// plays the far end back out the speaker. If you hear your mic echoed, the
// whole native stack works on this box: wrtc loaded, PeerConnection negotiates,
// audio codec runs, and the ALSA bridge (arecord/aplay) is wired correctly.
//
//   MIC_DEVICE=plughw:3,0 SPK_DEVICE=plughw:3,0 node loopback.mjs
//
// Ctrl-C to stop.
import "./polyfill.mjs";
import { createMicStream, playTrack } from "./alsa.mjs";

const RATE = Number(process.env.RATE ?? 48000);

const mic = createMicStream({
	rate: RATE,
	channels: 1,
	device: process.env.MIC_DEVICE,
});

const sender = new RTCPeerConnection();
const receiver = new RTCPeerConnection();

// Trickle ICE between the two local peers.
sender.onicecandidate = (e) => e.candidate && receiver.addIceCandidate(e.candidate);
receiver.onicecandidate = (e) => e.candidate && sender.addIceCandidate(e.candidate);

let player = null;
receiver.ontrack = (e) => {
	console.log("[loopback] receiver got track — playing via aplay");
	player = playTrack(e.track, { device: process.env.SPK_DEVICE });
};

sender.onconnectionstatechange = () =>
	console.log(`[loopback] sender pc: ${sender.connectionState}`);

for (const track of mic.stream.getAudioTracks()) {
	sender.addTrack(track, mic.stream);
}

const offer = await sender.createOffer();
await sender.setLocalDescription(offer);
await receiver.setRemoteDescription(offer);
const answer = await receiver.createAnswer();
await receiver.setLocalDescription(answer);
await sender.setRemoteDescription(answer);

console.log(`[loopback] negotiating (rate=${RATE})... speak into the mic; you should hear yourself.`);

function shutdown() {
	console.log("\n[loopback] stopping...");
	mic.stop();
	if (player) player.stop();
	try { sender.close(); } catch {}
	try { receiver.close(); } catch {}
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
