import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { pipePcmToPlayer } from "../pcm-pipe.mjs";

class FakeSink {
	static current;

	constructor() {
		FakeSink.current = this;
	}

	stop() {}
}

function fakePlayer() {
	const player = new EventEmitter();
	player.stdin = new PassThrough();
	player.kill = () => {};
	return player;
}

function frame(sampleRate) {
	return {
		samples: new Int16Array(sampleRate / 100),
		sampleRate,
		channelCount: 1,
	};
}

test("does not report an expected player exit during a sample-rate change", () => {
	const players = [];
	const logs = [];
	const bridge = pipePcmToPlayer({}, () => {
		const player = fakePlayer();
		players.push(player);
		return player;
	}, "pw", { Sink: FakeSink, logger: (message) => logs.push(message) });

	FakeSink.current.ondata(frame(16000));
	FakeSink.current.ondata(frame(48000));
	players[0].emit("exit", 1);

	assert.equal(players.length, 2);
	assert.equal(logs.some((message) => message.includes("16000/1 -> 48000/1")), true);
	assert.equal(logs.some((message) => message.includes("player exited")), false);
	bridge.stop();
});

test("reports an unexpected active-player failure", () => {
	const logs = [];
	let player;
	const bridge = pipePcmToPlayer({}, () => {
		player = fakePlayer();
		return player;
	}, "pw", { Sink: FakeSink, logger: (message) => logs.push(message) });

	FakeSink.current.ondata(frame(48000));
	player.emit("exit", 7);

	assert.deepEqual(logs, ["[pw] player exited with code 7"]);
	bridge.stop();
});
