// Production endpoints baked into the SDK. These mirror Convbased-Web's
// `.env` (VITE_WS_ENDPOINT / VITE_API_BASE_URL) and are considered stable —
// they're consumed by every Convbased client today. Override only for
// self-hosted deployments or local development.
export const DEFAULT_SIGNALING_URL =
	"wss://api.weights.chat/api/signaling/ws";
export const DEFAULT_GRAPHQL_URL =
	"https://api.weights.chat/api/v1/graphql";
