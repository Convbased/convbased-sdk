import assert from "node:assert/strict";
import test from "node:test";

import { createRedactingLogger, redactLogValue } from "../redacting-logger.mjs";

test("redacts signaling credentials without changing other log fields", () => {
	const secret = "never-log-this";
	const input = `wss://example.test/ws?api_key=${secret}&model=voice`;
	const output = redactLogValue(input);
	assert.equal(output, "wss://example.test/ws?api_key=<redacted>&model=voice");
	assert.equal(output.includes(secret), false);
	const object = { input };
	assert.equal(redactLogValue(object), object);
});

test("redacts every logger level", () => {
	const records = [];
	const sink = Object.fromEntries(
		["debug", "info", "warn", "error"].map((level) => [level, (...args) => records.push([level, ...args])]),
	);
	const logger = createRedactingLogger(sink);
	for (const level of ["debug", "info", "warn", "error"]) {
		logger[level](`https://example.test/?token=secret-${level}`, level);
	}
	assert.equal(records.length, 4);
	assert.equal(records.some((record) => record.join(" ").includes("secret-")), false);
});
