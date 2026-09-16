// High-level façade over the lower-level clients. The three Convbased
// capabilities — live voice change, file conversion, and text-to-speech — each
// follow a fixed choreography (open a session, wire a handful of events, attach
// the resulting audio, tear down). This module folds that choreography into one
// call per capability so consumers never touch the WebRTC / signaling / GraphQL
// machinery underneath.
//
//   const session = await Convbased.startVoiceChange({ auth, modelId, output: audioEl });
//   const file    = await Convbased.convertFile({ auth, modelId, file: blob });
//   const speech  = await Convbased.textToSpeech({ auth, voice: blob, text });
//
// Reach for the underlying `ConvbasedClient` / `TtsClient` only when you need
// the raw event stream or self-hosted endpoints.

import { ConvbasedClient } from "./client.js";
import { TtsClient } from "./tts.js";
import type {
	ConnectionState,
	FileInferencePreferences,
	RTCPreferences,
} from "./types.js";
import type {
	TtsGenerationMode,
	TtsJobStatus,
	TtsParams,
	TtsReference,
	TtsResult,
} from "./tts.js";
import type { SdkAuthentication } from "./auth.js";

/** Live tuning controls — pitch, RMS mix, formant, etc. (no transport fields). */
export type VoicePreferences = Partial<
	Omit<RTCPreferences, "model_id" | "sample_rate">
>;

/** Friendly session lifecycle, with the WebRTC negotiation states collapsed. */
export type VoiceStatus = "connecting" | "live" | "ended";

/** Where converted audio is delivered: an `<audio>` element, or a raw callback. */
export type VoiceOutput =
	| HTMLMediaElement
	| ((stream: MediaStream) => void);

export interface StartVoiceChangeOptions {
	auth: SdkAuthentication;
	/** Model ID to load on the inference node. */
	modelId: string;
	/**
	 * Where to play the converted voice. Pass an `<audio>` element and the SDK
	 * wires the stream and starts playback for you; pass a callback to handle the
	 * `MediaStream` yourself. Omit to read `session.stream` manually.
	 */
	output?: VoiceOutput;
	/** Mic constraints, or a pre-captured `MediaStream` to use as the input. */
	input?: MediaStream | MediaTrackConstraints | boolean;
	/** Initial voice tuning (pitch, RMS mix, formant…). */
	preferences?: VoicePreferences;
	/** Called as the session moves through `connecting → live → ended`. */
	onStatus?: (status: VoiceStatus) => void;
	/** Called for failures that surface after the session is live. */
	onError?: (err: Error) => void;
}

/** A live voice-change session. Returned once audio is flowing both ways. */
export interface VoiceSession {
	/** The converted (voice-changed) stream, for custom audio wiring. */
	readonly stream: MediaStream | null;
	/** Shift the converted voice up/down, in semitones. */
	setPitch(semitones: number): void;
	/** Adjust any live tuning parameters; only the fields you set change. */
	update(preferences: VoicePreferences): void;
	/** Mute / unmute the microphone. */
	setMuted(muted: boolean): void;
	mute(): void;
	unmute(): void;
	/** End the session and release the mic. */
	stop(): Promise<void>;
}

export interface ConvertFileOptions {
	auth: SdkAuthentication;
	/** Model ID to load on the inference node. */
	modelId: string;
	/** The audio file/blob to convert end-to-end. */
	file: Blob;
	/** Persist before submitting, to query the original result after a lost connection. */
	taskId?: string;
	/** Per-task conversion parameters (pitch, f0 method…). */
	preferences?: FileInferencePreferences;
	/** Called with conversion progress in `[0, 1]`. */
	onProgress?: (progress: number) => void;
	/** Abort the conversion. */
	signal?: AbortSignal;
	/** Give up after this many ms. Default 300_000 (5 min). */
	timeoutMs?: number;
}

/** The converted audio, as a presigned download URL. */
export interface ConvertedFile {
	taskId: string;
	/** Presigned download URL of the converted audio. */
	url: string;
	/** Storage key of the converted audio. */
	key?: string;
}

export interface TextToSpeechOptions {
	auth: SdkAuthentication;
	/** A single reference. Omit for reference-free general mode. */
	voice?: TtsReference;
	/** Ordered references for modes that accept context. Do not combine with `voice`. */
	voices?: readonly TtsReference[];
	/** Optional separate emotion reference in expressive mode. */
	emotionVoice?: TtsReference;
	/** Text to synthesize. */
	text: string;
	/** Stable product mode. Omit to use the service default. */
	mode?: TtsGenerationMode;
	/** Transcript of the reference voice when the selected mode requires it. */
	promptText?: string;
	/** Optional mode-specific controls. */
	params?: TtsParams;
	/** Called as the job advances through the queue. */
	onProgress?: (status: TtsJobStatus, queuePosition: number) => void;
	/** Abort the synthesis (and cancel the job if still queued). */
	signal?: AbortSignal;
	/** Give up after this many ms. Default 300_000 (5 min). */
	timeoutMs?: number;
}

