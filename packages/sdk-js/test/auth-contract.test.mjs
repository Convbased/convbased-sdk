import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	ConvbasedClient,
	TtsClient,
	graphqlRequest,
} from "../dist/index.js";

test("public clients require a non-empty API key", () => {
	assert.throws(
		() => new ConvbasedClient({}),
		/ConvbasedClient requires `apiKey`/
	);
	assert.throws(
		() => new ConvbasedClient({ apiKey: "   " }),
		/ConvbasedClient requires `apiKey`/
	);
	assert.throws(() => new TtsClient({}), /TtsClient requires `apiKey`/);
	assert.throws(
		() => new TtsClient({ apiKey: "   " }),
		/TtsClient requires `apiKey`/
	);
});

test("GraphQL transport rejects requests without an API key before fetch", async () => {
	await assert.rejects(
		graphqlRequest({
			graphqlUrl: "https://example.invalid/graphql",
			query: "query { __typename }",
		}),
		/GraphQL request requires `apiKey`/
	);
});

test("published declarations require API-key authentication", async () => {
	const declarations = await Promise.all(
		[
			"dist/types.d.ts",
			"dist/graphql.d.ts",
			"dist/signaling.d.ts",
			"dist/tts.d.ts",
		].map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8"))
	);
	assert.match(declarations.join("\n"), /apiKey: string;/);
});
