import {
	DEFAULT_GRAPHQL_URL,
	SdkAuthError,
	SdkAuthSession,
} from "@convbased/sdk";

const TOKEN_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function graphqlEndpoint(graphqlUrl) {
	const url = new URL(graphqlUrl);
	if (
		url.username ||
		url.password ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
	) {
		throw new TypeError(
			"SDK token endpoint requires HTTPS outside loopback",
		);
	}
	if (!/\/graphql\/?$/.test(url.pathname)) {
		throw new TypeError("GraphQL URL must end in /graphql");
	}
	url.pathname = url.pathname.replace(/\/graphql\/?$/, "/graphql");
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function createSdkAuth({
	apiKey,
	clientId = "convbased-raspberry-pi",
	graphqlUrl = DEFAULT_GRAPHQL_URL,
}) {
	if (!apiKey?.trim()) throw new TypeError("apiKey is required");
	const endpoint = graphqlEndpoint(graphqlUrl);
	return new SdkAuthSession({
		clientId,
		tokenProvider: async (request) => {
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(),
				TOKEN_TIMEOUT_MS,
			);
			try {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": apiKey.trim(),
					},
					body: JSON.stringify({
						query: `
							mutation IssueSdkToken($input: IssueSdkTokenInput!) {
								issueSdkToken(input: $input) {
									access_token
								}
							}
						`,
						variables: {
							input: {
								client_id: request.clientId,
								scopes: request.scopes,
								resource: request.resource,
							},
						},
					}),
					signal: controller.signal,
				});
				const body = await response.json().catch(() => null);
				const accessToken = body?.data?.issueSdkToken?.access_token;
				if (!response.ok || typeof accessToken !== "string") {
					const graphqlCode = body?.errors?.[0]?.extensions?.code;
					const code =
						typeof graphqlCode === "string"
							? graphqlCode
							: response.status === 401
								? "AUTH_INVALID_CREDENTIAL"
								: response.status === 403
									? "AUTH_SCOPE_FORBIDDEN"
									: "TOKEN_PROVIDER_FAILED";
					throw new SdkAuthError(code, code);
				}
				return accessToken;
			} finally {
				clearTimeout(timeout);
			}
		},
	});
}
