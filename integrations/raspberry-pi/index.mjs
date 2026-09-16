// Headless real-time voice conversion on a Raspberry Pi.
//
//   mic --arecord--> RTCAudioSource --> [Convbased SDK / WebRTC] --> Convbased node
//                                                                        |
//                                                           converted audio track
//                                                                        |
//   OUTPUT=alsa     (default): RTCAudioSink --> aplay  --> local speaker
//   OUTPUT=pipewire          : RTCAudioSink --> pw-cat --> "convbased_out" sink, which
//                              bluetooth-mic/ carries into a phone's HFP mic uplink.
//
// The SDK is untouched: polyfill.mjs supplies the WebRTC globals and we hand it a
// MediaStream sourced from ALSA, so getUserMedia is never reached. webui.mjs serves a
// small status panel with device-local mute and sidetone controls. All config is via env;
// only API_KEY and a model from MODEL_ID or the server profile are required.
//
//   API_KEY=... MODEL_ID=... [OUTPUT=pipewire] node index.mjs
import "./polyfill.mjs";
// The SDK is a workspace dependency (packages/sdk-js, npm name @convbased/sdk). Its
// published ESM is Node-loadable, so we import it directly, no vendored bundle. The
// polyfill above installs the WebRTC globals it reaches for before connect() runs.
import { ConvbasedClient, fetchRTCServers, DEFAULT_GRAPHQL_URL } from "@convbased/sdk";
import { createMicStream, playTrack } from "./alsa.mjs";
import { playTrackToPipewire } from "./pipewire.mjs";
import { startWebUI, loadPrefs, savePrefs, loadModelId, clearModelOverride } from "./webui.mjs";
import { fetchDeviceProfile } from "./device-profile.mjs";
import { createSdkAuth } from "./sdk-auth.mjs";
import {
	isRealtimeEnabled,
	waitForRealtimeEnabled,
} from "./device-runtime.mjs";
import { isCredentialFailure } from "./failure-policy.mjs";
import { createRedactingLogger } from "./redacting-logger.mjs";

// Configuration from the environment (API_KEY is required; MODEL_ID may also come from the profile).
const API_KEY = process.env.API_KEY;
const RATE = Number(process.env.RATE ?? 48000);              // capture rate advertised to the node
const PITCH = Number(process.env.PITCH ?? 12);               // starting pitch (semitones); profile/cache override
const OUTPUT = (process.env.OUTPUT ?? "alsa").toLowerCase(); // "alsa" -> aplay; "pipewire" -> pw-cat
const MIC_DEVICE = process.env.MIC_DEVICE;                   // ALSA capture device, e.g. plughw:CARD=Device,DEV=0
const SPK_DEVICE = process.env.SPK_DEVICE;                   // ALSA playback device (OUTPUT=alsa only)
const PW_TARGET = process.env.PW_TARGET ?? "convbased_out";  // PipeWire sink name (OUTPUT=pipewire)
const SIGNALING_URL = process.env.SIGNALING_URL;             // override for self-hosted signaling
const WEBUI_PORT = Number(process.env.WEBUI_PORT ?? 8080);   // status panel port; 0 disables it
const WEBUI_HOST = process.env.WEBUI_HOST ?? "0.0.0.0";      // bind address; use 127.0.0.1 for local-only
const WEBUI_TOKEN = process.env.WEBUI_TOKEN ?? "";           // optional token for mute/sidetone mutations
const PROFILE_POLL_MS = Number(process.env.PROFILE_POLL_MS ?? 20000); // follow web-console profile; 0 disables
const EX_CONFIG = 78;

if (!API_KEY) {
	console.error("Set the API_KEY environment variable.");
	process.exit(EX_CONFIG);
}

let lastProfileError = null;
async function readDeviceProfile() {
	try {
		const profile = await fetchDeviceProfile({
			graphqlUrl: DEFAULT_GRAPHQL_URL,
			apiKey: API_KEY,
		});
		if (lastProfileError) console.log("[profile] query recovered");
		lastProfileError = null;
		return { ok: true, profile };
	} catch (error) {
		const message = error instanceof Error
			? error.message
			: "device profile query failed";
		if (message !== lastProfileError) {
			console.error(`[profile] ${message}; keeping current runtime state`);
			lastProfileError = message;
		}
		return { ok: false, profile: null };
	}
}

