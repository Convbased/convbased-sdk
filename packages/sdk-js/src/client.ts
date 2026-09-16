import { TypedEmitter } from "./events.js";
import { DEFAULT_GRAPHQL_URL, DEFAULT_SIGNALING_URL } from "./endpoints.js";
import { applyOpusSdpOptions } from "./sdp.js";
import { SignalingChannel } from "./signaling.js";
import {
	SignalingTicketError,
	issueSignalingTicket,
} from "./signalingTicket.js";
import {
	DEFAULT_STUN_SERVERS,
	fetchRTCServers,
} from "./rtcServers.js";
import { uploadAudio } from "./upload.js";
import { graphqlRequest } from "./graphql.js";
import { SdkServiceError } from "./errors.js";
import {
	SdkAuthSession,
	sdkAuthSession,
	type SdkTokenRequest,
} from "./auth.js";
import {
	type ConnectionState,
	type ConnectionStats,
	type ConnectOptions,
	type ConvbasedClientOptions,
	type FileInferencePreferences,
	type IncomingMessage,
	type RTCPreferences,
	type RTCServersConfig,
	RTCStatusCode,
	type ServerMessageEvent,
	type TaskStatus,
} from "./types.js";

export interface TaskAckEvent {
	taskId: string;
	status: "queued" | "started";
	queuePosition?: number;
	code?: number;
}

export interface TaskProgressEvent {
	taskId: string;
	/** Progress in [0, 1]. */
	progress: number;
	code?: number;
}

export interface TaskFinishedEvent {
	taskId: string;
	status: TaskStatus;
	/** COS key of the converted audio, on success. */
	resultKey?: string;
	/** Presigned download URL of the converted audio, on success. */
	downloadUrl?: string;
	/** Server-reported error, on failure. */
	error?: string;
	code?: string | number;
	meter?: string;
	retryable?: boolean;
	resetAt?: string | null;
	executionStopped?: boolean;
}

export interface FileInferenceTask extends Omit<TaskFinishedEvent, "status"> {
	status: TaskStatus | "accepted" | "unknown";
}

export interface StartTaskOptions {
	/** COS key of the source audio to convert (upload via `uploadAudio`). */
	audioKey: string;
	/** Optional client-supplied task id; one is generated when omitted. */
	taskId?: string;
	/** Base name for the generated output file. Default `"output"`. */
	generateName?: string;
	/** Output container format. Default `"wav"`. */
	format?: string;
	/** Per-task conversion parameters. */
	preferences?: FileInferencePreferences;
}

export interface RunFileInferenceOptions
	extends Omit<StartTaskOptions, "audioKey"> {
	/** COS key of an already-uploaded source audio. Provide this or `audio`. */
	audioKey?: string;
	/** A source-audio `Blob`/`File` to upload first. Provide this or `audioKey`. */
	audio?: Blob;
	/** Give up waiting after this many ms. Default 300_000 (5 min). */
	timeoutMs?: number;
	/** Abort the wait (and stop the task). */
	signal?: AbortSignal;
	/** Called on `task_progress` frames. */
	onProgress?: (event: TaskProgressEvent) => void;
	/** Called on the `task_ack` frame. */
	onAck?: (event: TaskAckEvent) => void;
}

type ClientEvents = {
	state: { state: ConnectionState; previous: ConnectionState };
	message: ServerMessageEvent;
	ready: { code: number; message?: string };
	track: { stream: MediaStream; track: MediaStreamTrack };
	error: Error;
	closed: { code?: number; reason?: string };
	taskAck: TaskAckEvent;
	taskProgress: TaskProgressEvent;
	taskFinished: TaskFinishedEvent;
};

