#!/usr/bin/env node
// Zero-dependency static server for the browser demo.
//
// ESM imports require an http(s) origin — browsers refuse to load
// `<script type="module">` over `file://`. This script serves the SDK repo
// root so `examples/browser/index.html` can fetch `../../dist/index.js`.
//
// Usage:
//   node scripts/serve-demo.mjs           # binds 127.0.0.1:5173
//   node scripts/serve-demo.mjs --port 8080
//   node scripts/serve-demo.mjs --host 0.0.0.0 --port 8080

import { createServer } from "node:http";
import { stat, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(here, "..");
const distEntry = resolve(rootDir, "dist", "index.js");

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(getArg("--port", "5173"));
const host = getArg("--host", "127.0.0.1");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

async function exists(path) {
	try {
		const s = await stat(path);
		return s.isFile() ? "file" : s.isDirectory() ? "dir" : null;
	} catch {
		return null;
	}
}

// Refuse paths that escape the served root (e.g. `..\..\..\Windows\…`).
function safeResolve(reqPath) {
	const decoded = decodeURIComponent(reqPath.split("?")[0] || "/");
	const joined = resolve(rootDir, "." + decoded);
	if (!joined.startsWith(rootDir + sep) && joined !== rootDir) return null;
	return joined;
}

const server = createServer(async (req, res) => {
	try {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { allow: "GET, HEAD" });
			res.end("Method Not Allowed");
			return;
		}
		const url = req.url ?? "/";
		const target = safeResolve(url);
		if (!target) {
			res.writeHead(403);
			res.end("Forbidden");
			return;
		}

		let filePath = target;
		const kind = await exists(target);
		if (kind === "dir") {
			const indexFile = join(target, "index.html");
			if ((await exists(indexFile)) === "file") filePath = indexFile;
			else {
				res.writeHead(404);
				res.end("Not Found");
				return;
			}
		} else if (kind !== "file") {
			res.writeHead(404);
			res.end("Not Found");
			return;
		}

		const body = await readFile(filePath);
		const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
		res.writeHead(200, {
			"content-type": mime,
			"content-length": body.length,
			"cache-control": "no-store",
		});
		res.end(req.method === "HEAD" ? undefined : body);
	} catch (err) {
		console.error("[serve-demo] request failed:", err);
		res.writeHead(500);
		res.end("Internal Server Error");
	}
});

server.listen(port, host, async () => {
	const distOk = (await exists(distEntry)) === "file";
	const demoUrl = `http://${host}:${port}/examples/browser/`;
	console.log(`[serve-demo] root:  ${rootDir}`);
	console.log(`[serve-demo] open:  ${demoUrl}`);
	if (!distOk) {
		console.warn(
			"[serve-demo] dist/index.js not found — run `npm run build` (or `bun run build`) first.",
		);
	}
});
