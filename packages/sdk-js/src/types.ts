import type { SdkAuthentication } from "./auth.js";

// Wire-protocol types mirrored from ServerAPI / signaling.

export interface RTCServersConfig {
	urls: string[];
	username?: string;
	credential?: string;
}

export interface RTCPreferences {
	model_id: string;
	sample_rate: number;
	pitch?: number;
	rms_mix_rate?: number;
	f0_threshold?: number;
	block_time?: number;
	crossfade_time?: number;
	extra_time?: number;
	f0_autotune?: boolean;
	f0_autotune_strength?: number;
	proposed_pitch?: boolean;
	proposed_pitch_threshold?: number;
	enable_limiter?: boolean;
	limiter_threshold?: number;
	enable_lookahead?: boolean;
	lookahead_time?: number;
	formant?: number;
	index_rate?: number;
	protect?: number;
	threshold?: number;
	[key: string]: unknown;
}

export interface RealtimeProcessingLatencyStats {
	sample_count: number;
	sample_limit: number;
	sample_truncated: boolean;
	mean: number | null;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number | null;
}

export interface RealtimePerformanceStats {
	instance_id: string;
	interval_ms: number;
	block_ms: number;
	processed_blocks: number;
	processing_failures: number;
	slow_processing_blocks: number;
	dropped_input_samples: number;
	input_buffered_samples: number;
	output_buffered_samples: number;
	processing_ms: RealtimeProcessingLatencyStats;
}

/**
 * Per-task parameters for offline file inference (voice-to-voice). Forwarded
 * verbatim to the inference node alongside `task_start`. Distinct from the
 * live `RTCPreferences` — file inference exposes `f0_method`, `use_pv`, etc.
 */
export interface FileInferencePreferences {
	pitch?: number;
	f0_method?: "rmvpe" | "fcpe";
	f0_threshold?: number;
	index_rate?: number;
	protect?: number;
	f0_autotune?: boolean;
	f0_autotune_strength?: number;
	proposed_pitch?: boolean;
	proposed_pitch_threshold?: number;
	sample_rate?: number;
	formant?: number;
	block_time?: number;
	crossfade_time?: number;
	extra_time?: number;
	use_pv?: boolean;
	rms_mix_rate?: number;
	threshold?: number;
	enable_limiter?: boolean;
	limiter_threshold?: number;
	enable_lookahead?: boolean;
	lookahead_time?: number;
	[key: string]: unknown;
}

export type OutgoingMessage =
	| { type: "offer"; sdp?: string; preferences: RTCPreferences }
	| { type: "ice_candidate"; candidate: RTCIceCandidateInit }
	| { type: "config"; preferences: Partial<RTCPreferences> }
	| { type: "realtime_performance"; request_id: string; reset?: boolean }
	| {
			type: "task_start";
			task_id: string;
			audio_key: string;
			generate_name?: string;
			format?: string;
			preferences?: FileInferencePreferences;
	  }
	| { type: "task_stop"; task_id?: string }
	| { type: "exit" }
	| { type: "ping" }
	| { type: "pong" };

export enum RTCStatusCode {
	ERROR = 2000,
	GPU_INSUFFICIENT = 2001,
	DUPLICATE_CONNECTION = 2002,
	MODEL_NOT_FOUND = 2003,
	UNPAID_SERVICE = 2004,
	REQUEST_TOO_FAST = 2005,

	CONNECTED = 3000,
	REQUEST_RECEIVED = 3001,
	TRACK_READY = 3002,
	RESPONSE_SENT = 3003,
	LOADING_MODEL = 3004,
	SERVICE_READY = 3009,

	// File inference (voice-to-voice) task lifecycle codes.
	TASK_PROGRESS = 3010,
	TASK_FINISHED = 3011,
	TASK_ACK = 3012,
	REALTIME_PERFORMANCE = 3014,

	SHUTDOWN = 4000,
	SERVER_CLOSED = 5000,
}

export type TaskStatus = "success" | "failure" | "cancelled";

export type IncomingMessage =
	| {
			type: "message" | "shutdown" | "error";
			message?: string;
			code?: number;
	  }
	| { type: "answer"; sdp: string }
	| { type: "ice_candidate"; candidate: RTCIceCandidateInit }
	| {
			type: "realtime_performance";
			request_id: string | null;
			stats?: RealtimePerformanceStats;
			error?: string;
			code?: number;
	  }
	| {
			type: "task_ack";
			task_id: string;
			status: "queued" | "started";
			queue_position?: number;
			code?: number;
	  }
	| { type: "task_progress"; task_id: string; progress: number; code?: number }
	| {
			type: "task_finished";
			task_id: string;
			status: TaskStatus;
			result_key?: string;
			download_url?: string;
			error?: string;
			code?: number;
	  }
	| { type: "ping" }
	| { type: "pong" }
	| Record<string, unknown>;

export type ConnectionState =
	| "idle"
	| "signaling"
	| "negotiating"
	| "connecting"
	| "connected"
	| "closing"
	| "closed"
	| "error";

export interface ConvbasedClientOptions {
	auth: SdkAuthentication;
	/**
	 * Signaling WebSocket URL. Defaults to the production Convbased endpoint
	 * (`wss://api.weights.chat/api/signaling/ws`). Override only for
	 * self-hosted deployments. URLs ending in `/ws` are used as-is; bare
	 * hosts get `/signaling/ws` appended.
	 */
	signalingUrl?: string;
	/**
	 * GraphQL endpoint used to fetch TURN credentials. Defaults to the
	 * production Convbased endpoint (`https://api.weights.chat/api/v1/graphql`).
	 * Pass `false` to disable the auto-fetch entirely (will fall back to
	 * `iceServers` if provided, else public STUN).
	 */
	graphqlUrl?: string | false;
	/** Statically-configured ICE servers. If omitted and `graphqlUrl` is set, the SDK fetches `rtcServers`. */
	iceServers?: RTCServersConfig[];
	/** `relay` forces TURN-only — useful when STUN is blocked. */
	iceTransportPolicy?: RTCIceTransportPolicy;
	/** Opus bitrate in kbps. Default 64. */
	bitrate?: number;
	/** Send stereo. Default false. */
	stereo?: boolean;
	/** How long to wait for `SERVICE_READY` after sending the offer, in ms. Default 120_000. */
	signalingTimeoutMs?: number;
	/** How long to wait for the initial WebSocket open, in ms. Default 20_000. */
	connectTimeoutMs?: number;
	/** Optional logger; defaults to `console` for warn/error only. */
	logger?: Partial<Pick<Console, "debug" | "info" | "warn" | "error">>;
}

export interface ConnectOptions {
	/** Model ID to load on the inference node — required. */
	modelId: string;
	/** Microphone constraints. Pass an existing `MediaStream` to skip getUserMedia entirely. */
	audio?: MediaStream | MediaTrackConstraints | boolean;
	/** Additional RVC preferences forwarded to the node. */
	preferences?: Partial<Omit<RTCPreferences, "model_id" | "sample_rate">>;
	/** Sample rate to advertise to the node. Defaults to the AudioContext's `sampleRate`, falling back to 48000. */
	sampleRate?: number;
	/** Authorize file inference on this connection in addition to real-time audio. */
	enableFileInference?: boolean;
}

export interface ConnectionStats {
	rttMs: number;
	jitter: number;
	packetsLost: number;
}

export interface ServerMessageEvent {
	code?: number;
	message?: string;
	raw: IncomingMessage;
}