// Resolve which model + params to use, in priority order:
//   server profile (bound to this API key in the web console) > legacy local override >
//   env (the deploy-time baseline). A missing or unreachable profile falls through.
const overrideModelId = loadModelId(null);
const initialProfileResult = await readDeviceProfile();
let serverProfile = initialProfileResult.profile;
if (initialProfileResult.ok && !isRealtimeEnabled(serverProfile)) {
	if (PROFILE_POLL_MS <= 0) {
		console.error(
			"Realtime is disabled. Set PROFILE_POLL_MS above zero to receive an enable change.",
		);
		process.exit(EX_CONFIG);
	}
	serverProfile = await waitForRealtimeEnabled({
		initialProfile: serverProfile,
		readProfile: readDeviceProfile,
		pollMs: PROFILE_POLL_MS,
		onWaiting: () =>
			console.log(
				"[profile] realtime disabled; waiting without capture, TURN, or signaling.",
			),
		onEnabled: () => console.log("[profile] realtime enabled; connecting."),
	});
}
const MODEL_ID = serverProfile?.model_id || overrideModelId || process.env.MODEL_ID;
if (serverProfile?.model_id) {
	console.log(`[profile] model bound to this key in the web console: ${serverProfile.model_id}`);
}

if (!MODEL_ID) {
	console.error("No model configured. Set MODEL_ID or bind one in the web console.");
	process.exit(EX_CONFIG);
}

const sdkAuth = createSdkAuth({
	apiKey: API_KEY,
	clientId: process.env.CLIENT_ID ?? "convbased-raspberry-pi",
});
const realtimeTokenRequest = sdkAuth.request(
	["realtime"],
	{ type: "vc_model", id: MODEL_ID },
);

const mic = createMicStream({
	rate: RATE,
	channels: 1,
	device: MIC_DEVICE,
	onFatal(error) {
		console.error(`[alsa] fatal capture error: ${error.message}`);
		process.exit(EX_CONFIG);
	},
});

// The Convbased GraphQL service hands out `turns:...:5349?transport=tcp` ICE
// servers, but libwebrtc (via @roamhq/wrtc) can't complete the TLS-TURN
// allocation on a headless Pi, it gathers only host candidates and media
// fails. The same servers work fine as plain `turn:...:3478` over UDP/TCP, so
// we fetch the credentials and rewrite the URLs, then hand the result to the
// SDK (passing `iceServers` makes it skip its own GraphQL fetch).
async function resolveWorkingIceServers() {
	const cfg = await fetchRTCServers({
		graphqlUrl: DEFAULT_GRAPHQL_URL,
		auth: sdkAuth,
		tokenRequest: realtimeTokenRequest,
	});
	const hosts = cfg.urls.map((u) => u.replace(/^turns?:/, "").replace(/:\d+.*$/, ""));
	const urls = hosts.flatMap((h) => [
		`turn:${h}:3478?transport=udp`,
		`turn:${h}:3478?transport=tcp`,
	]);
	return [{ urls, username: cfg.username, credential: cfg.credential }];
}

