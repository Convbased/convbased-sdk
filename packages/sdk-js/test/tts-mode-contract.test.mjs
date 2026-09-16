import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	Convbased,
	TTS_GENERATION_MODES,
	TtsClient,
} from "../dist/index.js";

const CLIENT_ID = "example.browser";

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
			scope: "tts",
			resource: { type: "tts" },
		}),
		"signature",
	].join(".");
}

function client() {
	return new TtsClient({
		auth: { clientId: CLIENT_ID, sessionToken: sessionToken() },
		graphqlUrl: "https://example.invalid/graphql",
	});
}

function completedJob(mode = "general") {
	return {
		job_id: "job_01",
		status: "done",
		position: 0,
		result: {
			key: "tts/result.wav",
			url: "https://cdn.example.invalid/result.wav",
			token_count: 8,
			billing_quantity: mode === "advanced" ? 2.5 : 8,
			billing_unit: mode === "advanced" ? "SECOND" : "CHAR",
			mode,
			audio_duration_sec: 2.5,
			amount_charged: 0.05,
			balance_after: 9.95,
			subtitle: mode === "advanced" ? [{ text: "hello" }] : null,
		},
		error: null,
	};
}

test("semantic modes expose public capabilities and pricing", async () => {
	const originalFetch = globalThis.fetch;
	const queries = [];
	globalThis.fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		queries.push(request.query);
		if (request.query.includes("ttsModes")) {
			return Response.json({
				data: {
					ttsModes: [
						{
							mode: "general",
							billing_unit: "CHAR",
							clone_requires_transcript: true,
							max_references: 1,
							supports_context: false,
						},
						{
							mode: "advanced",
							billing_unit: "SECOND",
							clone_requires_transcript: false,
							max_references: 3,
							supports_context: true,
						},
					],
				},
			});
		}
		return Response.json({
			data: {
				ttsPricing: {
					price_per_token: 0.001,
					advanced_price_per_second: 0.02,
					advanced_max_seconds: 120,
					min_charge: 0.01,
				},
			},
		});
	};
	try {
		assert.deepEqual(TTS_GENERATION_MODES, [
			"general",
			"expressive",
			"advanced",
		]);
		assert.deepEqual(await client().getModes(), [
			{
				mode: "general",
				billingUnit: "CHAR",
				cloneRequiresTranscript: true,
				maxReferences: 1,
				supportsContext: false,
			},
			{
				mode: "advanced",
				billingUnit: "SECOND",
				cloneRequiresTranscript: false,
				maxReferences: 3,
				supportsContext: true,
			},
		]);
		assert.deepEqual(await client().getPricing(), {
			pricePerToken: 0.001,
			advancedPricePerSecond: 0.02,
			advancedMaxSeconds: 120,
			minCharge: 0.01,
		});
		assert.equal(queries.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("reference-free synthesis submits a semantic mode and maps billing", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return Response.json({ data: { submitTts: completedJob() } });
	};
	try {
		const result = await Convbased.textToSpeech({
			auth: { clientId: CLIENT_ID, sessionToken: sessionToken() },
			text: "hello",
			mode: "general",
		});
		assert.deepEqual(request.variables.input, {
			reference_key: null,
			reference_keys: null,
			emo_reference_key: null,
			text: "hello",
			mode: "general",
			prompt_text: null,
			params: null,
		});
		assert.deepEqual(result, {
			key: "tts/result.wav",
			url: "https://cdn.example.invalid/result.wav",
			tokenCount: 8,
			billingQuantity: 8,
			billingUnit: "CHAR",
			mode: "general",
			audioDurationSec: 2.5,
			amountCharged: 0.05,
			balanceAfter: 9.95,
			subtitle: null,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ordered references and mode-specific fields reach the GraphQL boundary", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return Response.json({ data: { submitTts: completedJob("advanced") } });
	};
	try {
		const job = await client().submit({
			referenceKeys: ["context/a.wav", "context/b.wav"],
			emotionReferenceKey: "emotion/reference.wav",
			text: "hello",
			mode: "advanced",
			promptText: "reference transcript",
			params: { enable_subtitle: true },
		});
		assert.deepEqual(request.variables.input, {
			reference_key: null,
			reference_keys: ["context/a.wav", "context/b.wav"],
			emo_reference_key: "emotion/reference.wav",
			text: "hello",
			mode: "advanced",
			prompt_text: "reference transcript",
			params: { enable_subtitle: true },
		});
		assert.equal(job.result.mode, "advanced");
		assert.equal(job.result.billingUnit, "SECOND");
		assert.deepEqual(job.result.subtitle, [{ text: "hello" }]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("published declarations expose semantic modes without routing fields", async () => {
	const declarations = await readFile(
		new URL("../dist/tts.d.ts", import.meta.url),
		"utf8"
	);
	assert.match(declarations, /TtsGenerationMode/);
	assert.match(declarations, /getModes/);
	assert.match(declarations, /billingQuantity/);
	assert.doesNotMatch(declarations, /\bengine(?:Id)?\b/i);
});
