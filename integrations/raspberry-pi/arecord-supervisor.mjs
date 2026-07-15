import { spawn } from "node:child_process";

const FATAL_SPAWN_CODES = new Set(["EACCES", "ENOENT"]);

/**
 * Run arecord with bounded exponential restart backoff.
 *
 * A process that emitted audio is treated as healthy and gets the minimum delay
 * after a later exit. Immediate failures back off to avoid a tight log loop.
 */
export function startArecord({
	args,
	onData,
	onStart = () => {},
	onFatal = (error) => { throw error; },
	retryMinMs = 1000,
	retryMaxMs = 30000,
	spawnFn = spawn,
	setTimeoutFn = setTimeout,
	clearTimeoutFn = clearTimeout,
	logger = console.error,
} = {}) {
	if (!Array.isArray(args)) throw new TypeError("args must be an array");
	if (typeof onData !== "function") throw new TypeError("onData must be a function");
	if (!(retryMinMs > 0) || retryMaxMs < retryMinMs) {
		throw new RangeError("invalid arecord retry bounds");
	}

	let child = null;
	let restartTimer = null;
	let stopped = false;
	let terminal = false;
	let retryMs = retryMinMs;
	let generation = 0;

	const scheduleRestart = (reason, hadAudio) => {
		if (stopped || terminal || restartTimer) return;
		const delay = hadAudio ? retryMinMs : retryMs;
		retryMs = Math.min(retryMaxMs, delay * 2);
		logger(`[alsa] ${reason}; retrying in ${delay}ms`);
		restartTimer = setTimeoutFn(() => {
			restartTimer = null;
			start();
		}, delay);
	};

	const failSpawn = (error) => {
		terminal = true;
		const wrapped = new Error(
			`arecord cannot start (${error.code || "unknown"}): ${error.message}`,
			{ cause: error },
		);
		onFatal(wrapped);
	};

	const start = () => {
		if (stopped || terminal) return;
		const id = ++generation;
		let hadAudio = false;
		let spawnErrored = false;

		try {
			child = spawnFn("arecord", args, { stdio: ["ignore", "pipe", "inherit"] });
		} catch (error) {
			if (FATAL_SPAWN_CODES.has(error?.code)) failSpawn(error);
			else scheduleRestart(`arecord spawn failed: ${error?.message || error}`, false);
			return;
		}
		onStart();

		child.stdout.on("data", (chunk) => {
			if (id !== generation || stopped || terminal) return;
			hadAudio = true;
			retryMs = retryMinMs;
			onData(chunk);
		});

		child.once("error", (error) => {
			if (id !== generation || stopped || terminal) return;
			spawnErrored = true;
			if (FATAL_SPAWN_CODES.has(error?.code)) failSpawn(error);
			else scheduleRestart(`arecord spawn failed: ${error?.message || error}`, false);
		});

		child.once("exit", (code, signal) => {
			if (id !== generation || stopped || terminal || spawnErrored) return;
			const status = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
			scheduleRestart(`arecord exited (${status})`, hadAudio);
		});
	};

	start();

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			generation += 1;
			if (restartTimer) clearTimeoutFn(restartTimer);
			restartTimer = null;
			try { child?.kill("SIGTERM"); } catch {}
		},
	};
}