let iceServers;
try {
	iceServers = await resolveWorkingIceServers();
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[ice] failed to fetch relay credentials: ${message}`);
	if (isCredentialFailure(err)) {
		console.error("API credentials were rejected. Update API_KEY before restarting the service.");
		process.exit(EX_CONFIG);
	}
	process.exit(1);
}
console.log(`[ice] using ${iceServers[0].urls.length} rewritten turn: URLs (udp/tcp 3478)`);

const client = new ConvbasedClient({
	auth: sdkAuth,
	iceServers,
	...(SIGNALING_URL ? { signalingUrl: SIGNALING_URL } : {}),
	// Surface the SDK's internal logging in the console.
	logger: createRedactingLogger(console),
});

const players = [];
let shuttingDown = false;
let connected = false;
let profilePoll = null;

// Preferences sent at connect and updated by the server profile. Precedence: server profile
// over the local cache (~/convbased-bt/convbased-prefs.json) over the env pitch default.
const prefs = { ...loadPrefs({ pitch: PITCH }), ...(serverProfile?.preferences || {}) };

// One session per process: once connected, any disconnect/error exits non-zero so
// systemd restarts us and reconnects (the SDK client is single-use; prefs persist to
// disk, so the fresh session comes up with the same tuning).
const fatal = (why) => {
	if (shuttingDown) return;
	console.error(`Session ended (${why}), exiting so systemd reconnects.`);
	process.exit(1);
};

client.on("state", ({ state, previous }) => {
	console.log(`[state] ${previous} -> ${state}`);
});
client.on("message", ({ code, message }) => {
	console.log(`[server] code=${code ?? "?"} ${message ?? ""}`);
});
client.on("error", (err) => {
	console.error("[error]", err.message);
	if (connected) fatal(`error: ${err.message}`);
});
client.on("closed", ({ code, reason } = {}) => {
	console.log(`[closed] code=${code ?? "?"} ${reason ?? ""}`);
	if (connected) fatal(`closed code=${code ?? "?"}`);
});

// Switching the active voice means a new session, so bounce the process. systemd brings it
// back and resolves the server profile again.
function requestRestart(message) {
	if (shuttingDown) return;
	console.log(message);
	shuttingDown = true; // suppress the fatal() reconnect path during our teardown
	if (profilePoll) clearInterval(profilePoll);
	try { mic.stop(); } catch {}
	for (const p of players) { try { p.stop(); } catch {} }
	client.disconnect().catch(() => {});
	setTimeout(() => process.exit(1), 300);
}

function requestModelSwitch(id, why = "web console") {
	requestRestart(`[model] switching to ${id} (${why}), restarting to reconnect.`);
}

function requestRealtimePause() {
	requestRestart("[profile] realtime disabled; disconnecting billable session.");
}

if (WEBUI_PORT) {
	startWebUI({
		port: WEBUI_PORT,
		host: WEBUI_HOST,
		token: WEBUI_TOKEN,
		client,
		prefs,
		// Read-only status panel; model + params are chosen in the web console and pulled
		// via the server profile, so the panel needs no api key / switch hooks.
		getInfo: () => ({ state: client.getState(), modelId: MODEL_ID, rate: RATE }),
	});
}

// The converted audio arrives here; route it to the chosen output.
client.on("track", ({ track }) => {
	if (OUTPUT === "pipewire") {
		console.log(`[track] converted audio received, playing to PipeWire sink "${PW_TARGET}"`);
		players.push(playTrackToPipewire(track, { target: PW_TARGET }));
	} else {
		console.log("[track] converted audio received, playing via aplay");
		players.push(playTrack(track, { device: SPK_DEVICE }));
	}
});

async function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`\nShutting down (${reason})...`);
	if (profilePoll) clearInterval(profilePoll);
	mic.stop();
	for (const p of players) p.stop();
	await client.disconnect().catch(() => {});
	process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
	console.log(`Connecting (model=${MODEL_ID}, rate=${RATE}, prefs=${JSON.stringify(prefs)}, output=${OUTPUT})...`);
	await client.connect({
		modelId: MODEL_ID,
		audio: mic.stream,   // <-- bypasses getUserMedia
		sampleRate: RATE,    // <-- advertise the rate we actually feed
		preferences: prefs,
	});
	connected = true;
	console.log(WEBUI_PORT
		? `Connected, audio flowing. Status at http://${WEBUI_HOST}:${WEBUI_PORT}`
		: "Connected, audio flowing. Status panel disabled.");

	// Near-live follow of this key's web-console profile: a changed model triggers a
	// reconnect; changed params hot-apply via updateConfig.
	if (PROFILE_POLL_MS > 0) {
		profilePoll = setInterval(async () => {
			if (shuttingDown) return;
			const result = await readDeviceProfile();
			if (!result.ok) return;
			const p = result.profile;
			if (!p) return;
			if (!isRealtimeEnabled(p)) {
				requestRealtimePause();
				return;
			}
			if (p.model_id && p.model_id !== MODEL_ID) {
				requestModelSwitch(p.model_id, "web console");
				return;
			}
			if (p.preferences) {
				const changed = Object.keys(p.preferences).filter((k) => p.preferences[k] !== prefs[k]);
				if (changed.length) {
					Object.assign(prefs, p.preferences);
					savePrefs(prefs);
					try {
						client.updateConfig(p.preferences);
						console.log(`[profile] params updated from web console: ${changed.join(", ")}`);
					} catch {}
				}
			}
		}, PROFILE_POLL_MS);
	}
} catch (err) {
	console.error("Failed to connect:", err.message);
	if (isCredentialFailure(err)) {
		console.error("API credentials were rejected. Update API_KEY before restarting the service.");
		process.exit(EX_CONFIG);
	}
	// If the chosen model is the culprit (not found / unpaid / bad id):
	//  - a local-override model: drop it so the next restart uses the env baseline;
	//  - a server-profile model: the web console owns it (and validated access when set),
	//    so we can't clear it here; log and let systemd retry.
	const modelErr = /model|not\s*found|unpaid|balance|2003|2004/i.test(err.message || "");
	if (modelErr && serverProfile?.model_id === MODEL_ID) {
		console.error(`[profile] web-console model "${MODEL_ID}" failed (${err.message}); fix it in the console.`);
	} else if (modelErr && overrideModelId === MODEL_ID) {
		console.error(`[model] switched model "${MODEL_ID}" failed (${err.message}); reverting to default.`);
		clearModelOverride();
	}
	// Exit non-zero so systemd (Restart=on-failure) retries the whole session.
	process.exit(1);
}
