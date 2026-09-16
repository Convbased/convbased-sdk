// Text-to-speech client for the Convbased speech service. This path is pure
// GraphQL — it does not touch WebRTC or the signaling socket. Synthesis is
// asynchronous: you submit a job, then poll until it reaches a terminal state.
//
// Typical flow:
//   const tts = new TtsClient({ auth });
//   const { key } = await tts.uploadReferenceAudio(file); // reference voice
//   const result = await tts.synthesize({ referenceKey: key, text: "This is a synthesis test." });
//   audio.src = result.url; // presigned, ~1h

import { DEFAULT_GRAPHQL_URL } from "./endpoints.js";
import { graphqlRequest } from "./graphql.js";
import { uploadAudio } from "./upload.js";
import {
	SdkAuthSession,
	sdkAuthSession,
	type SdkAuthentication,
	type SdkTokenRequest,
} from "./auth.js";

/** Stable product modes. Execution providers remain private to the service. */
export const TTS_GENERATION_MODES = [
	"general",
	"expressive",
	"advanced",
] as const;

export type TtsGenerationMode = (typeof TTS_GENERATION_MODES)[number];
export type TtsBillingUnit = "CHAR" | "SECOND";

/** Expressive-mode emotion, sampling, and segmentation controls. */
export interface ExpressiveTtsParams {
	emo_alpha?: number;
	emo_vector?: number[];
	use_emo_text?: boolean;
	emo_text?: string;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	max_text_tokens_per_segment?: number;
	interval_silence?: number;
}

/** General-mode voice-design controls. */
export interface GeneralTtsParams {
	cfg_value?: number;
	inference_timesteps?: number;
	normalize?: boolean;
	denoise?: boolean;
}

/** Advanced-mode direction and output controls. */
export interface AdvancedTtsParams {
	scene_description?: string;
	format?: "wav" | "mp3" | "ogg_opus";
	sample_rate?: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
	speech_rate?: number;
	loudness_rate?: number;
	pitch_rate?: number;
	enable_subtitle?: boolean;
}

/** Mode-specific controls validated by the service. */
export type TtsParams =
	| ExpressiveTtsParams
	| GeneralTtsParams
	| AdvancedTtsParams
	| Record<string, unknown>;

export type TtsJobStatus =
	| "queued"
	| "warming"
	| "processing"
	| "done"
	| "failed"
	| "cancelled";

export interface TtsResult {
	/** COS key of the synthesized audio. */
	key: string;
	/** Presigned URL of the synthesized audio (valid ~1h), or null if unsigned. */
	url: string | null;
	/** Input-text token count the charge was based on. */
	tokenCount: number;
	/** Quantity actually billed in `billingUnit`. */
	billingQuantity: number;
	/** Unit used by `billingQuantity`. */
	billingUnit: TtsBillingUnit;
	/** Product mode that produced this result; null only for legacy jobs. */
	mode: TtsGenerationMode | null;
	/** Duration of the synthesized audio, in seconds. */
	audioDurationSec: number;
	/** Amount deducted from the wallet for this synthesis. */
	amountCharged: number;
	/** Wallet balance after the deduction. */
	balanceAfter: number;
	/** Word or sentence timing when subtitle generation is enabled. */
	subtitle: unknown | null;
}

export interface TtsJob {
	jobId: string;
	status: TtsJobStatus;
	/** 1-based queue position while `queued`; 0 otherwise. */
	position: number;
	/** Result, populated once `status === "done"`. */
	result: TtsResult | null;
	/** Server-reported error key when `status === "failed"`. */
	error: string | null;
}

export interface TtsPricing {
	/** Price charged per input character; the API keeps its legacy field name. */
	pricePerToken: number;
	/** Advanced-mode retail price charged per settled second. */
	advancedPricePerSecond: number;
	/** Maximum seconds used for the advanced-mode temporary reservation. */
	advancedMaxSeconds: number;
	/** Minimum charge applied to any single synthesis. */
	minCharge: number;
}

