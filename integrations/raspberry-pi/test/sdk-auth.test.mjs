import assert from "node:assert/strict";
import test from "node:test";

import { createSdkAuth } from "../sdk-auth.mjs";

const API_KEY = "sk_server_secret";
const CLIENT_ID = "example.raspberry-pi";
const RESOURCE = { type: "vc_model", id: "model_01" };

function sessionToken() {
	const encode = (value) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return [
		encode({ alg: "EdDSA", typ: "JWT" }),
		encode({
			aud: "convbased-sdk",
			credential_kind: "browser_sdk_token",
			client_id: CLIENT_ID,
			exp: Math.floor(Date.now() / 1000) + 600,
			scope: "realtime",
			resource: RESOURCE,
		}),
		"signature",
	].join(".");
}

test("exchanges the server API key only in an HTTPS header", async () => {
	const originalFetch = globalThis.fetch;
	let observed;
	globalThis.fetch = async (url, init) => {
		observed = { url, init };
		return Response.json({
			data: { issueSdkToken: { access_token: sessionToken() } },
		});
	};
	try {
		const auth = createSdkAuth({ apiKey: API_KEY, clientId: CLIENT_ID });
		const request = auth.request(["realtime"], RESOURCE);
		await auth.accessToken(request);
		assert.equal(observed.url, "https://api.weights.chat/api/v1/graphql");
		assert.equal(observed.init.headers["x-api-key"], API_KEY);
		assert.equal(observed.url.includes(API_KEY), false);
		const payload = JSON.parse(observed.init.body);
		assert.match(payload.query, /mutation IssueSdkToken/);
		assert.deepEqual(payload.variables, {
			input: {
				client_id: CLIENT_ID,
				scopes: ["realtime"],
				resource: RESOURCE,
			},
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("does not expose the API key in provider failures", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json(
			{
				errors: [
					{
						message: API_KEY,
						extensions: { code: "AUTH_INVALID_CREDENTIAL" },
					},
				],
			},
			{ status: 200 },
		);
	try {
		const auth = createSdkAuth({ apiKey: API_KEY, clientId: CLIENT_ID });
		await assert.rejects(
			auth.accessToken(auth.request(["realtime"], RESOURCE)),
			(error) =>
				error.code === "AUTH_INVALID_CREDENTIAL" &&
				!String(error).includes(API_KEY),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