function toVoiceStatus(state: ConnectionState): VoiceStatus | null {
	switch (state) {
		case "signaling":
		case "negotiating":
		case "connecting":
			return "connecting";
		case "connected":
			return "live";
		case "closing":
		case "closed":
			return "ended";
		// "idle" emits nothing yet; "error" is reported through onError.
		default:
			return null;
	}
}

function attachOutput(output: VoiceOutput, stream: MediaStream): void {
	if (typeof output === "function") {
		output(stream);
		return;
	}
	output.srcObject = stream;
	// Autoplay may be blocked until a user gesture — that's the page's concern,
	// not a session error, so swallow the rejection.
	void output.play?.().catch(() => {});
}

/**
 * Open a live voice-change session: capture the mic, negotiate the connection,
 * and start streaming converted audio to `output`. Resolves once audio is
 * flowing; rejects if the session can't be established.
 */
export async function startVoiceChange(
	opts: StartVoiceChangeOptions
): Promise<VoiceSession> {
	const client = new ConvbasedClient({ auth: opts.auth });

	let lastStatus: VoiceStatus | null = null;
	client.on("state", ({ state }) => {
		const status = toVoiceStatus(state);
		if (status && status !== lastStatus) {
			lastStatus = status;
			opts.onStatus?.(status);
		}
	});
	if (opts.output) {
		const output = opts.output;
		client.on("track", ({ stream }) => attachOutput(output, stream));
		if (typeof output !== "function") client.on("closed", () => { output.srcObject = null; });
	}

	try {
		await client.connect({
			modelId: opts.modelId,
			audio: opts.input,
			preferences: opts.preferences,
		});
	} catch (err) {
		await client.disconnect().catch(() => {});
		throw err instanceof Error ? err : new Error(String(err));
	}

	// Only surface errors once the session is live — pre-connect failures already
	// rejected above, so we don't want to double-report them.
	if (opts.onError) {
		client.on("error", (err) => opts.onError!(err));
	}

	return {
		get stream() {
			return client.getConvertedStream();
		},
		setPitch(semitones: number) {
			client.updateConfig({ pitch: semitones });
		},
		update(preferences: VoicePreferences) {
			client.updateConfig(preferences);
		},
		setMuted(muted: boolean) {
			client.setMuted(muted);
		},
		mute() {
			client.setMuted(true);
		},
		unmute() {
			client.setMuted(false);
		},
		stop() {
			return client.disconnect();
		},
	};
}

/**
 * Convert a whole audio file through the model. Spins up a session, runs the
 * conversion task, and tears the session down again. Resolves with the
 * converted audio's download URL.
 */
export async function convertFile(
	opts: ConvertFileOptions
): Promise<ConvertedFile> {
	const client = new ConvbasedClient({ auth: opts.auth });
	try {
		await client.connect({
			modelId: opts.modelId,
			enableFileInference: true,
		});
		const result = await client.runFileInference({
			audio: opts.file,
			taskId: opts.taskId,
			preferences: opts.preferences,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
			onProgress: ({ progress }) => opts.onProgress?.(progress),
		});
		if (!result.downloadUrl) {
			throw new Error("Conversion finished but returned no download URL");
		}
		return { taskId: result.taskId, url: result.downloadUrl, key: result.resultKey };
	} finally {
		await client.disconnect().catch(() => {});
	}
}

/**
 * Synthesize speech from text using a reference voice. Uploads the reference
 * (when given a `Blob`), submits the job, and polls until it finishes.
 * Resolves with the synthesized audio's presigned URL and billing details.
 */
export async function textToSpeech(
	opts: TextToSpeechOptions
): Promise<TtsResult> {
	if (opts.voice && opts.voices) {
		throw new Error("textToSpeech() accepts either `voice` or `voices`, not both");
	}
	const tts = new TtsClient({ auth: opts.auth });
	return tts.synthesize({
		references: opts.voices ?? (opts.voice ? [opts.voice] : undefined),
		emotionReference: opts.emotionVoice,
		text: opts.text,
		mode: opts.mode,
		promptText: opts.promptText,
		params: opts.params,
		timeoutMs: opts.timeoutMs,
		signal: opts.signal,
		onJob: (job) => opts.onProgress?.(job.status, job.position),
	});
}

/** The three Convbased capabilities, grouped for `Convbased.startVoiceChange(…)`. */
export const Convbased = {
	startVoiceChange,
	convertFile,
	textToSpeech,
};
