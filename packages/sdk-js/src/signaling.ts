import type { IncomingMessage, OutgoingMessage } from "./types.js";

export interface SignalingChannelOptions {
	signalingUrl: string;
	apiKey: string;
	connectTimeoutMs: number;
	logger: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export interface SignalingHandlers {
	onMessage: (msg: IncomingMessage) => void;
	onClose: (event: CloseEvent) => void;
	onError: (event: Event) => void;
}

/**
 * Thin WebSocket wrapper for the Convbased signaling endpoint. Builds the URL
 * (`${base}/signaling/ws?api_key=…`), waits for `open`, and exposes JSON
 * send/recv. The signaling service owns protocol-level connection liveness.
 */
export class SignalingChannel {
	private ws: WebSocket | null = null;
	private handlers: SignalingHandlers | null = null;

	constructor(private readonly opts: SignalingChannelOptions) {}

	get isOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	async connect(handlers: SignalingHandlers): Promise<void> {
		if (this.ws) {
			throw new Error("SignalingChannel is already connected");
		}
		this.handlers = handlers;

		const url = this.buildUrl();
		this.opts.logger.debug?.("[convbased-sdk] connecting signaling:", url);
		const ws = new WebSocket(url);
		this.ws = ws;

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(new Error("Signaling WebSocket connect timeout"));
			}, this.opts.connectTimeoutMs);

			const onOpen = () => {
				cleanup();
				resolve();
			};
			const onError = (e: Event) => {
				cleanup();
				reject(
					new Error(
						`Signaling WebSocket failed to open: ${describeEvent(e)}`
					)
				);
			};
			const onClose = (e: CloseEvent) => {
				cleanup();
				reject(
					new Error(
						`Signaling WebSocket closed before open (code=${e.code}, reason=${e.reason || "?"})`
					)
				);
			};
			const cleanup = () => {
				clearTimeout(timeout);
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
				ws.removeEventListener("close", onClose);
			};
			ws.addEventListener("open", onOpen);
			ws.addEventListener("error", onError);
			ws.addEventListener("close", onClose);
		});

		ws.addEventListener("message", (e) => this.handleMessage(e));
		ws.addEventListener("close", (e) => this.handleClose(e));
		ws.addEventListener("error", (e) => this.handlers?.onError(e));
	}

	send(msg: OutgoingMessage): void {
		if (!this.isOpen) {
			throw new Error("Signaling WebSocket is not open");
		}
		this.ws!.send(JSON.stringify(msg));
	}

	close(code = 1000, reason = "client close"): void {
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
			try {
				this.ws.close(code, reason);
			} catch {
				/* ignore */
			}
		}
		this.ws = null;
	}

	private handleMessage(event: MessageEvent): void {
		if (typeof event.data !== "string") return;
		let parsed: IncomingMessage;
		try {
			parsed = JSON.parse(event.data) as IncomingMessage;
		} catch (e) {
			this.opts.logger.warn?.(
				"[convbased-sdk] dropping non-JSON signaling frame:",
				event.data
			);
			return;
		}
		this.handlers?.onMessage(parsed);
	}

	private handleClose(event: CloseEvent): void {
		this.handlers?.onClose(event);
	}

	private buildUrl(): string {
		// `signalingUrl` may be:
		//   - the full final URL ending in `/ws` (production default — used as-is)
		//   - a bare host (e.g. `ws://localhost:3010`) — we append `/signaling/ws`
		//   - something already containing `/signaling` — we append `/ws`
		let base = this.opts.signalingUrl.trim();
		if (base.endsWith("/")) base = base.slice(0, -1);

		let finalUrl: string;
		if (/\/ws$/i.test(base)) {
			finalUrl = base;
		} else if (/\/signaling$/i.test(base)) {
			finalUrl = `${base}/ws`;
		} else {
			finalUrl = `${base}/signaling/ws`;
		}

		const apiKey = this.opts.apiKey?.trim();
		if (!apiKey) throw new Error("SignalingChannel requires `apiKey`");
		const url = new URL(finalUrl);
		url.searchParams.set("api_key", apiKey);
		return url.toString();
	}
}

function describeEvent(e: Event): string {
	if (e instanceof ErrorEvent && e.message) return e.message;
	return e.type || "unknown error";
}
