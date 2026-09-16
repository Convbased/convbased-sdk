import { graphqlRequest, type GraphQLAuth } from "./graphql.js";
import type { RTCServersConfig } from "./types.js";

/**
 * Fetch TURN credentials from the Convbased GraphQL service. The query matches
 * the one used by Convbased-Web's `getRTCServers`. Authentication uses the
 * short-lived bearer token resolved by the SDK authentication session.
 */
export async function fetchRTCServers(
	args: GraphQLAuth & {
		graphqlUrl: string;
		signal?: AbortSignal;
	}
): Promise<RTCServersConfig> {
	const data = await graphqlRequest<{ rtcServers?: RTCServersConfig }>({
		graphqlUrl: args.graphqlUrl,
		auth: args.auth,
		tokenRequest: args.tokenRequest,
		signal: args.signal,
		query: /* GraphQL */ `
			query {
				rtcServers {
					urls
					username
					credential
				}
			}
		`,
	});
	if (!data.rtcServers) {
		throw new Error("rtcServers returned an empty payload");
	}
	return data.rtcServers;
}

export const DEFAULT_STUN_SERVERS: RTCServersConfig[] = [
	{ urls: ["stun:stun.l.google.com:19302"] },
];
