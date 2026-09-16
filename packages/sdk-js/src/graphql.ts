import {
	SdkAuthError,
	sdkAuthError,
	sdkAuthSession,
	type SdkAuthOptions,
	type SdkAuthSession,
	type SdkTokenRequest,
} from "./auth.js";
import { SdkServiceError } from "./errors.js";

export interface GraphQLAuth {
	auth: SdkAuthOptions | SdkAuthSession;
	tokenRequest: SdkTokenRequest;
}

export interface GraphQLRequestArgs<V> extends GraphQLAuth {
	graphqlUrl: string;
	query: string;
	variables?: V;
	signal?: AbortSignal;
}

interface GraphQLErrorPayload {
	message: string;
	extensions?: Record<string, unknown>;
}

function retryableCredentialError(code: unknown): boolean {
	return (
		code === "AUTH_EXPIRED" ||
		code === "AUTH_INVALID_CREDENTIAL" ||
		code === "AUTH_REVOKED"
	);
}

export async function graphqlRequest<T, V = Record<string, unknown>>(
	args: GraphQLRequestArgs<V>
): Promise<T> {
	const auth = sdkAuthSession(args.auth);
	let refreshed = false;
	for (;;) {
		const accessToken = await auth.accessToken(
			args.tokenRequest,
			refreshed
		);
		const res = await fetch(args.graphqlUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ query: args.query, variables: args.variables }),
			signal: args.signal,
		}).catch((error: unknown) => {
			if (error instanceof TypeError)
				throw new SdkServiceError("GraphQL network request failed", {
					code: "NETWORK_ERROR", retryable: true,
				});
			throw error;
		});
		const json = await res.json().catch((error: unknown) => {
			if (error instanceof Error && error.name === "AbortError") throw error;
			return null;
		}) as {
			data?: T;
			errors?: GraphQLErrorPayload[];
		} | null;
		const errors = Array.isArray(json?.errors) ? json.errors : [];
		// A business refusal must not replay the operation via credential refresh.
		const business = errors.find((error) => error.extensions?.code &&
			!sdkAuthError(error.extensions.code));
		if (business) throw new SdkServiceError(business.message, business.extensions);

		if (!res.ok) {
			if (res.status === 401 && auth.canRefresh && !refreshed) {
				auth.invalidate(args.tokenRequest, accessToken);
				refreshed = true;
				continue;
			}
			if (res.status === 401) {
				throw new SdkAuthError("AUTH_INVALID_CREDENTIAL");
			}
			if (res.status === 403) {
				throw new SdkAuthError("AUTH_SCOPE_FORBIDDEN");
			}
			throw new SdkServiceError(`GraphQL request failed: HTTP ${res.status}`, {
				code: `HTTP_${res.status}`, retryable: res.status >= 500 || res.status === 429,
			});
		}

		if (errors.length) {
			const coded = errors.find((error) => error.extensions?.code);
			const code = coded?.extensions?.code;
			if (
				retryableCredentialError(code) &&
				auth.canRefresh &&
				!refreshed
			) {
				auth.invalidate(args.tokenRequest, accessToken);
				refreshed = true;
				continue;
			}
			const authFailure = sdkAuthError(code, coded?.message);
			if (authFailure) throw authFailure;
			throw new SdkServiceError(errors.map((error) => error.message).join("; "), coded?.extensions);
		}
		if (json?.data === undefined || json.data === null) {
			throw new SdkServiceError("GraphQL response contained no data", { code: "INVALID_GRAPHQL_RESPONSE" });
		}
		return json.data;
	}
}
