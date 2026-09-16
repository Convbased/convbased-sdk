// Text-to-speech client for the Convbased IndexTTS2 service. This path is pure
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

/** Optional emotion / sampling controls forwarded verbatim to IndexTTS2. */
export interface TtsParams {
	emo_alpha?: number;
	emo_vector?: number[];
	use_emo_text?: boolean;
	emo_text?: string;
	temperature?: number;
	top_p?: number;
	top_k?: number;
}

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
	/** Duration of the synthesized audio, in seconds. */
	audioDurationSec: number;
	/** Amount deducted from the wallet for this synthesis. */
	amountCharged: number;
	/** Wallet balance after the deduction. */
	balanceAfter: number;
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
	/** Price charged per input-text token. */
	pricePerToken: number;
	/** Minimum charge applied to any single synthesis. */
	minCharge: number;
}

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
	referenceKey: string;
	/** Text to synthesize. */
	text: string;
	/** Optional emotion / sampling controls. */
	params?: TtsParams;
}

export interface SynthesizeOptions {
	/** COS key of an already-uploaded reference voice. Provide this or `referenceAudio`. */
	referenceKey?: string;
	/** A reference-voice `Blob`/`File` to upload first. Provide this or `referenceKey`. */
	referenceAudio?: Blob;
	/** Text to synthesize. */
	text: string;
	/** Optional emotion / sampling controls. */
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
		audio_duration_sec: number;
		amount_charged: number;
		balance_after: number;
	} | null;
	error: string | null;
}

const JOB_FIELDS = /* GraphQL */ `
	job_id
	status
	position
	result {
		key
		url
		token_count
		audio_duration_sec
		amount_charged
		balance_after
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

	/** Current billing rule: `cost = max(tokens * pricePerToken, minCharge)`. */
	async getPricing(signal?: AbortSignal): Promise<TtsPricing> {
		const data = await graphqlRequest<{
			ttsPricing: { price_per_token: number; min_charge: number };
		}>({
			graphqlUrl: this.graphqlUrl,
			auth: this.auth,
			tokenRequest: this.tokenRequest,
			signal,
			query: /* GraphQL */ `
				query {
					ttsPricing {
						price_per_token
						min_charge
					}
				}
			`,
		});
		return {
			pricePerToken: data.ttsPricing.price_per_token,
			minCharge: data.ttsPricing.min_charge,
		};
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
					reference_key: opts.referenceKey,
					text: opts.text,
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
		if (!opts.referenceKey && !opts.referenceAudio) {
			throw new Error(
				"synthesize() requires either `referenceKey` or `referenceAudio`"
			);
		}
		const pollIntervalMs = opts.pollIntervalMs ?? 1500;
		const timeoutMs = opts.timeoutMs ?? 300_000;
		const deadline = Date.now() + timeoutMs;

		const referenceKey =
			opts.referenceKey ??
			(await this.uploadReferenceAudio(opts.referenceAudio!, {
				signal: opts.signal,
			})).key;

		const submitted = await this.submit(
			{ referenceKey, text: opts.text, params: opts.params },
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
					audioDurationSec: wire.result.audio_duration_sec,
					amountCharged: wire.result.amount_charged,
					balanceAfter: wire.result.balance_after,
				}
			: null,
		error: wire.error,
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
