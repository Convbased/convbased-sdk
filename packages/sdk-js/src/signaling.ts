import type { IncomingMessage, OutgoingMessage } from "./types.js";
import { signalingWebSocketUrl } from "./signalingTicket.js";

export interface SignalingChannelOptions {
	signalingUrl: string;
	ticket: string;
	connectTimeoutMs: number;
	logger: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export interface SignalingHandlers {
	onMessage: (msg: IncomingMessage) => void;
	onClose: (event: CloseEvent) => void;
	onError: (event: Event) => void;
}

/**
 * WebSocket transport using a one-time signaling ticket.
 * The signaling service owns protocol-level connection liveness.
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

		const url = signalingWebSocketUrl(
			this.opts.signalingUrl,
			this.opts.ticket
		);
		this.opts.logger.debug?.("[convbased-sdk] connecting signaling");
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
			const onError = () => {
				cleanup();
				reject(new Error("Signaling WebSocket failed to open"));
			};
			const onClose = (e: CloseEvent) => {
				cleanup();
				reject(
					new Error(
						`Signaling WebSocket closed before open (code=${e.code})`
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

}
