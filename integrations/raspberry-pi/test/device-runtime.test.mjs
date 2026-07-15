import assert from "node:assert/strict";
import test from "node:test";

import {
	isRealtimeEnabled,
	waitForRealtimeEnabled,
} from "../device-runtime.mjs";

test("only an explicit off pauses legacy device profiles", () => {
	assert.equal(isRealtimeEnabled(null), true);
	assert.equal(isRealtimeEnabled({}), true);
	assert.equal(isRealtimeEnabled({ realtime_enabled: true }), true);
	assert.equal(isRealtimeEnabled({ realtime_enabled: false }), false);
});

test("disabled mode ignores failed reads and resumes on an explicit enable", async () => {
	const sleeps = [];
	const events = [];
	const reads = [
		{ ok: false, profile: null },
		{ ok: true, profile: { realtime_enabled: false } },
		{
			ok: true,
			profile: {
				realtime_enabled: true,
				model_id: "model-new",
			},
		},
	];
	const profile = await waitForRealtimeEnabled({
		initialProfile: { realtime_enabled: false },
		readProfile: async () => reads.shift(),
		pollMs: 20_000,
		sleepFn: async (ms) => sleeps.push(ms),
		onWaiting: () => events.push("waiting"),
		onEnabled: () => events.push("enabled"),
	});

	assert.deepEqual(sleeps, [20_000, 20_000, 20_000]);
	assert.deepEqual(events, ["waiting", "enabled"]);
	assert.equal(profile.model_id, "model-new");
});

test("enabled profiles do not wait or poll", async () => {
	let reads = 0;
	const profile = { realtime_enabled: true, model_id: "model-1" };
	const result = await waitForRealtimeEnabled({
		initialProfile: profile,
		readProfile: async () => {
			reads += 1;
			return { ok: true, profile };
		},
		pollMs: 20_000,
	});

	assert.equal(result, profile);
	assert.equal(reads, 0);
});
