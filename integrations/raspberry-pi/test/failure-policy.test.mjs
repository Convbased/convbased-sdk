import assert from "node:assert/strict";
import test from "node:test";

import { isCredentialFailure } from "../failure-policy.mjs";

test("classifies permanent credential failures", () => {
	for (const message of [
		"rtcServers GraphQL error: errors.unauthorized",
		"HTTP 401 from GraphQL",
		"request forbidden (403)",
		"API_KEY is invalid",
		"credential expired",
	]) {
		assert.equal(isCredentialFailure(new Error(message)), true, message);
	}
});

test("does not classify transient transport failures as credential failures", () => {
	for (const message of [
		"fetch failed: ECONNRESET",
		"signaling timed out",
		"ICE disconnected",
		"service unavailable (503)",
	]) {
		assert.equal(isCredentialFailure(new Error(message)), false, message);
	}
});
