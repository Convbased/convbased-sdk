// Shared GraphQL transport for the Convbased service.

export interface GraphQLAuth {
	apiKey: string;
}

export interface GraphQLRequestArgs<V> extends GraphQLAuth {
	graphqlUrl: string;
	query: string;
	variables?: V;
	signal?: AbortSignal;
}

/**
 * Issue a single GraphQL operation and return `data`. Throws on HTTP failure
 * or when the response carries a non-empty `errors` array — the thrown
 * `Error.message` is the first server-reported message (often an i18n key the
 * caller can localize).
 */
export async function graphqlRequest<T, V = Record<string, unknown>>(
	args: GraphQLRequestArgs<V>
): Promise<T> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	const apiKey = args.apiKey?.trim();
	if (!apiKey) throw new Error("GraphQL request requires `apiKey`");
	headers["x-api-key"] = apiKey;

	const res = await fetch(args.graphqlUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: args.query, variables: args.variables }),
		signal: args.signal,
	});

	if (!res.ok) {
		throw new Error(
			`GraphQL request failed: HTTP ${res.status} ${res.statusText}`
		);
	}

	const json = (await res.json()) as {
		data?: T;
		errors?: Array<{ message: string }>;
	};
	if (json.errors?.length) {
		throw new Error(json.errors.map((e) => e.message).join("; "));
	}
	if (json.data === undefined || json.data === null) {
		throw new Error("GraphQL response contained no data");
	}
	return json.data;
}
