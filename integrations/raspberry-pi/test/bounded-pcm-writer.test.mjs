import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createBoundedPcmWriter } from "../bounded-pcm-writer.mjs";

test("drops frames while the child pipe is backpressured", () => {
	const stream = new EventEmitter();
	stream.writable = true;
	stream.frames = [];
	stream.write = (frame) => {
		stream.frames.push(frame);
		return stream.frames.length !== 1;
	};
	let clock = 0;
	const warnings = [];
	const writer = createBoundedPcmWriter(stream, {
		tag: "test",
		warnIntervalMs: 100,
		now: () => clock,
		logger: (message) => warnings.push(message),
	});

	assert.equal(writer.write(Buffer.from([1])), true);
	assert.equal(writer.write(Buffer.from([2])), false);
	assert.equal(stream.frames.length, 1);
	assert.match(warnings[0], /dropped 1 PCM frame/);

	clock = 50;
	writer.write(Buffer.from([3]));
	assert.equal(warnings.length, 1);
	stream.emit("drain");
	assert.equal(writer.write(Buffer.from([4])), true);
	assert.equal(stream.frames.length, 2);
	writer.stop();
});
