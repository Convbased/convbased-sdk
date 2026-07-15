/**
 * Write real-time PCM without letting a blocked child-process pipe grow forever.
 * The frame that crosses the high-water mark remains queued; later frames are
 * dropped until the stream drains.
 */
export function createBoundedPcmWriter(stream, {
	tag = "pcm",
	warnIntervalMs = 5000,
	now = Date.now,
	logger = console.error,
} = {}) {
	let blocked = false;
	let stopped = false;
	let dropped = 0;
	let lastWarningAt = Number.NEGATIVE_INFINITY;

	const warnDrop = () => {
		dropped += 1;
		const current = now();
		if (current - lastWarningAt < warnIntervalMs) return;
		logger(`[${tag}] player backpressure; dropped ${dropped} PCM frame(s)`);
		dropped = 0;
		lastWarningAt = current;
	};

	const onDrain = () => {
		blocked = false;
	};

	return {
		write(frame) {
			if (stopped || blocked || !stream.writable) {
				warnDrop();
				return false;
			}
			if (!stream.write(frame)) {
				blocked = true;
				stream.once("drain", onDrain);
			}
			return true;
		},
		stop() {
			stopped = true;
			stream.removeListener?.("drain", onDrain);
		},
	};
}
