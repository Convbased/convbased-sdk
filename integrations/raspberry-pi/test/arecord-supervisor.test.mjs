import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { startArecord } from "../arecord-supervisor.mjs";

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.kill = () => { child.killed = true; };
	return child;
}

test("restart timing reaches its cap and resets after audio", () => {
	const children = [];
	const timers = [];
	const supervisor = startArecord({
		args: [],
		retryMinMs: 10,
		retryMaxMs: 40,
		spawnFn() {
			const child = fakeChild();
			children.push(child);
			return child;
		},
		setTimeoutFn(callback, delay) {
			const timer = { callback, delay };
			timers.push(timer);
			return timer;
		},
		clearTimeoutFn() {},
		logger() {},
		onData() {},
	});

	children[0].emit("exit", 1, null);
	let timer = timers.shift();
	assert.equal(timer.delay, 10);
	timer.callback();
	children[1].emit("exit", 1, null);
	timer = timers.shift();
	assert.equal(timer.delay, 20);
	timer.callback();
	children[2].emit("exit", 1, null);
	timer = timers.shift();
	assert.equal(timer.delay, 40);
	timer.callback();
	children[3].emit("exit", 1, null);
	timer = timers.shift();
	assert.equal(timer.delay, 40);
	timer.callback();
	children[4].stdout.emit("data", Buffer.from([1, 2]));
	children[4].emit("exit", 1, null);
	timer = timers.shift();
	assert.equal(timer.delay, 10);
	supervisor.stop();
});

test("ENOENT is fatal and is not retried", () => {
	const child = fakeChild();
	const timers = [];
	let fatal = null;
	startArecord({
		args: [],
		spawnFn: () => child,
		setTimeoutFn: (callback, delay) => timers.push({ callback, delay }),
		logger() {},
		onData() {},
		onFatal: (error) => { fatal = error; },
	});
	const error = Object.assign(new Error("not found"), { code: "ENOENT" });
	child.emit("error", error);
	assert.match(fatal.message, /arecord cannot start \(ENOENT\)/);
	assert.equal(timers.length, 0);
});
