// The ALSA <-> WebRTC bridge. We avoid native sound-card bindings (which would
// add a second compiled dependency on top of wrtc) and instead shell out to
// `arecord` / `aplay` from alsa-utils, piping raw S16_LE PCM over stdio.
//
//   mic  : arecord stdout (PCM) -> 10ms frames -> RTCAudioSource.onData -> track
//   spkr : remote track -> RTCAudioSink.ondata (10ms frames) -> aplay stdin
//
// WebRTC's audio clock is the sound card itself: arecord emits samples in real
// time, so slicing its stream into 10ms frames and forwarding each as it
// completes paces RTCAudioSource correctly without any manual timer.
import { spawn } from "node:child_process";
import { RTCAudioSource } from "./polyfill.mjs";
import { pipePcmToPlayer } from "./pcm-pipe.mjs";
import { startArecord } from "./arecord-supervisor.mjs";

const BYTES_PER_SAMPLE = 2; // S16_LE
const FRAME_MS = 10; // wrtc requires exactly 10ms per onData call

/**
 * Capture the microphone via `arecord` and expose it as a MediaStream suitable
 * for the SDK's `audio` option.
 *
 * @param {object} [opts]
 * @param {number} [opts.rate=48000]   sample rate fed to WebRTC
 * @param {number} [opts.channels=1]   1 = mono
 * @param {string} [opts.device]       ALSA device, e.g. "plughw:1,0" (omit for default)
 * @param {(error: Error) => void} [opts.onFatal] called for non-retryable spawn errors
 * @returns {{ stream: MediaStream, stop: () => void }}
 */
export function createMicStream({ rate = 48000, channels = 1, device, onFatal } = {}) {
	const source = new RTCAudioSource();
	const track = source.createTrack();
	const stream = new MediaStream([track]);

	const samplesPerFrame = (rate / 1000) * FRAME_MS; // 480 @ 48k
	const frameBytes = samplesPerFrame * channels * BYTES_PER_SAMPLE; // 960 @ 48k mono

	const args = [
		"-q",
		"-t", "raw",
		"-f", "S16_LE",
		"-r", String(rate),
		"-c", String(channels),
		...(device ? ["-D", device] : []),
	];

	let leftover = Buffer.alloc(0);

	const capture = startArecord({
		args,
		...(onFatal ? { onFatal } : {}),
		onStart() {
			leftover = Buffer.alloc(0);
		},
		onData(chunk) {
			let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
			let offset = 0;
			while (buf.length - offset >= frameBytes) {
				// Copy out an aligned slice — chunk boundaries don't respect Int16
				// alignment, so we can't safely view the Buffer in place.
				const frame = buf.subarray(offset, offset + frameBytes);
				const samples = new Int16Array(samplesPerFrame * channels);
				Buffer.from(frame).copy(Buffer.from(samples.buffer));
				source.onData({
					samples,
					sampleRate: rate,
					bitsPerSample: 16,
					channelCount: channels,
					numberOfFrames: samplesPerFrame,
				});
				offset += frameBytes;
			}
			leftover = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
		},
	});

	const stop = () => {
		capture.stop();
		try { track.stop(); } catch {}
	};
	return { stream, stop };
}

/**
 * Pipe a remote (converted) MediaStreamTrack to the speaker via `aplay`. `aplay` is
 * (re)started to match the track's sample rate / channel count, which can change
 * mid-stream — the shared plumbing (incl. that restart) lives in pcm-pipe.mjs.
 *
 * @param {MediaStreamTrack} track  the track from the SDK's `track` event
 * @param {object} [opts]
 * @param {string} [opts.device]    ALSA playback device, e.g. "plughw:0,0"
 * @returns {{ stop: () => void }}
 */
export function playTrack(track, { device } = {}) {
	return pipePcmToPlayer(track, (rate, channels) => {
		const args = [
			"-q",
			"-t", "raw",
			"-f", "S16_LE",
			"-r", String(rate),
			"-c", String(channels),
			...(device ? ["-D", device] : []),
		];
		const p = spawn("aplay", args, { stdio: ["pipe", "inherit", "inherit"] });
		p.on("error", (e) => {
			console.error("[alsa] aplay failed to start — is alsa-utils installed?", e.message);
		});
		// Swallow EPIPE on teardown (a final frame can be in flight as the pipe closes).
		p.stdin.on("error", () => {});
		return p;
	}, "alsa");
}
