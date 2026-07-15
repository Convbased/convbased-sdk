import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function listModules(directory) {
	const modules = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) modules.push(...await listModules(path));
		else if (entry.isFile() && entry.name.endsWith(".mjs")) modules.push(path);
	}
	return modules;
}

const modules = (await listModules(root)).sort();
for (const module of modules) {
	const result = spawnSync(process.execPath, ["--check", module], { stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`[check] syntax OK: ${modules.length} JavaScript modules`);
