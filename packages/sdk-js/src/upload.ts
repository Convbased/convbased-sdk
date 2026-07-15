// Audio upload helpers shared by TTS (reference voice) and file inference
// (source audio). Two steps mirror Convbased-Web: ask the GraphQL service for
// a presigned PUT (`requestAudioUpload`), then PUT the bytes straight to object
// storage. The returned COS `key` is what you hand to `submitTts` /
// `startTask`.

import { graphqlRequest, type GraphQLAuth } from "./graphql.js";

export interface HeaderKV {
	name: string;
	value: string;
}

export interface PresignedUpload {
	/** COS object key — pass this back to the service (e.g. as `reference_key` / `audio_key`). */
	key: string;
	/** Presigned URL to PUT the bytes to. */
	upload_url: string;
	/** HTTP method to use for the upload (always `PUT` today). */
	method: string;
	/** Headers the upload request must include (notably `Content-Type`). */
	headers: HeaderKV[];
	/** Seconds until the presigned URL expires. */
	expires_in: number;
	bucket?: string | null;
	region?: string | null;
	/** CDN base URL for the bucket, when configured. */
	url?: string | null;
}

const REQUEST_AUDIO_UPLOAD = /* GraphQL */ `
	mutation RequestAudioUpload($input: RequestUploadInput!) {
		requestAudioUpload(input: $input) {
			key
			upload_url
			method
			expires_in
			headers {
				name
				value
			}
			bucket
			region
			url
		}
	}
`;

/** Ask the service for a presigned PUT for an audio file. */
export async function requestAudioUpload(
	args: GraphQLAuth & {
		graphqlUrl: string;
		filename: string;
		contentType: string;
		size: number;
		signal?: AbortSignal;
	}
): Promise<PresignedUpload> {
	const data = await graphqlRequest<{ requestAudioUpload: PresignedUpload }>({
		graphqlUrl: args.graphqlUrl,
		apiKey: args.apiKey,
		signal: args.signal,
		query: REQUEST_AUDIO_UPLOAD,
		variables: {
			input: {
				filename: args.filename,
				content_type: args.contentType,
				size: args.size,
			},
		},
	});
	return data.requestAudioUpload;
}

/** PUT raw bytes to a presigned upload target. */
export async function putToPresigned(
	presigned: PresignedUpload,
	body: Blob | ArrayBuffer | ArrayBufferView,
	signal?: AbortSignal
): Promise<void> {
	const headers: Record<string, string> = {};
	for (const h of presigned.headers ?? []) {
		if (h?.name) headers[h.name] = h.value;
	}
	const res = await fetch(presigned.upload_url, {
		method: presigned.method || "PUT",
		headers,
		body: body as BodyInit,
		signal,
	});
	if (!res.ok) {
		throw new Error(
			`Audio upload failed: HTTP ${res.status} ${res.statusText}`
		);
	}
}

/**
 * Upload an audio `Blob`/`File` end-to-end (presign + PUT) and resolve the COS
 * `key`. Filename and content type are taken from the `File` when available;
 * override via `opts` when uploading a bare `Blob`.
 */
export async function uploadAudio(
	args: GraphQLAuth & {
		graphqlUrl: string;
		file: Blob;
		filename?: string;
		contentType?: string;
		signal?: AbortSignal;
	}
): Promise<{ key: string }> {
	const maybeFile = args.file as File;
	const filename = args.filename ?? maybeFile.name ?? "audio.wav";
	const contentType =
		args.contentType ||
		args.file.type ||
		"application/octet-stream";

	const presigned = await requestAudioUpload({
		graphqlUrl: args.graphqlUrl,
		apiKey: args.apiKey,
		signal: args.signal,
		filename,
		contentType,
		size: args.file.size,
	});

	await putToPresigned(presigned, args.file, args.signal);
	return { key: presigned.key };
}
