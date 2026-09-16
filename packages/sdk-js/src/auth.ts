export const SDK_SCOPES = ["realtime", "file_inference", "tts"] as const;

export type SdkScope = (typeof SDK_SCOPES)[number];
export type SdkResource =
	| { type: "vc_model"; id: string }
	| { type: "tts" };

export interface SdkTokenRequest {
	clientId: string;
	scopes: readonly SdkScope[];
	resource: SdkResource;
}

export type SdkTokenProvider = (
	request: SdkTokenRequest
) => Promise<string>;

export type SdkAuthOptions = {
	clientId: string;
} & (
	| { sessionToken: string; tokenProvider?: never }
	| { sessionToken?: never; tokenProvider: SdkTokenProvider }
);

export type SdkAuthentication = SdkAuthOptions | SdkAuthSession;

export type SdkAuthErrorCode =
	| "AUTH_AUDIENCE_MISMATCH"
	| "AUTH_EXPIRED"
	| "AUTH_INVALID_CREDENTIAL"
	| "AUTH_REQUIRED"
	| "AUTH_RESOURCE_FORBIDDEN"
	| "AUTH_REVOKED"
	| "AUTH_SCOPE_FORBIDDEN"
	| "TOKEN_PROVIDER_FAILED";

export class SdkAuthError extends Error {
	constructor(
		readonly code: SdkAuthErrorCode,
		message: string = code
	) {
		super(message);
		this.name = "SdkAuthError";
	}
}

interface ParsedToken {
	value: string;
	expiresAtMs: number;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REFRESH_SKEW_MS = 30_000;

function normalizedScopes(scopes: readonly SdkScope[]): SdkScope[] {
	if (!Array.isArray(scopes) || scopes.length === 0) {
		throw new SdkAuthError("AUTH_SCOPE_FORBIDDEN");
	}
	const unique = new Set(scopes);
	if (
		unique.size !== scopes.length ||
		[...unique].some((scope) => !SDK_SCOPES.includes(scope))
	) {
		throw new SdkAuthError("AUTH_SCOPE_FORBIDDEN");
	}
	return SDK_SCOPES.filter((scope) => unique.has(scope));
}

function normalizedResource(resource: SdkResource): SdkResource {
	if (resource?.type === "tts" && Object.keys(resource).length === 1) {
		return { type: "tts" };
	}
	if (
		resource?.type === "vc_model" &&
		MODEL_ID_PATTERN.test(resource.id) &&
		Object.keys(resource).every((key) => key === "type" || key === "id")
	) {
		return { type: "vc_model", id: resource.id };
	}
	throw new SdkAuthError("AUTH_RESOURCE_FORBIDDEN");
}

function normalizeRequest(request: SdkTokenRequest): SdkTokenRequest {
	if (!CLIENT_ID_PATTERN.test(request.clientId)) {
		throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
	}
	const scopes = normalizedScopes(request.scopes);
	const resource = normalizedResource(request.resource);
	if (
		(resource.type === "tts" &&
			(scopes.length !== 1 || scopes[0] !== "tts")) ||
		(resource.type === "vc_model" && scopes.includes("tts"))
	) {
		throw new SdkAuthError("AUTH_SCOPE_FORBIDDEN");
	}
	return Object.freeze({
		clientId: request.clientId,
		scopes: Object.freeze(scopes),
		resource: Object.freeze(resource),
	});
}

function requestKey(request: SdkTokenRequest): string {
	return JSON.stringify(request);
}

function decodePayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((part) => !part)) {
		throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
	}
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const value = JSON.parse(atob(padded)) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error();
		}
		return value as Record<string, unknown>;
	} catch {
		throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
	}
}

function sameResource(left: unknown, right: SdkResource): boolean {
	if (!left || typeof left !== "object" || Array.isArray(left)) return false;
	const value = left as Record<string, unknown>;
	if (right.type === "tts") {
		return value.type === "tts" && Object.keys(value).length === 1;
	}
	return (
		value.type === "vc_model" &&
		value.id === right.id &&
		Object.keys(value).every((key) => key === "type" || key === "id")
	);
}

