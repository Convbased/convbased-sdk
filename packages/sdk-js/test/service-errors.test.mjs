import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { ConvbasedClient, SdkAuthSession, SdkServiceError, graphqlRequest, issueSignalingTicket } from "../dist/index.js";

const resource = { type: "vc_model", id: "model_01" };
const quota = { code: "QUOTA_EXCEEDED", meter: "file_tasks", retryable: false, reset_at: "2026-10-01T00:00:00Z" };
function auth(provider = () => {}) {
	return new SdkAuthSession({ clientId: "example.browser", tokenProvider: async (request) => {
		provider(request);
		const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
		return [encode({ alg: "EdDSA", typ: "JWT" }), encode({ aud: "convbased-sdk",
			credential_kind: "browser_sdk_token", client_id: request.clientId,
			exp: Math.floor(Date.now() / 1000) + 600, scope: request.scopes.join(" "), resource: request.resource }), "signature"].join(".");
	} });
}

test("quota decisions survive GraphQL and ticket errors without refreshing or replaying", async (t) => {
	let credentials = 0, requests = 0;
	const session = auth(() => credentials++);
	const request = session.request(["realtime"], resource);
	t.mock.method(globalThis, "fetch", async (url) => {
		requests++;
		return Response.json(String(url).endsWith("/ticket") ? quota : { errors: [
			{ message: "expired", extensions: { code: "AUTH_EXPIRED" } },
			{ message: "quota exhausted", extensions: quota },
		] }, { status: 401 });
	});
	for (const operation of [
		() => graphqlRequest({ auth: session, tokenRequest: request, graphqlUrl: "https://example.test/graphql", query: "mutation { submit }" }),
		() => issueSignalingTicket({ auth: session, tokenRequest: request, signalingUrl: "wss://example.test/ws" }),
	]) await assert.rejects(operation(), error => error instanceof SdkServiceError &&
		error.code === quota.code && error.meter === quota.meter && error.retryable === false && error.resetAt === quota.reset_at);
	assert.equal(credentials, 1);
	assert.equal(requests, 2);
});

test("file refusal ends only its task and original results can be queried after disconnect", async (t) => {
	const scopes = [];
	const client = new ConvbasedClient({ auth: auth(request => scopes.push(request)), graphqlUrl: "https://example.test/graphql" });
	client.state = "connected";
	client.tokenRequest = client.auth.request(["realtime", "file_inference"], resource);
	const sent = [];
	client.signaling = { isOpen: true, send: frame => sent.push(frame), close() {} };
	const first = client.runFileInference({ audioKey: "source", taskId: "one" });
	const second = client.runFileInference({ audioKey: "source", taskId: "two" });
	const rejected = assert.rejects(first, error => error instanceof SdkServiceError &&
		error.taskId === "one" && error.code === quota.code && error.resetAt === quota.reset_at);
	client.handleSignalingMessage({ type: "task_finished", task_id: "one", status: "failure", error: "quota", ...quota });
	await rejected;
	assert.equal(client.getState(), "connected");
	client.handleSignalingMessage({ type: "task_finished", task_id: "two", status: "success", execution_stopped: true, result_key: "owned/result" });
	assert.equal((await second).taskId, "two");
	await assert.rejects(client.runFileInference({ audioKey: "source", taskId: "recover", timeoutMs: 5 }), error =>
		error.code === "TASK_EXECUTION_UNKNOWN" && error.taskId === "recover" && error.retryable === false && error.executionStopped === undefined);
	await client.disconnect();
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		assert.deepEqual(JSON.parse(init.body).variables, { modelId: "model_01", taskId: "two" });
		return Response.json({ data: { fileInferenceTask: { task_id: "two", status: "success", execution_stopped: true, download_url: "https://example.test/result", retryable: false } } });
	});
	assert.equal((await client.getFileInferenceTask("model_01", "two")).downloadUrl, "https://example.test/result");
	assert.deepEqual(scopes.at(-1).scopes, ["file_inference"]);
	assert.deepEqual(scopes.at(-1).resource, resource);
	assert.equal(sent.filter(frame => frame.type === "task_start").length, 3);
});

test("early server refusal wins over ICE completion and late microphone permission", async (t) => {
	const originalPeer = globalThis.RTCPeerConnection;
	t.after(() => {
		if (originalPeer === undefined) delete globalThis.RTCPeerConnection;
		else globalThis.RTCPeerConnection = originalPeer;
	});
	for (const duringMicrophone of [false, true]) {
		const client = new ConvbasedClient({ auth: auth() });
		let release, acquired = false, localStopped = 0, remoteStopped = 0;
		const gate = new Promise(resolve => { release = resolve; });
		client.openSignaling = async () => {};
		client.resolveIceServers = async () => duringMicrophone ? [] : gate;
		if (duringMicrophone) {
			globalThis.RTCPeerConnection = class { close() {} };
			client.acquireLocalStream = async () => { acquired = true; await gate;
				return { getTracks: () => [{ stop() { localStopped++; } }] }; };
		}
		const connecting = client.connect({ modelId: "model_01" });
		await new Promise(resolve => setImmediate(resolve));
		client.convertedStream = { getTracks: () => [{ stop() { remoteStopped++; } }] };
		client.handleSignalingMessage({ type: "error", message: "quota", ...quota });
		release([]);
		await assert.rejects(connecting, error => error.code === quota.code && error.retryable === false);
		assert.equal(acquired, duringMicrophone);
		assert.equal(localStopped, duringMicrophone ? 1 : 0);
		assert.equal(remoteStopped, 1);
		assert.equal(client.getPeerConnection(), null);
	}
});

test("network errors remain distinct and browser bundle exports the service error", async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline"); });
	const session = auth();
	await assert.rejects(graphqlRequest({ auth: session, tokenRequest: session.request(["realtime"], resource), graphqlUrl: "https://example.test", query: "query { rtcServers }" }),
		error => error.code === "NETWORK_ERROR" && error.retryable === true);
	const context = vm.createContext({});
	vm.runInContext(await readFile(new URL("../dist/convbased-sdk.global.js", import.meta.url), "utf8"), context);
	assert.equal(typeof context.Convbased.SdkServiceError, "function");
});

test("ticket transport failures retain a code after the bounded retry", async (t) => {
	for (const [failure, code] of [
		[new TypeError("offline"), "NETWORK_ERROR"],
		[new DOMException("Timed out", "AbortError"), "NETWORK_TIMEOUT"],
	]) {
		let attempts = 0;
		t.mock.method(globalThis, "fetch", async () => { attempts++; throw failure; });
		const client = new ConvbasedClient({ auth: auth() });
		const request = client.auth.request(["realtime"], resource);
		await assert.rejects(client.requestSignalingTicket(request), error =>
			error instanceof SdkServiceError && error.code === code && error.retryable === true);
		assert.equal(attempts, 2);
		t.mock.restoreAll();
	}
});