/**
 * Real-time voice conversion client. Mirrors the flow used by Convbased-Web:
 *
 *  1. Open the authenticated signaling WebSocket.
 *  2. Capture the microphone (or accept a user-provided `MediaStream`).
 *  3. Build an `RTCPeerConnection`, attach the mic track, mangle the offer's
 *     Opus parameters, and send `{type: "offer", sdp, preferences}` over the
 *     signaling socket.
 *  4. Apply the `answer` and `ice_candidate` messages from the server, fire
 *     local ICE candidates back over signaling.
 *  5. When the server sends `{code: SERVICE_READY}` the processed track is
 *     emitted via the `track` event — wire it to an `<audio>` element to hear
 *     converted audio.
 *
 * The client is single-use: call `connect()` once, then `disconnect()` to
 * tear everything down. Create a fresh instance for a new session.
 */
export class ConvbasedClient extends TypedEmitter<ClientEvents> {
	private readonly opts: Omit<
		ConvbasedClientOptions,
		"signalingUrl" | "graphqlUrl" | "auth"
	> & {
		signalingUrl: string;
		graphqlUrl: string | false;
		iceTransportPolicy: RTCIceTransportPolicy;
		bitrate: number;
		stereo: boolean;
		signalingTimeoutMs: number;
		connectTimeoutMs: number;
	};
	private readonly auth: SdkAuthSession;
	private readonly logger: Required<NonNullable<ConvbasedClientOptions["logger"]>>;

	private state: ConnectionState = "idle";
	private signaling: SignalingChannel | null = null;
	private pc: RTCPeerConnection | null = null;
	private localStream: MediaStream | null = null;
	private convertedStream: MediaStream | null = null;
	private serviceReadyTimer: ReturnType<typeof setTimeout> | null = null;
	private offerInFlight = false;
	private tokenRequest: SdkTokenRequest | null = null;
	private terminalError: Error | null = null;
	private serviceReadyReceived = false;
	private disconnecting: Promise<void> | null = null;
	private closeEvent: ClientEvents["closed"] = {};

	constructor(options: ConvbasedClientOptions) {
		super();
		if (options && "apiKey" in options) {
			throw new Error(
				"`apiKey` was removed in @convbased/sdk 0.3.0; use `sessionToken` or `tokenProvider`"
			);
		}
		this.auth = sdkAuthSession(options?.auth);
		const { auth: _auth, ...clientOptions } = options;
		this.opts = {
			iceTransportPolicy: "all",
			bitrate: 64,
			stereo: false,
			signalingTimeoutMs: 120_000,
			connectTimeoutMs: 20_000,
			...clientOptions,
			// Endpoints fall back to the baked-in Convbased production URLs.
			signalingUrl: options.signalingUrl ?? DEFAULT_SIGNALING_URL,
			graphqlUrl:
				options.graphqlUrl === false
					? false
					: (options.graphqlUrl ?? DEFAULT_GRAPHQL_URL),
		};
		const provided = options.logger ?? {};
		this.logger = {
			debug: provided.debug ?? (() => {}),
			info: provided.info ?? (() => {}),
			warn: provided.warn ?? console.warn.bind(console),
			error: provided.error ?? console.error.bind(console),
		};
	}

	getState(): ConnectionState {
		return this.state;
	}

	/** The converted (voice-changed) audio stream returned from the inference node. */
	getConvertedStream(): MediaStream | null {
		return this.convertedStream;
	}

	getPeerConnection(): RTCPeerConnection | null {
		return this.pc;
	}

	/**
	 * Open the signaling socket, capture audio, and run WebRTC negotiation.
	 * Resolves when the server emits SERVICE_READY (audio is flowing both ways).
	 * Rejects on auth failures, signaling errors, or negotiation timeouts.
	 */
	async connect(opts: ConnectOptions): Promise<void> {
		if (this.state !== "idle") {
			throw new Error(
				`ConvbasedClient.connect() called from invalid state "${this.state}"`
			);
		}
		if (!opts.modelId) {
			throw new Error("ConnectOptions.modelId is required");
		}
		this.tokenRequest = this.auth.request(
			opts.enableFileInference
				? ["realtime", "file_inference"]
				: ["realtime"],
			{ type: "vc_model", id: opts.modelId.trim() }
		);

		this.setState("signaling");
		try {
			await this.openSignaling();
			this.assertActive();
			const iceServers = await this.resolveIceServers();
			this.assertActive();
			this.setState("negotiating");
			await this.openPeer(opts, iceServers);
			this.assertActive();
			await this.waitForServiceReady();
			this.assertActive();
			this.setState("connected");
		} catch (err) {
			const error = this.terminalError ?? (err instanceof Error ? err : new Error(String(err)));
			if (!this.terminalError) this.emit("error", error);
			await this.disconnect().catch(() => {});
			this.setState("error");
			throw error;
		}
	}

