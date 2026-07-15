// Route the converted (remote) track to a PipeWire sink via `pw-cat`, instead of straight
// to ALSA via `aplay` (see alsa.mjs). Default target is the `convbased_out` null sink
// created by bluetooth-mic/; the `convbased-link` service then carries that audio into the
// Bluetooth HFP uplink, so the phone hears it as its call microphone.
//
//   remote track -> RTCAudioSink -> pw-cat --playback --target <sink>   (see pcm-pipe.mjs)
//
// The RTCAudioSink -> player plumbing (incl. the mid-stream sample-rate restart) lives in
// pcm-pipe.mjs; here we just supply how to spawn `pw-cat`. PipeWire resamples/encodes for
// the downstream SCO link.
import { spawn } from "node:child_process";
import { pipePcmToPlayer } from "./pcm-pipe.mjs";

/**
 * Pipe a remote (converted) MediaStreamTrack to a PipeWire sink via `pw-cat`.
 *
 * @param {MediaStreamTrack} track  the track from the SDK's `track` event
 * @param {object} [opts]
 * @param {string} [opts.target="convbased_out"]  PipeWire target node name (or id)
 * @returns {{ stop: () => void }}
 */
export function playTrackToPipewire(track, { target = "convbased_out" } = {}) {
	return pipePcmToPlayer(track, (rate, channels) => {
		const p = spawn("pw-cat", [
			"--playback",
			"--target", target,
			"--rate", String(rate),
			"--channels", String(channels),
			"--format", "s16",
			"--raw",
			"-",
		], { stdio: ["pipe", "inherit", "inherit"] });
		p.on("error", (e) => {
			console.error("[pw] pw-cat failed to start — is pipewire installed?", e.message);
		});
		// Swallow EPIPE on teardown (a final frame can be in flight as the pipe closes).
		p.stdin.on("error", () => {});
		return p;
	}, "pw");
}
