import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	ConvbasedClient,
	SdkAuthError,
	SdkAuthSession,
	TtsClient,
	graphqlRequest,
} from "../dist/index.js";

const CLIENT_ID = "example.browser";
const RESOURCE = { type: "vc_model", id: "model_01" };

function token({
	expiresIn = 600,
	scope = "realtime",
	resource = RESOURCE,
	clientId = CLIENT_ID,
	audience = "convbased-sdk",
} = {}) {
	const encode = (value) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return [
		encode({ alg: "EdDSA", typ: "JWT" }),
		encode({
			aud: audience,
			credential_kind: "browser_sdk_token",
			client_id: clientId,
			exp: Math.floor(Date.now() / 1000) + expiresIn,
			scope,
			resource,
		}),
		"signature",
	].join(".");
}

function realtimeRequest(auth) {
	return auth.request(["realtime"], RESOURCE);
}

test("browser clients reject long-term API keys", () => {
	assert.throws(
		() => new ConvbasedClient({ apiKey: "sk_secret" }),
		/removed in @convbased\/sdk 0\.3\.0/
	);
	assert.throws(
		() => new TtsClient({ apiKey: "sk_secret" }),
		/removed in @convbased\/sdk 0\.3\.0/
	);
});

test("session tokens enforce expiry, scope, audience, and resource locally", async () => {
	const sessionToken = token();
	const auth = new SdkAuthSession({
		clientId: CLIENT_ID,
		sessionToken,
	});
	assert.equal(await auth.accessToken(realtimeRequest(auth)), sessionToken);

	const cases = [
		[token({ expiresIn: -1 }), "AUTH_EXPIRED"],
		[token({ scope: "file_inference" }), "AUTH_SCOPE_FORBIDDEN"],
		[token({ resource: { type: "vc_model", id: "other" } }), "AUTH_RESOURCE_FORBIDDEN"],
		[token({ audience: "convbased-user" }), "AUTH_AUDIENCE_MISMATCH"],
	];
	for (const [sessionToken, code] of cases) {
		const rejected = new SdkAuthSession({
			clientId: CLIENT_ID,
			sessionToken,
		});
		await assert.rejects(
			rejected.accessToken(realtimeRequest(rejected)),
			(error) => error instanceof SdkAuthError && error.code === code
		);
	}
});

test("token providers are single-flight and fail with a distinct error", async () => {
	let calls = 0;
	const auth = new SdkAuthSession({
		clientId: CLIENT_ID,
		tokenProvider: async () => {
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return token();
		},
	});
	const request = realtimeRequest(auth);
	await Promise.all([
		auth.accessToken(request),
		auth.accessToken(request),
		auth.accessToken(request),
	]);
	assert.equal(calls, 1);
	await auth.accessToken(request, true);
	assert.equal(calls, 2);

	const failed = new SdkAuthSession({
		clientId: CLIENT_ID,
		tokenProvider: async () => {
			throw new Error("upstream unavailable");
		},
	});
	await assert.rejects(
		failed.accessToken(realtimeRequest(failed)),
		(error) =>
			error instanceof SdkAuthError &&
			error.code === "TOKEN_PROVIDER_FAILED"
	);
});

test("GraphQL uses bearer tokens and refreshes once after credential expiry", async () => {
	const originalFetch = globalThis.fetch;
	const seen = [];
	let providerCalls = 0;
	globalThis.fetch = async (_url, init) => {
		seen.push(init.headers);
		return seen.length === 1
			? new Response(null, { status: 401 })
			: Response.json({ data: { ok: true } });
	};
	try {
		const auth = new SdkAuthSession({
			clientId: CLIENT_ID,
			tokenProvider: async () => {
				providerCalls++;
				return token();
			},
		});
		const result = await graphqlRequest({
			graphqlUrl: "https://example.invalid/graphql",
			auth,
			tokenRequest: realtimeRequest(auth),
			query: "query { ok }",
		});
		assert.deepEqual(result, { ok: true });
		assert.equal(providerCalls, 2);
		assert.equal(seen.length, 2);
		for (const headers of seen) {
			assert.match(headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
			assert.equal(headers["x-api-key"], undefined);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("published declarations expose only short-lived browser authentication", async () => {
	const declarations = await Promise.all(
		[
			"dist/auth.d.ts",
			"dist/types.d.ts",
			"dist/graphql.d.ts",
			"dist/tts.d.ts",
		].map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8"))
	);
	const publicTypes = declarations.join("\n");
	assert.doesNotMatch(publicTypes, /apiKey\s*:/);
	assert.match(publicTypes, /sessionToken: string/);
	assert.match(publicTypes, /tokenProvider: SdkTokenProvider/);
});