	/**
	 * Send a runtime config update to the inference node. Equivalent to the
	 * pitch / formant / RMS sliders in Convbased-Web — only the fields you set
	 * are forwarded.
	 */
	updateConfig(preferences: Partial<RTCPreferences>): void {
		if (!this.signaling?.isOpen) {
			throw new Error("Cannot updateConfig: signaling channel is closed");
		}
		this.signaling.send({ type: "config", preferences });
	}

	// ---------------------------------------------------------------------
	// File inference (voice-to-voice) — convert an uploaded audio file within
	// the current live session. Requires the client to be `connected` first;
	// the inference node is provisioned by `connect()`.
	// ---------------------------------------------------------------------

	/**
	 * Upload a source-audio `Blob`/`File` and resolve its COS key, ready to pass
	 * to `startTask` / `runFileInference`. Requires `graphqlUrl` (the default
	 * production endpoint, or a self-hosted override — not `false`).
	 */
	async uploadAudio(
		file: Blob,
		opts?: { filename?: string; contentType?: string; signal?: AbortSignal }
	): Promise<{ key: string }> {
		if (typeof this.opts.graphqlUrl !== "string") {
			throw new Error(
				"uploadAudio requires a GraphQL endpoint; do not set `graphqlUrl: false`"
			);
		}
		const tokenRequest = this.requireTokenRequest("file_inference");
		return uploadAudio({
			graphqlUrl: this.opts.graphqlUrl,
			auth: this.auth,
			tokenRequest,
			file,
			filename: opts?.filename,
			contentType: opts?.contentType,
			signal: opts?.signal,
		});
	}

	/** Read an existing file task, including after disconnect. Never dispatches work. */
	async getFileInferenceTask(modelId: string, taskId: string, signal?: AbortSignal): Promise<FileInferenceTask | null> {
		if (typeof this.opts.graphqlUrl !== "string")
			throw new Error("getFileInferenceTask requires a GraphQL endpoint");
		if (!modelId.trim() || !taskId.trim()) throw new Error("modelId and taskId are required");
		const data = await graphqlRequest<{ fileInferenceTask: Record<string, unknown> | null }>({
			graphqlUrl: this.opts.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.auth.request(["file_inference"], { type: "vc_model", id: modelId.trim() }),
			query: `query FileInferenceTask($modelId: String!, $taskId: String!) {
				fileInferenceTask(model_id: $modelId, task_id: $taskId) {
					task_id status execution_stopped result_key download_url error code retryable
				}
			}`,
			variables: { modelId: modelId.trim(), taskId }, signal,
		});
		return data.fileInferenceTask === null ? null : fileTaskFromWire(data.fileInferenceTask);
	}

	/**
	 * Submit a file-inference task over the signaling channel and return its
	 * task id. The client must be `connected`. Results arrive asynchronously via
	 * the `taskAck` / `taskProgress` / `taskFinished` events — use
	 * `runFileInference` for a promise-based wrapper.
	 */
	startTask(opts: StartTaskOptions): string {
		if (this.state !== "connected") {
			throw new Error(
				`startTask requires a connected session (current state "${this.state}")`
			);
		}
		if (!this.signaling?.isOpen) {
			throw new Error("Cannot startTask: signaling channel is closed");
		}
		if (!opts.audioKey) {
			throw new Error("StartTaskOptions.audioKey is required");
		}
		this.requireTokenRequest("file_inference");
		const taskId = opts.taskId ?? generateTaskId();
		this.signaling.send({
			type: "task_start",
			task_id: taskId,
			audio_key: opts.audioKey,
			generate_name: opts.generateName ?? "output",
			format: opts.format ?? "wav",
			preferences: opts.preferences,
		});
		return taskId;
	}