export interface TtsModeInfo {
	mode: TtsGenerationMode;
	billingUnit: TtsBillingUnit;
	/** Whether a reference transcript must be supplied as `promptText`. */
	cloneRequiresTranscript: boolean;
	/** Maximum ordered audio references accepted by this mode. */
	maxReferences: number;
	/** Whether the mode accepts prior audio as generation context. */
	supportsContext: boolean;
}

/** A reference audio blob or an already-uploaded storage key. */
export type TtsReference = Blob | { key: string };

export interface TtsClientOptions {
	auth: SdkAuthentication;
	/**
	 * GraphQL endpoint. Defaults to the production Convbased endpoint
	 * (`https://api.weights.chat/api/v1/graphql`). Override for self-hosted
	 * deployments.
	 */
	graphqlUrl?: string;
	/** Optional logger; defaults to `console` for warn/error only. */
	logger?: Partial<Pick<Console, "debug" | "info" | "warn" | "error">>;
}

export interface SubmitTtsOptions {
	/** COS key of an already-uploaded reference voice (see `uploadReferenceAudio`). */
	referenceKey?: string;
	/** Ordered reference keys; advanced mode accepts up to `maxReferences`. */
	referenceKeys?: readonly string[];
	/** Optional key of a separate emotion reference in expressive mode. */
	emotionReferenceKey?: string;
	/** Text to synthesize. */
	text: string;
	/** Stable product mode. Omit to use the service default. */
	mode?: TtsGenerationMode;
	/** Transcript of the reference voice when the selected mode requires it. */
	promptText?: string;
	/** Optional mode-specific controls. */
	params?: TtsParams;
}

export interface SynthesizeOptions {
	/** Ordered blobs or uploaded keys. Omit for reference-free general mode. */
	references?: readonly TtsReference[];
	/** Legacy single uploaded key alias. */
	referenceKey?: string;
	/** Legacy single `Blob`/`File` alias. */
	referenceAudio?: Blob;
	/** Optional separate emotion reference in expressive mode. */
	emotionReference?: TtsReference;
	/** Text to synthesize. */
	text: string;
	/** Stable product mode. Omit to use the service default. */
	mode?: TtsGenerationMode;
	/** Transcript of the reference voice when the selected mode requires it. */
	promptText?: string;
	/** Optional mode-specific controls. */
	params?: TtsParams;
	/** Poll interval while waiting for the job, in ms. Default 1500. */
	pollIntervalMs?: number;
	/** Give up waiting after this many ms. Default 300_000 (5 min). */
	timeoutMs?: number;
	/** Abort the wait (and cancel the job if still queued). */
	signal?: AbortSignal;
	/** Called on every poll with the latest job snapshot (queue position, status…). */
	onJob?: (job: TtsJob) => void;
}

interface TtsJobWire {
	job_id: string;
	status: TtsJobStatus;
	position: number;
	result: {
		key: string;
		url: string | null;
		token_count: number;
		billing_quantity: number;
		billing_unit: TtsBillingUnit;
		mode: TtsGenerationMode | null;
		audio_duration_sec: number;
		amount_charged: number;
		balance_after: number;
		subtitle: unknown | null;
	} | null;
	error: string | null;
}

interface TtsModeInfoWire {
	mode: TtsGenerationMode;
	billing_unit: TtsBillingUnit;
	clone_requires_transcript: boolean;
	max_references: number;
	supports_context: boolean;
}

const JOB_FIELDS = /* GraphQL */ `
	job_id
	status
	position
	result {
		key
		url
		token_count
		billing_quantity
		billing_unit
		mode
		audio_duration_sec
		amount_charged
		balance_after
		subtitle
	}
	error
`;

export class TtsClient {
	private readonly graphqlUrl: string;
	private readonly auth: SdkAuthSession;
	private readonly tokenRequest: SdkTokenRequest;
	private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;

