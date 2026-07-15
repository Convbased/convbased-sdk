// Shared sink-side bridge: pump a converted (remote) MediaStreamTrack's PCM frames into a
// child process's stdin, used by both the ALSA (`aplay`) and PipeWire (`pw-cat`) outputs.
//
//   remote track -> RTCAudioSink (10ms PCM frames) -> spawn(rate, ch).stdin
//
// The one subtlety: wrtc delivers a brief 16 kHz preamble (while the node loads the model /
// sends comfort noise) before the converted audio settles at 48 kHz, i.e. the sample rate
// changes mid-stream. A player whose rate is fixed at spawn time would then play the 48 kHz
// audio ~3x too slow ("stretched"), so we relaunch the player whenever the rate / channel
// count changes.
import { RTCAudioSink } from "./polyfill.mjs";
import { createBoundedPcmWriter } from "./bounded-pcm-writer.mjs";

/**
 * @param {MediaStreamTrack} track  the track from the SDK's `track` event
 * @param {(rate: number, channels: number) => import("node:child_process").ChildProcess} spawnPlayer
 *        spawns the player for a given rate/channels and returns it (with its own
 *        spawn-error / EPIPE handlers attached; stdin must be a pipe).
 * @param {string} tag  log prefix, e.g. "pw" or "alsa".
 * @param {object} [options] test seams for the sink constructor and logger.
 * @param {typeof RTCAudioSink} [options.Sink=RTCAudioSink]
 * @param {(message: string) => void} [options.logger=console.error]
 * @returns {{ stop: () => void }}
 */
export function pipePcmToPlayer(track, spawnPlayer, tag, {
	Sink = RTCAudioSink,
	logger = console.error,
} = {}) {
	const sink = new Sink(track);
	let player = null;
	let writer = null;
	let curRate = 0;
	let curCh = 0;
	let stopped = false;
	const expectedExits = new WeakSet();

	const killPlayer = () => {
		if (!player) return;
		const oldPlayer = player;
		player = null;
		expectedExits.add(oldPlayer);
		writer?.stop();
		writer = null;
		try { oldPlayer.stdin.end(); } catch {}
		try { oldPlayer.kill("SIGTERM"); } catch {}
	};

	sink.ondata = ({ samples, sampleRate, channelCount }) => {
		if (stopped) return;
		if (player && (sampleRate !== curRate || channelCount !== curCh)) {
			logger(`[${tag}] track rate ${curRate}/${curCh} -> ${sampleRate}/${channelCount}; restarting player`);
			killPlayer();
		}
		if (!player) {
			player = spawnPlayer(sampleRate, channelCount);
			const spawned = player;
			writer = createBoundedPcmWriter(spawned.stdin, { tag });
			curRate = sampleRate;
			curCh = channelCount;
			spawned.on("exit", (code) => {
				const expected = expectedExits.delete(spawned);
				if (code && !stopped && !expected) logger(`[${tag}] player exited with code ${code}`);
				if (player === spawned) {
					writer?.stop();
					writer = null;
					player = null;
				}
			});
		}
		if (writer) {
			// `samples` is an Int16Array — write its raw little-endian bytes.
			writer.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
		}
	};

	return {
		stop() {
			stopped = true;
			try { sink.stop(); } catch {}
			killPlayer();
		},
	};
}
