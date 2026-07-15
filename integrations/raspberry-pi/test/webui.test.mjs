import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.SIDETONE_FILE = join(tmpdir(), `convbased-sidetone-test-${process.pid}`);
const { startWebUI } = await import("../webui.mjs");

test("web UI protects local mutations", async () => {
	let muted = null;
	const ui = startWebUI({
		port: 0,
		host: "127.0.0.1",
		token: "secret",
		prefs: {},
		client: {
			getStats: async () => null,
			setMuted: (value) => { muted = value; },
		},
	});
	await once(ui.server, "listening");
	const { port } = ui.server.address();
	const base = `http://127.0.0.1:${port}`;

	try {
		let response = await fetch(`${base}/api/state`);
		let body = await response.json();
		assert.equal(body.controlAuth, true);

		response = await fetch(`${base}/api/mute`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ muted: true }),
		});
		assert.equal(response.status, 401);

		response = await fetch(`${base}/api/mute`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-convbased-token": "secret",
				origin: "http://attacker.invalid",
			},
			body: JSON.stringify({ muted: true }),
		});
		assert.equal(response.status, 403);

		response = await fetch(`${base}/api/mute`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-convbased-token": "secret",
				origin: base,
			},
			body: JSON.stringify({ muted: true }),
		});
		body = await response.json();
		assert.equal(response.status, 200);
		assert.equal(body.muted, true);
		assert.equal(muted, true);
	} finally {
		await ui.close();
	}
});