	constructor(options: TtsClientOptions) {
		if (options && "apiKey" in options) {
			throw new Error(
				"`apiKey` was removed in @convbased/sdk 0.3.0; use `sessionToken` or `tokenProvider`"
			);
		}
		this.graphqlUrl = options.graphqlUrl ?? DEFAULT_GRAPHQL_URL;
		this.auth = sdkAuthSession(options?.auth);
		this.tokenRequest = this.auth.request(["tts"], { type: "tts" });
		const provided = options.logger ?? {};
		this.logger = {
			debug: provided.debug ?? (() => {}),
			info: provided.info ?? (() => {}),
			warn: provided.warn ?? console.warn.bind(console),
			error: provided.error ?? console.error.bind(console),
		};
	}

	/** Upload a reference-voice `Blob`/`File` and resolve its COS key. */
	async uploadReferenceAudio(
		file: Blob,
		opts?: { filename?: string; contentType?: string; signal?: AbortSignal }
	): Promise<{ key: string }> {
		return uploadAudio({
			graphqlUrl: this.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.tokenRequest,
			file,
			filename: opts?.filename,
			contentType: opts?.contentType,
			signal: opts?.signal,
		});
	}

	/** Current character- and second-based billing rules. */
	async getPricing(signal?: AbortSignal): Promise<TtsPricing> {
		const data = await graphqlRequest<{
			ttsPricing: {
				price_per_token: number;
				advanced_price_per_second: number;
				advanced_max_seconds: number;
				min_charge: number;
			};
		}>({
			graphqlUrl: this.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.tokenRequest,
			signal,
			query: /* GraphQL */ `
				query {
					ttsPricing {
						price_per_token
						advanced_price_per_second
						advanced_max_seconds
						min_charge
					}
				}
			`,
		});
		return {
			pricePerToken: data.ttsPricing.price_per_token,
			advancedPricePerSecond:
				data.ttsPricing.advanced_price_per_second,
			advancedMaxSeconds: data.ttsPricing.advanced_max_seconds,
			minCharge: data.ttsPricing.min_charge,
		};
	}

	/** Stable product modes and their public capabilities. */
	async getModes(signal?: AbortSignal): Promise<TtsModeInfo[]> {
		const data = await graphqlRequest<{ ttsModes: TtsModeInfoWire[] }>({
			graphqlUrl: this.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.tokenRequest,
			signal,
			query: /* GraphQL */ `
				query {
					ttsModes {
						mode
						billing_unit
						clone_requires_transcript
						max_references
						supports_context
					}
				}
			`,
		});
		return data.ttsModes.map(toModeInfo);
	}

	/** Enqueue a synthesis job; resolves immediately with the queued job. */
	async submit(opts: SubmitTtsOptions, signal?: AbortSignal): Promise<TtsJob> {
		const data = await graphqlRequest<{ submitTts: TtsJobWire }>({
			graphqlUrl: this.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.tokenRequest,
			signal,
			query: /* GraphQL */ `
				mutation SubmitTts($input: SynthesizeTtsInput!) {
					submitTts(input: $input) {
						${JOB_FIELDS}
					}
				}
			`,
			variables: {
				input: {
					reference_key: opts.referenceKey ?? null,
					reference_keys: opts.referenceKeys
						? [...opts.referenceKeys]
						: null,
					emo_reference_key: opts.emotionReferenceKey ?? null,
					text: opts.text,
					mode: opts.mode ?? null,
					prompt_text: opts.promptText ?? null,
					params: opts.params ?? null,
				},
			},
		});
		return toJob(data.submitTts);
	}

	/** Read the current status/result of a job. */
	async getJob(jobId: string, signal?: AbortSignal): Promise<TtsJob> {
		const data = await graphqlRequest<{ ttsJob: TtsJobWire }>({
			graphqlUrl: this.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.tokenRequest,
			signal,
			query: /* GraphQL */ `
				query TtsJob($jobId: String!) {
					ttsJob(jobId: $jobId) {
						${JOB_FIELDS}
					}
				}
			`,
			variables: { jobId },
		});
		return toJob(data.ttsJob);
	}

