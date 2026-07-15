// Install the browser globals the Convbased SDK reaches for, backed by
// @roamhq/wrtc, so the SDK runs unmodified under headless Node. Import this
// module *before* importing @convbased/sdk — the SDK reads `RTCPeerConnection`,
// `MediaStream`, etc. off the global scope at call time, so they just need to
// exist by the time `connect()` runs.
import wrtc from "@roamhq/wrtc";

const {
	RTCPeerConnection,
	RTCSessionDescription,
	RTCIceCandidate,
	MediaStream,
	MediaStreamTrack,
} = wrtc;

// wrtc supplies the PeerConnection + media primitives. We never call
// getUserMedia (we hand the SDK a ready-made MediaStream), so `navigator`
// stays deliberately unstubbed — if something ever reaches for it, we want a
// loud error rather than a silent fake.
for (const [name, value] of Object.entries({
	RTCPeerConnection,
	RTCSessionDescription,
	RTCIceCandidate,
	MediaStream,
	MediaStreamTrack,
})) {
	if (typeof globalThis[name] === "undefined") globalThis[name] = value;
}

// wrtc does NOT provide WebSocket, and the SDK's signaling layer uses the
// global `WebSocket`. Node 22+ ships one; on older Node we fall back to `ws`.
if (typeof globalThis.WebSocket === "undefined") {
	const { WebSocket } = await import("ws");
	globalThis.WebSocket = WebSocket;
}

// `fetch` (used to fetch TURN credentials) is a global since Node 18, so no
// polyfill is needed there.

// Re-export the nonstandard PCM bridge so the ALSA layer can grab it from one
// place.
export const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;
