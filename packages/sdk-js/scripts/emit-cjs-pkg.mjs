#!/usr/bin/env node
// The root package.json sets "type": "module", so Node treats every `.js`
// under dist/ as ESM. The CommonJS build (tsc -p tsconfig.cjs.json) emits
// `require`-style `.js` files into dist/cjs/ — we drop a scoped package.json
// there marking that subtree as CommonJS so `require("@convbased/sdk")`
// resolves correctly.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const cjsDir = resolve(here, "..", "dist", "cjs");

await mkdir(cjsDir, { recursive: true });
await writeFile(
	resolve(cjsDir, "package.json"),
	JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
	"utf8"
);
console.log("[emit-cjs-pkg] wrote dist/cjs/package.json");