	/** Cancel a job. Only effective while it is still `queued`. */
	async cancel(jobId: string, signal?: AbortSignal): Promise<TtsJob> {
		const data = await graphqlRequest<{ cancelTtsJob: TtsJobWire }>({
			graphqlUrl: this.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.tokenRequest,
			signal,
			query: /* GraphQL */ `
				mutation CancelTtsJob($jobId: String!) {
					cancelTtsJob(jobId: $jobId) {
						${JOB_FIELDS}
					}
				}
			`,
			variables: { jobId },
		});
		return toJob(data.cancelTtsJob);
	}

	/**
	 * One-call synthesis: (optionally upload the reference voice,) submit, then
	 * poll until the job finishes. Resolves with the `TtsResult` on success;
	 * rejects if the job fails/cancels, times out, or `signal` aborts.
	 */
	async synthesize(opts: SynthesizeOptions): Promise<TtsResult> {
		const pollIntervalMs = opts.pollIntervalMs ?? 1500;
		const timeoutMs = opts.timeoutMs ?? 300_000;
		const deadline = Date.now() + timeoutMs;

		const references =
			opts.references ??
			(opts.referenceKey
				? [{ key: opts.referenceKey }]
				: opts.referenceAudio
					? [opts.referenceAudio]
					: []);
		const referenceKeys = await Promise.all(
			references.map((reference) =>
				this.resolveReference(reference, opts.signal)
			)
		);
		const emotionReferenceKey = opts.emotionReference
			? await this.resolveReference(opts.emotionReference, opts.signal)
			: undefined;

		const submitted = await this.submit(
			{
				referenceKeys: referenceKeys.length ? referenceKeys : undefined,
				emotionReferenceKey,
				text: opts.text,
				mode: opts.mode,
				promptText: opts.promptText,
				params: opts.params,
			},
			opts.signal
		);
		opts.onJob?.(submitted);

		let job = submitted;
		try {
			while (job.status !== "done") {
				if (opts.signal?.aborted) {
					throw new DOMException("Aborted", "AbortError");
				}
				if (job.status === "failed") {
					throw new Error(job.error || "TTS job failed");
				}
				if (job.status === "cancelled") {
					throw new Error("TTS job was cancelled");
				}
				if (Date.now() > deadline) {
					throw new Error(
						`Timed out waiting for TTS job ${job.jobId} after ${timeoutMs}ms`
					);
				}
				await delay(pollIntervalMs, opts.signal);
				job = await this.getJob(job.jobId, opts.signal);
				opts.onJob?.(job);
			}
		} catch (err) {
			// Best-effort: stop a still-queued job so we don't pay for a result
			// nobody is waiting for.
			if (opts.signal?.aborted) {
				this.cancel(job.jobId).catch(() => {});
			}
			throw err;
		}

		if (!job.result) {
			throw new Error("TTS job is done but carried no result");
		}
		return job.result;
	}

	private async resolveReference(
		reference: TtsReference,
		signal?: AbortSignal
	): Promise<string> {
		if (!(reference instanceof Blob)) return reference.key;
		return (await this.uploadReferenceAudio(reference, { signal })).key;
	}
}

function toJob(wire: TtsJobWire): TtsJob {
	return {
		jobId: wire.job_id,
		status: wire.status,
		position: wire.position,
		result: wire.result
			? {
					key: wire.result.key,
					url: wire.result.url,
					tokenCount: wire.result.token_count,
					billingQuantity: wire.result.billing_quantity,
					billingUnit: wire.result.billing_unit,
					mode: wire.result.mode,
					audioDurationSec: wire.result.audio_duration_sec,
					amountCharged: wire.result.amount_charged,
					balanceAfter: wire.result.balance_after,
					subtitle: wire.result.subtitle,
				}
			: null,
		error: wire.error,
	};
}

function toModeInfo(wire: TtsModeInfoWire): TtsModeInfo {
	return {
		mode: wire.mode,
		billingUnit: wire.billing_unit,
		cloneRequiresTranscript: wire.clone_requires_transcript,
		maxReferences: wire.max_references,
		supportsContext: wire.supports_context,
	};
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
