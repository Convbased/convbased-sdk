import {
	SdkAuthError,
	sdkAuthError,
	sdkAuthSession,
	type SdkAuthOptions,
	type SdkAuthSession,
	type SdkTokenRequest,
} from "./auth.js";

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
	extensions?: { code?: unknown };
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
		});

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
			throw new Error(`GraphQL request failed: HTTP ${res.status}`);
		}

		const json = (await res.json()) as {
			data?: T;
			errors?: GraphQLErrorPayload[];
		};
		if (json.errors?.length) {
			const coded = json.errors.find((error) => error.extensions?.code);
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
			throw new Error(json.errors.map((error) => error.message).join("; "));
		}
		if (json.data === undefined || json.data === null) {
			throw new Error("GraphQL response contained no data");
		}
		return json.data;
	}
}