function parseToken(
	token: string,
	request: SdkTokenRequest,
	nowMs: number
): ParsedToken {
	const value = token?.trim();
	if (!value) throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
	const payload = decodePayload(value);
	if (payload.aud !== "convbased-sdk") {
		throw new SdkAuthError("AUTH_AUDIENCE_MISMATCH");
	}
	if (
		payload.credential_kind !== "browser_sdk_token" ||
		payload.client_id !== request.clientId ||
		typeof payload.exp !== "number" ||
		!Number.isSafeInteger(payload.exp) ||
		typeof payload.scope !== "string"
	) {
		throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
	}
	const expiresAtMs = payload.exp * 1000;
	if (expiresAtMs <= nowMs) throw new SdkAuthError("AUTH_EXPIRED");
	const granted = new Set(payload.scope.trim().split(/\s+/).filter(Boolean));
	if (request.scopes.some((scope) => !granted.has(scope))) {
		throw new SdkAuthError("AUTH_SCOPE_FORBIDDEN");
	}
	if (!sameResource(payload.resource, request.resource)) {
		throw new SdkAuthError("AUTH_RESOURCE_FORBIDDEN");
	}
	return { value, expiresAtMs };
}

export class SdkAuthSession {
	readonly clientId: string;
	private readonly sessionToken?: string;
	private readonly provider?: SdkTokenProvider;
	private readonly cache = new Map<string, ParsedToken>();
	private readonly inFlight = new Map<string, Promise<ParsedToken>>();

	constructor(options: SdkAuthOptions) {
		if (!options || !CLIENT_ID_PATTERN.test(options.clientId)) {
			throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
		}
		const sessionToken = options.sessionToken?.trim();
		if (sessionToken && options.tokenProvider) {
			throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
		}
		if (!sessionToken && typeof options.tokenProvider !== "function") {
			throw new SdkAuthError("AUTH_REQUIRED");
		}
		this.clientId = options.clientId;
		this.sessionToken = sessionToken;
		this.provider = options.tokenProvider;
	}

	get canRefresh(): boolean {
		return Boolean(this.provider);
	}

	request(
		scopes: readonly SdkScope[],
		resource: SdkResource
	): SdkTokenRequest {
		return normalizeRequest({ clientId: this.clientId, scopes, resource });
	}

	async accessToken(
		request: SdkTokenRequest,
		forceRefresh = false
	): Promise<string> {
		const normalized = normalizeRequest(request);
		if (normalized.clientId !== this.clientId) {
			throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
		}
		const key = requestKey(normalized);
		const nowMs = Date.now();
		const cached = this.cache.get(key);
		if (
			!forceRefresh &&
			cached &&
			cached.expiresAtMs >
				nowMs + (this.provider ? REFRESH_SKEW_MS : 0)
		) {
			return cached.value;
		}

		if (!this.provider) {
			const parsed = parseToken(this.sessionToken!, normalized, nowMs);
			this.cache.set(key, parsed);
			return parsed.value;
		}

		const pending = this.inFlight.get(key);
		if (pending) return (await pending).value;
		const promise = (async () => {
			let provided: string;
			try {
				provided = await this.provider!(normalized);
			} catch (error) {
				if (error instanceof SdkAuthError) throw error;
				throw new SdkAuthError("TOKEN_PROVIDER_FAILED");
			}
			const parsed = parseToken(provided, normalized, Date.now());
			this.cache.set(key, parsed);
			return parsed;
		})();
		this.inFlight.set(key, promise);
		try {
			return (await promise).value;
		} finally {
			if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
		}
	}

	invalidate(request: SdkTokenRequest, token?: string): void {
		const key = requestKey(normalizeRequest(request));
		const current = this.cache.get(key);
		if (!token || current?.value === token) this.cache.delete(key);
	}
}

export function sdkAuthSession(
	auth: SdkAuthentication
): SdkAuthSession {
	return auth instanceof SdkAuthSession ? auth : new SdkAuthSession(auth);
}

export function sdkAuthError(code: unknown, message?: string): SdkAuthError | null {
	const known: readonly SdkAuthErrorCode[] = [
		"AUTH_AUDIENCE_MISMATCH",
		"AUTH_EXPIRED",
		"AUTH_INVALID_CREDENTIAL",
		"AUTH_REQUIRED",
		"AUTH_RESOURCE_FORBIDDEN",
		"AUTH_REVOKED",
		"AUTH_SCOPE_FORBIDDEN",
	];
	return typeof code === "string" && known.includes(code as SdkAuthErrorCode)
		? new SdkAuthError(code as SdkAuthErrorCode, message || code)
		: null;
}
