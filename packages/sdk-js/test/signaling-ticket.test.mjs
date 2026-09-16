import assert from "node:assert/strict";
import test from "node:test";

import {
	ConvbasedClient,
	SdkAuthError,
	SdkAuthSession,
	SignalingTicketError,
	issueSignalingTicket,
	signalingTicketUrl,
	signalingWebSocketUrl,
} from "../dist/index.js";

const CLIENT_ID = "example.browser";
const RESOURCE = { type: "vc_model", id: "model_01" };
const TICKET_A = `st_${"a".repeat(43)}`;
const TICKET_B = `st_${"b".repeat(43)}`;

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

function ticketResponse(ticket, overrides = {}) {
	return {
		ticket,
		token_type: "SignalingTicket",
		expires_in: 60,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		client_id: CLIENT_ID,
		scopes: ["realtime"],
		resource: RESOURCE,
		...overrides,
	};
}

function authContext() {
	const auth = new SdkAuthSession({
		clientId: CLIENT_ID,
		sessionToken: sessionToken(),
	});
	return {
		auth,
		tokenRequest: auth.request(["realtime"], RESOURCE),
	};
}

test("signaling URLs contain only an opaque one-use ticket", () => {
	assert.equal(
		signalingTicketUrl("wss://api.weights.chat/api/signaling/ws?token=old"),
		"https://api.weights.chat/api/signaling/ticket"
	);
	const url = new URL(
		signalingWebSocketUrl(
			"wss://api.weights.chat/api/signaling/ws?api_key=old",
			TICKET_A
		)
	);
	assert.deepEqual([...url.searchParams.keys()], ["ticket"]);
	assert.equal(url.searchParams.get("ticket"), TICKET_A);
});

test("ticket issuance binds bearer, client, scopes, and model", async () => {
	const originalFetch = globalThis.fetch;
	let observed;
	globalThis.fetch = async (url, init) => {
		observed = { url, init };
		return Response.json(ticketResponse(TICKET_A));
	};
	try {
		const context = authContext();
		const ticket = await issueSignalingTicket({
			signalingUrl: "wss://api.weights.chat/api/signaling/ws",
			...context,
		});
		assert.equal(ticket, TICKET_A);
		assert.equal(
			observed.url,
			"https://api.weights.chat/api/signaling/ticket"
		);
		assert.match(observed.init.headers.Authorization, /^Bearer /);
		assert.deepEqual(JSON.parse(observed.init.body), {
			client_id: CLIENT_ID,
			scopes: ["realtime"],
			resource: RESOURCE,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ticket responses reject expiry and preserve scope failures", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			Response.json(
				ticketResponse(TICKET_A, {
					expires_at: new Date(Date.now() - 1_000).toISOString(),
				})
			);
		await assert.rejects(
			issueSignalingTicket({
				signalingUrl: "wss://example.invalid/ws",
				...authContext(),
			}),
			(error) =>
				error instanceof SignalingTicketError &&
				error.code === "INVALID_SIGNALING_TICKET_RESPONSE"
		);

		globalThis.fetch = async () =>
			Response.json(
				{ code: "AUTH_SCOPE_FORBIDDEN", detail: TICKET_A },
				{ status: 403 }
			);
		await assert.rejects(
			issueSignalingTicket({
				signalingUrl: "wss://example.invalid/ws",
				...authContext(),
			}),
			(error) =>
				error instanceof SdkAuthError &&
				error.code === "AUTH_SCOPE_FORBIDDEN" &&
				!String(error).includes(TICKET_A)
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("concurrent connections receive independent one-use tickets", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () =>
		Response.json(ticketResponse(calls++ === 0 ? TICKET_A : TICKET_B));
	try {
		const context = authContext();
		const tickets = await Promise.all([
			issueSignalingTicket({
				signalingUrl: "wss://example.invalid/ws",
				...context,
			}),
			issueSignalingTicket({
				signalingUrl: "wss://example.invalid/ws",
				...context,
			}),
		]);
		assert.deepEqual(tickets, [TICKET_A, TICKET_B]);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ticket timeout and failed WebSocket attempts always obtain fresh tickets", async () => {
	const originalFetch = globalThis.fetch;
	const originalWebSocket = globalThis.WebSocket;
	const urls = [];
	const logs = [];
	let ticketCalls = 0;

	class FakeWebSocket {
		static OPEN = 1;
		readyState = 1;
		listeners = new Map();

		constructor(url) {
			urls.push(url);
			queueMicrotask(() =>
				this.emit("error", {
					type: "error",
					message: `failed URL ${url}`,
				})
			);
		}

		addEventListener(type, listener) {
			const current = this.listeners.get(type) ?? [];
			current.push(listener);
			this.listeners.set(type, current);
		}

		removeEventListener(type, listener) {
			this.listeners.set(
				type,
				(this.listeners.get(type) ?? []).filter((item) => item !== listener)
			);
		}

		emit(type, event) {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}

		close() {
			this.readyState = 3;
		}
	}

	globalThis.fetch = async () => {
		const call = ticketCalls++;
		if (call === 0) throw new DOMException("timed out", "AbortError");
		const ticket = call === 1 ? TICKET_A : TICKET_B;
		return Response.json(ticketResponse(ticket));
	};
	globalThis.WebSocket = FakeWebSocket;
	try {
		const client = new ConvbasedClient({
			auth: {
				clientId: CLIENT_ID,
				sessionToken: sessionToken(),
			},
			iceServers: [{ urls: ["stun:example.invalid"] }],
			logger: Object.fromEntries(
				["debug", "info", "warn", "error"].map((level) => [
					level,
					(...args) => logs.push(args.join(" ")),
				])
			),
		});
		await assert.rejects(
			client.connect({ modelId: RESOURCE.id, audio: false }),
			(error) =>
				!String(error).includes(TICKET_A) &&
				!String(error).includes(TICKET_B)
		);
		assert.equal(ticketCalls, 3);
		assert.equal(urls.length, 2);
		assert.equal(new URL(urls[0]).searchParams.get("ticket"), TICKET_A);
		assert.equal(new URL(urls[1]).searchParams.get("ticket"), TICKET_B);
		assert.equal(logs.join(" ").includes(TICKET_A), false);
		assert.equal(logs.join(" ").includes(TICKET_B), false);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.WebSocket = originalWebSocket;
	}
});