	/** Cancel a file-inference task. Omit `taskId` to stop the current one. */
	stopTask(taskId?: string): void {
		if (!this.signaling?.isOpen) {
			throw new Error("Cannot stopTask: signaling channel is closed");
		}
		this.requireTokenRequest("file_inference");
		this.signaling.send({ type: "task_stop", task_id: taskId });
	}

	/**
	 * Promise-based file inference: (optionally upload the source audio,) start
	 * the task, and resolve with the `taskFinished` event on success. Rejects on
	 * task failure/cancellation, timeout, signaling close, or `signal` abort.
	 */
	async runFileInference(
		opts: RunFileInferenceOptions
	): Promise<TaskFinishedEvent> {
		if (!opts.audioKey && !opts.audio) {
			throw new Error(
				"runFileInference requires either `audioKey` or `audio`"
			);
		}
		const audioKey =
			opts.audioKey ??
			(await this.uploadAudio(opts.audio!, { signal: opts.signal })).key;

		const timeoutMs = opts.timeoutMs ?? 300_000;

		return new Promise<TaskFinishedEvent>((resolve, reject) => {
			const taskId = opts.taskId ?? generateTaskId();
			let timer: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				offAck();
				offProgress();
				offFinished();
				offErr();
				offClosed();
				if (timer) clearTimeout(timer);
				if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			};
			const settleErr = (err: Error) => {
				cleanup();
				reject(err);
			};
			const onAbort = () => {
				try {
					this.stopTask(taskId);
				} catch {
					/* ignore */
				}
				settleErr(new DOMException("Aborted", "AbortError"));
			};

			const offAck = this.on("taskAck", (e) => {
				if (e.taskId === taskId) opts.onAck?.(e);
			});
			const offProgress = this.on("taskProgress", (e) => {
				if (e.taskId === taskId) opts.onProgress?.(e);
			});
			const offFinished = this.on("taskFinished", (e) => {
				if (e.taskId !== taskId) return;
				if (e.status === "success") {
					cleanup();
					resolve(e);
				} else {
					settleErr(
						new SdkServiceError(e.error || `File inference task ${e.status}`, {
							code: e.code ?? `TASK_${e.status.toUpperCase()}`,
							task_id: taskId, meter: e.meter, retryable: e.retryable,
							reset_at: e.resetAt, execution_stopped: e.executionStopped,
						})
					);
				}
			});
			const unknown = () => new SdkServiceError("File task result is unknown; query the original task", {
				code: "TASK_EXECUTION_UNKNOWN", task_id: taskId, meter: "file_tasks", retryable: false,
			});
			const offErr = this.on("error", (err) => {
				if (err instanceof SdkServiceError && err.taskId) {
					if (err.taskId === taskId) settleErr(err);
				} else settleErr(unknown());
			});
			const offClosed = this.on("closed", () =>
				settleErr(unknown())
			);

			if (opts.signal?.aborted) {
				offAck();
				offProgress();
				offFinished();
				offErr();
				offClosed();
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			timer = setTimeout(() => {
				settleErr(unknown());
			}, timeoutMs);

			try {
				this.startTask({
					audioKey,
					taskId,
					generateName: opts.generateName,
					format: opts.format,
					preferences: opts.preferences,
				});
			} catch (err) {
				settleErr(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** Mute / unmute the local mic by toggling the captured audio track. */
	setMuted(muted: boolean): void {
		const track = this.localStream?.getAudioTracks()[0];
		if (track) track.enabled = !muted;
	}

	/** Replace the local input stream (mic) with a different `MediaStream` (hot-swap). */
	async replaceLocalStream(newStream: MediaStream): Promise<void> {
		if (!this.pc) throw new Error("PeerConnection is not active");
		const newTrack = newStream.getAudioTracks()[0];
		if (!newTrack) throw new Error("Replacement stream has no audio track");
		const sender = this.pc
			.getSenders()
			.find((s) => s.track?.kind === "audio");
		if (!sender) throw new Error("No audio sender on PeerConnection");
		await sender.replaceTrack(newTrack);
		this.stopTracks(this.localStream);
		this.localStream = newStream;
	}

	/** Snapshot of jitter / loss / RTT (sampled from `RTCPeerConnection.getStats`). */
	async getStats(): Promise<ConnectionStats | null> {
		if (!this.pc || this.pc.connectionState !== "connected") return null;
		const report = await this.pc.getStats();
		const stats: ConnectionStats = { rttMs: 0, jitter: 0, packetsLost: 0 };
		report.forEach((entry: any) => {
			if (
				entry.type === "candidate-pair" &&
				entry.state === "succeeded" &&
				typeof entry.currentRoundTripTime === "number"
			) {
				stats.rttMs = Math.round(entry.currentRoundTripTime * 1000);
			}
			if (entry.type === "inbound-rtp" && entry.kind === "audio") {
				if (typeof entry.jitter === "number") stats.jitter = entry.jitter;
				if (typeof entry.packetsLost === "number") {
					stats.packetsLost = entry.packetsLost;
				}
			}
		});
		return stats;
	}

	/** Gracefully end the session — notifies the server, closes the PC. */
	disconnect(): Promise<void> {
		return this.disconnecting ??= this.closeSession();
	}

	private async closeSession(): Promise<void> {
		if (this.state === "closed" || this.state === "closing") return;
		this.setState("closing");
		this.clearServiceReadyTimer();

		try {
			if (this.signaling?.isOpen) {
				try {
					this.signaling.send({ type: "exit" });
					// Give the frame a tick to flush before we yank the socket.
					await new Promise((r) => setTimeout(r, 25));
				} catch {
					/* socket already gone */
				}
			}
		} finally {
			this.tearDownPeer();
			this.signaling?.close();
			this.signaling = null;
			this.tokenRequest = null;
			this.setState("closed");
			this.emit("closed", this.closeEvent);
		}
	}

	// ---------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------

	private async openSignaling(): Promise<void> {
		const tokenRequest = this.requireTokenRequest("realtime");
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			const ticket = await this.requestSignalingTicket(tokenRequest);
			const channel = new SignalingChannel({
				signalingUrl: this.opts.signalingUrl,
				ticket,
				connectTimeoutMs: this.opts.connectTimeoutMs,
				logger: this.logger,
			});
			try {
				await channel.connect({
					onMessage: (msg) => this.handleSignalingMessage(msg),
					onClose: (e) => this.handleSignalingClose(e),
					onError: () =>
						this.logger.warn?.(
							"[convbased-sdk] signaling error event"
						),
				});
				this.signaling = channel;
				if (this.terminalError || this.state === "closed" || this.state === "closing") {
					channel.close();
					this.signaling = null;
					this.assertActive();
				}
				return;
			} catch (error) {
				lastError = error;
				channel.close();
				if (this.terminalError) throw this.terminalError;
				if (error instanceof SdkServiceError && error.retryable === false) throw error;
			}
		}
		throw lastError instanceof Error
			? lastError
			: new SdkServiceError("Signaling WebSocket failed to open", { code: "NETWORK_ERROR", retryable: true });
	}

	private async requestSignalingTicket(
		tokenRequest: SdkTokenRequest
	): Promise<string> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(),
				this.opts.connectTimeoutMs
			);
			try {
				return await issueSignalingTicket({
					signalingUrl: this.opts.signalingUrl,
					auth: this.auth,
					tokenRequest,
					signal: controller.signal,
				});
			} catch (error) {
				const retryable =
					error instanceof TypeError ||
					(error instanceof SignalingTicketError && error.retryable) ||
					(error instanceof Error && error.name === "AbortError");
				if (attempt === 0 && retryable) continue;
				if (retryable && !(error instanceof SignalingTicketError)) {
					throw new SdkServiceError("Signaling ticket request failed", {
						code: error instanceof Error && error.name === "AbortError"
							? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
						retryable: true,
					});
				}
				throw error;
			} finally {
				clearTimeout(timeout);
			}
		}
		throw new SignalingTicketError("SIGNALING_TICKET_FAILED");
	}

	private async resolveIceServers(): Promise<RTCServersConfig[]> {
		if (this.opts.iceServers?.length) return this.opts.iceServers;
		if (typeof this.opts.graphqlUrl === "string") {
			try {
				const tokenRequest = this.requireTokenRequest("realtime");
				const cfg = await fetchRTCServers({
					graphqlUrl: this.opts.graphqlUrl,
					auth: this.auth,
					tokenRequest,
				});
				if (cfg.urls?.length) return [cfg];
			} catch (e) {
				if (e instanceof SdkServiceError && e.retryable === false) throw e;
				this.logger.warn?.(
					"[convbased-sdk] fetchRTCServers failed, falling back to STUN:",
					e
				);
			}
		}
		return DEFAULT_STUN_SERVERS;
	}

	private requireTokenRequest(scope: "realtime" | "file_inference") {
		if (!this.tokenRequest?.scopes.includes(scope)) {
			throw new Error(
				`${scope} is not authorized for this client connection`
			);
		}
		return this.tokenRequest;
	}

	private async openPeer(
		opts: ConnectOptions,
		iceServers: RTCServersConfig[]
	): Promise<void> {
		const pc = new RTCPeerConnection({
			iceServers: iceServers as RTCIceServer[],
			iceTransportPolicy: this.opts.iceTransportPolicy,
		});
		this.pc = pc;

		pc.onicecandidate = (event) => {
			if (event.candidate && this.signaling?.isOpen) {
				this.signaling.send({
					type: "ice_candidate",
					candidate: event.candidate.toJSON(),
				});
			}
		};
		pc.ontrack = (event) => {
			const stream = event.streams[0] ?? new MediaStream([event.track]);
			this.convertedStream = stream;
			this.emit("track", { stream, track: event.track });
		};
		pc.onconnectionstatechange = () => {
			const cs = pc.connectionState;
			this.logger.debug?.("[convbased-sdk] pc state:", cs);
			if (cs === "connecting") {
				if (this.state === "negotiating") this.setState("connecting");
			} else if (cs === "failed" || cs === "disconnected" || cs === "closed") {
				if (this.state !== "closing" && this.state !== "closed") {
					this.failSession(new SdkServiceError(`PeerConnection entered "${cs}" state`, {
						code: "NETWORK_ERROR", retryable: true,
					}));
				}
			}
		};

		const localStream = await this.acquireLocalStream(opts.audio);
		this.localStream = localStream;
		if (this.terminalError || this.state === "closing" || this.state === "closed") {
			this.stopTracks(this.localStream);
			this.localStream = null;
			this.assertActive();
		}
		for (const track of localStream.getAudioTracks()) {
			pc.addTrack(track, localStream);
		}

		const offer = await pc.createOffer({ offerToReceiveAudio: true });
		offer.sdp = applyOpusSdpOptions(offer.sdp ?? "", {
			bitrateKbps: this.opts.bitrate,
			stereo: this.opts.stereo,
		});
		await pc.setLocalDescription(offer);
		this.assertActive();

		const sampleRate =
			opts.sampleRate ??
			detectSampleRate(localStream) ??
			48000;

		const preferences: RTCPreferences = {
			...(opts.preferences ?? {}),
			model_id: opts.modelId,
			sample_rate: sampleRate,
		};

		if (!this.signaling?.isOpen) {
			throw new Error("Signaling channel closed before offer was sent");
		}
		this.offerInFlight = true;
		this.signaling.send({ type: "offer", sdp: offer.sdp, preferences });
	}

	private async acquireLocalStream(
		audio: ConnectOptions["audio"]
	): Promise<MediaStream> {
		if (audio instanceof MediaStream) return audio;
		const constraints: MediaStreamConstraints = {
			audio: audio === undefined ? true : (audio as boolean | MediaTrackConstraints),
			video: false,
		};
		if (
			typeof navigator === "undefined" ||
			!navigator.mediaDevices?.getUserMedia
		) {
			throw new Error(
				"navigator.mediaDevices.getUserMedia is unavailable — pass a MediaStream via `audio`"
			);
		}
		return navigator.mediaDevices.getUserMedia(constraints);
	}

	private waitForServiceReady(): Promise<void> {
		if (this.terminalError) return Promise.reject(this.terminalError);
		if (this.serviceReadyReceived) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const off = this.on("ready", () => {
				cleanup();
				resolve();
			});
			const offErr = this.on("error", (err) => {
				cleanup();
				reject(err);
			});
			const offClosed = this.on("closed", () => {
				cleanup();
				reject(this.terminalError ?? new SdkServiceError("Signaling closed before SERVICE_READY", { code: "SESSION_CLOSED" }));
			});

			this.serviceReadyTimer = setTimeout(() => {
				cleanup();
				reject(
					new Error(
						`Timed out waiting for SERVICE_READY after ${this.opts.signalingTimeoutMs}ms`
					)
				);
			}, this.opts.signalingTimeoutMs);

			const cleanup = () => {
				off();
				offErr();
				offClosed();
				this.clearServiceReadyTimer();
			};
		});
	}

	private clearServiceReadyTimer(): void {
		if (this.serviceReadyTimer) {
			clearTimeout(this.serviceReadyTimer);
			this.serviceReadyTimer = null;
		}
	}

	private handleSignalingMessage(msg: IncomingMessage): void {
		if (this.state === "closing" || this.state === "closed") return;
		const type = (msg as { type?: string }).type;
		this.emit("message", {
			code: (msg as { code?: string | number }).code,
			message: (msg as { message?: string }).message,
			raw: msg,
		});

		switch (type) {
			case "answer":
				void this.applyAnswer(msg as { sdp: string });
				break;

			case "ice_candidate":
				void this.applyRemoteCandidate(
					msg as { candidate: RTCIceCandidateInit }
				);
				break;

			case "task_ack": {
				const m = msg as {
					task_id: string;
					status: "queued" | "started";
					queue_position?: number;
					code?: number;
				};
				this.emit("taskAck", {
					taskId: m.task_id,
					status: m.status,
					queuePosition: m.queue_position,
					code: m.code,
				});
				break;
			}

			case "task_progress": {
				const m = msg as {
					task_id: string;
					progress: number;
					code?: number;
				};
				this.emit("taskProgress", {
					taskId: m.task_id,
					progress: m.progress,
					code: m.code,
				});
				break;
			}

			case "task_finished": {
				const task = fileTaskFromWire(msg as Record<string, unknown>);
				if (task.status === "success" || task.status === "failure" || task.status === "cancelled")
					this.emit("taskFinished", { ...task, status: task.status });
				break;
			}

			case undefined:
			case "message": {
				const code = (msg as { code?: number }).code;
				const text = (msg as { message?: string }).message;
				if (code === RTCStatusCode.SERVICE_READY) {
					this.serviceReadyReceived = true;
					this.emit("ready", { code, message: text });
				} else if (
					code === RTCStatusCode.ERROR ||
					code === RTCStatusCode.GPU_INSUFFICIENT ||
					code === RTCStatusCode.UNPAID_SERVICE ||
					code === RTCStatusCode.MODEL_NOT_FOUND ||
					code === RTCStatusCode.DUPLICATE_CONNECTION ||
					code === RTCStatusCode.REQUEST_TOO_FAST
				) {
					this.failSession(new SdkServiceError(text || `Server reported error code ${code}`, msg));
				} else if (code === RTCStatusCode.SHUTDOWN) {
					this.failSession(new SdkServiceError(text || "Server stopped the session", msg));
				}
				break;
			}

			case "shutdown":
			case "error": {
				const text = (msg as { message?: string }).message;
				this.failSession(new SdkServiceError(text || `Server sent "${type}"`, msg));
				break;
			}

			case "ping":
				if (this.signaling?.isOpen) this.signaling.send({ type: "pong" });
				break;

			case "pong":
			default:
				// task_* and other passthrough messages are surfaced via the
				// generic "message" event above.
				break;
		}
	}

	private async applyAnswer(msg: { sdp: string }): Promise<void> {
		if (!this.pc) return;
		try {
			await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
			this.offerInFlight = false;
		} catch (e) {
			this.emit(
				"error",
				new Error(`Failed to apply remote answer: ${describeErr(e)}`)
			);
		}
	}

	private async applyRemoteCandidate(msg: {
		candidate: RTCIceCandidateInit;
	}): Promise<void> {
		if (!this.pc) return;
		try {
			await this.pc.addIceCandidate(msg.candidate);
		} catch (e) {
			this.logger.warn?.("[convbased-sdk] addIceCandidate failed:", e);
		}
	}

	private handleSignalingClose(event: CloseEvent): void {
		if (this.state === "closing" || this.state === "closed") return;
		this.closeEvent = { code: event.code, reason: event.reason };
		this.failSession(new SdkServiceError(event.reason || "Signaling closed", {
			code: event.code === 1008 ? "SIGNALING_POLICY_REJECTED" : "SESSION_CLOSED",
			retryable: event.code !== 1000 && event.code !== 1008,
		}));
	}

	private failSession(error: Error): void {
		if (this.terminalError) return;
		this.terminalError = error;
		this.emit("error", error);
		void this.disconnect();
	}

	private assertActive(): void {
		if (this.terminalError) throw this.terminalError;
		if (this.state === "closing" || this.state === "closed")
			throw new SdkServiceError("Session closed", { code: "SESSION_CLOSED" });
	}

	private tearDownPeer(): void {
		if (this.pc) {
			try {
				this.pc.onicecandidate = null;
				this.pc.ontrack = null;
				this.pc.onconnectionstatechange = null;
				this.pc.close();
			} catch {
				/* ignore */
			}
			this.pc = null;
		}
		this.stopTracks(this.localStream);
		this.stopTracks(this.convertedStream);
		this.localStream = null;
		this.convertedStream = null;
	}

	private stopTracks(stream: MediaStream | null): void {
		stream?.getTracks().forEach((t) => {
			try {
				t.stop();
			} catch {
				/* ignore */
			}
		});
	}

	private setState(next: ConnectionState): void {
		if (next === this.state) return;
		const previous = this.state;
		this.state = next;
		this.emit("state", { state: next, previous });
	}
}

function fileTaskFromWire(wire: Record<string, unknown>): FileInferenceTask {
	if (!wire || typeof wire.task_id !== "string" ||
		!["accepted", "unknown", "success", "failure", "cancelled"].includes(String(wire.status)))
		throw new SdkServiceError("Invalid file task response", { code: "INVALID_FILE_TASK_RESPONSE" });
	const error = new SdkServiceError(typeof wire.error === "string" ? wire.error : "", wire);
	return {
		taskId: wire.task_id, status: wire.status as FileInferenceTask["status"],
		resultKey: typeof wire.result_key === "string" ? wire.result_key : undefined,
		downloadUrl: typeof wire.download_url === "string" ? wire.download_url : undefined,
		error: error.message || undefined,
		code: typeof wire.code === "string" || typeof wire.code === "number" ? wire.code : undefined,
		meter: error.meter, retryable: error.retryable, resetAt: error.resetAt,
		executionStopped: error.executionStopped,
	};
}

function generateTaskId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function detectSampleRate(stream: MediaStream): number | null {
	const track = stream.getAudioTracks()[0];
	const rate = track?.getSettings()?.sampleRate;
	return typeof rate === "number" ? rate : null;
}

function describeErr(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
