import assert from "node:assert/strict";
import test from "node:test";

import { fetchDeviceProfile } from "../device-profile.mjs";

function response(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() { return body; },
	};
}

test("reads and normalizes a device profile", async () => {
	let request;
	const profile = await fetchDeviceProfile({
		graphqlUrl: "https://example.test/graphql",
		apiKey: "test-api-key",
		fetchFn: async (url, options) => {
			request = { url, options };
			return response({
				data: {
					myDeviceProfile: {
						model_id: "model-new",
						preferences: { pitch: 4 },
						realtime_enabled: false,
					},
				},
			});
		},
	});

	assert.deepEqual(profile, {
		model_id: "model-new",
		preferences: { pitch: 4 },
		realtime_enabled: false,
	});
	assert.equal(request.url, "https://example.test/graphql");
	assert.equal(request.options.headers["x-api-key"], "test-api-key");
});

test("preserves enabled behavior for an older profile payload", async () => {
	const profile = await fetchDeviceProfile({
		graphqlUrl: "https://example.test/graphql",
		apiKey: "test-api-key",
		fetchFn: async () => response({
			data: {
				myDeviceProfile: {
					model_id: "model-old",
					preferences: null,
				},
			},
		}),
	});
	assert.equal(profile.realtime_enabled, true);
});

test("returns null only when no profile is bound", async () => {
	const profile = await fetchDeviceProfile({
		graphqlUrl: "https://example.test/graphql",
		apiKey: "test-api-key",
		fetchFn: async () => response({ data: { myDeviceProfile: null } }),
	});
	assert.equal(profile, null);
});

test("reports GraphQL rejection without copying the server message", async () => {
	const call = fetchDeviceProfile({
		graphqlUrl: "https://example.test/graphql",
		apiKey: "test-api-key",
		fetchFn: async () => response({
			errors: [{
				message: "private server detail",
				extensions: { code: "FORBIDDEN", field: "myDeviceProfile" },
			}],
		}),
	});
	await assert.rejects(call, (error) => {
		assert.equal(
			error.message,
			"device profile query rejected (FORBIDDEN field=myDeviceProfile)",
		);
		assert.equal(error.message.includes("private server detail"), false);
		return true;
	});
});

test("reports HTTP failures", async () => {
	await assert.rejects(
		fetchDeviceProfile({
			graphqlUrl: "https://example.test/graphql",
			apiKey: "test-api-key",
			fetchFn: async () => response({}, 503),
		}),
		/device profile request failed \(HTTP 503\)/,
	);
});
