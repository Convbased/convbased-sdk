import {
	SdkAuthError,
	sdkAuthError,
	type SdkAuthSession,
	type SdkTokenRequest,
} from "./auth.js";

const TICKET_PATTERN = /^st_[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class SignalingTicketError extends Error {
	constructor(
		readonly code: string,
		readonly retryable = false,
		message = code
	) {
		super(message);
		this.name = "SignalingTicketError";
	}
}

function signalingWebSocketEndpoint(endpoint: string): URL {
	const url = new URL(endpoint);
	if (url.username || url.password) {
		throw new SignalingTicketError("INVALID_SIGNALING_ENDPOINT");
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new SignalingTicketError("INVALID_SIGNALING_ENDPOINT");
	}
	let path = url.pathname.replace(/\/+$/, "");
	if (!/\/ws$/i.test(path)) {
		path = /\/signaling$/i.test(path)
			? `${path}/ws`
			: `${path}/signaling/ws`;
	}
	url.pathname = path;
	url.search = "";
	url.hash = "";
	return url;
}

export function signalingTicketUrl(endpoint: string): string {
	const url = signalingWebSocketEndpoint(endpoint);
	if (url.protocol === "wss:") {
		url.protocol = "https:";
	} else {
		if (!LOOPBACK_HOSTS.has(url.hostname)) {
			throw new SignalingTicketError("INSECURE_SIGNALING_ENDPOINT");
		}
		url.protocol = "http:";
	}
	url.pathname = url.pathname.replace(/\/ws$/i, "/ticket");
	return url.toString();
}

export function signalingWebSocketUrl(
	endpoint: string,
	ticket: string
): string {
	if (!TICKET_PATTERN.test(ticket)) {
		throw new SignalingTicketError("INVALID_SIGNALING_TICKET");
	}
	const url = signalingWebSocketEndpoint(endpoint);
	url.searchParams.set("ticket", ticket);
	return url.toString();
}

function validateRequest(request: SdkTokenRequest): void {
	if (
		request.resource.type !== "vc_model" ||
		request.scopes.length === 0 ||
		request.scopes.some(
			(scope) => scope !== "realtime" && scope !== "file_inference"
		)
	) {
		throw new SdkAuthError("AUTH_SCOPE_FORBIDDEN");
	}
}

function validatedTicket(value: unknown, request: SdkTokenRequest): string {
	if (request.resource.type !== "vc_model") {
		throw new SdkAuthError("AUTH_RESOURCE_FORBIDDEN");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SignalingTicketError("INVALID_SIGNALING_TICKET_RESPONSE");
	}
	const response = value as Record<string, unknown>;
	const scopes = Array.isArray(response.scopes) ? response.scopes : null;
	const resource =
		response.resource &&
		typeof response.resource === "object" &&
		!Array.isArray(response.resource)
			? (response.resource as Record<string, unknown>)
			: null;
	const expiresAt =
		typeof response.expires_at === "string"
			? Date.parse(response.expires_at)
			: Number.NaN;
	if (
		response.token_type !== "SignalingTicket" ||
		typeof response.ticket !== "string" ||
		!TICKET_PATTERN.test(response.ticket) ||
		response.client_id !== request.clientId ||
		!scopes ||
		scopes.length !== request.scopes.length ||
		!request.scopes.every((scope, index) => scopes[index] === scope) ||
		resource?.type !== "vc_model" ||
		resource.id !== request.resource.id ||
		typeof response.expires_in !== "number" ||
		response.expires_in <= 0 ||
		response.expires_in > 60 ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= Date.now()
	) {
		throw new SignalingTicketError("INVALID_SIGNALING_TICKET_RESPONSE");
	}
	return response.ticket;
}

async function responseBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

export async function issueSignalingTicket(args: {
	signalingUrl: string;
	auth: SdkAuthSession;
	tokenRequest: SdkTokenRequest;
	signal?: AbortSignal;
}): Promise<string> {
	validateRequest(args.tokenRequest);
	let refreshed = false;
	for (;;) {
		const accessToken = await args.auth.accessToken(
			args.tokenRequest,
			refreshed
		);
		const response = await fetch(signalingTicketUrl(args.signalingUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({
				client_id: args.tokenRequest.clientId,
				scopes: args.tokenRequest.scopes,
				resource: args.tokenRequest.resource,
			}),
			signal: args.signal,
		});
		const body = await responseBody(response);
		if (response.ok) return validatedTicket(body, args.tokenRequest);

		const failure =
			body && typeof body === "object" && !Array.isArray(body)
				? (body as Record<string, unknown>)
				: null;
		const code = failure?.code;
		if (
			response.status === 401 &&
			args.auth.canRefresh &&
			!refreshed
		) {
			args.auth.invalidate(args.tokenRequest, accessToken);
			refreshed = true;
			continue;
		}
		const authFailure = sdkAuthError(code);
		if (authFailure) throw authFailure;
		throw new SignalingTicketError(
			typeof code === "string" ? code : `HTTP_${response.status}`,
			failure?.retryable === true
		);
	}
}
