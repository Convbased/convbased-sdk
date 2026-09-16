// High-level façade — the recommended entry point. One call per capability,
// with all WebRTC / signaling / GraphQL plumbing kept internal.
export {
	Convbased,
	startVoiceChange,
	convertFile,
	textToSpeech,
	type StartVoiceChangeOptions,
	type VoiceSession,
	type VoiceStatus,
	type VoiceOutput,
	type VoicePreferences,
	type ConvertFileOptions,
	type ConvertedFile,
	type TextToSpeechOptions,
} from "./convbased.js";

// Lower-level clients — reach for these when you need the raw event stream or
// self-hosted endpoints.
export {
	ConvbasedClient,
	type TaskAckEvent,
	type TaskProgressEvent,
	type TaskFinishedEvent,
	type StartTaskOptions,
	type RunFileInferenceOptions,
} from "./client.js";
export {
	TtsClient,
	type TtsClientOptions,
	type TtsParams,
	type TtsJob,
	type TtsJobStatus,
	type TtsResult,
	type TtsPricing,
	type SubmitTtsOptions,
	type SynthesizeOptions,
} from "./tts.js";
export {
	uploadAudio,
	requestAudioUpload,
	putToPresigned,
	type PresignedUpload,
	type HeaderKV,
} from "./upload.js";
export { graphqlRequest, type GraphQLAuth } from "./graphql.js";
export {
	SdkAuthError,
	SdkAuthSession,
	type SdkAuthErrorCode,
	type SdkAuthentication,
	type SdkAuthOptions,
	type SdkResource,
	type SdkScope,
	type SdkTokenProvider,
	type SdkTokenRequest,
} from "./auth.js";
export { applyOpusSdpOptions } from "./sdp.js";
export {
	fetchRTCServers,
	DEFAULT_STUN_SERVERS,
} from "./rtcServers.js";
export {
	DEFAULT_SIGNALING_URL,
	DEFAULT_GRAPHQL_URL,
} from "./endpoints.js";
export {
	SignalingTicketError,
	issueSignalingTicket,
	signalingTicketUrl,
	signalingWebSocketUrl,
} from "./signalingTicket.js";
export {
	RTCStatusCode,
	type ConnectOptions,
	type ConnectionState,
	type ConnectionStats,
	type ConvbasedClientOptions,
	type FileInferencePreferences,
	type IncomingMessage,
	type OutgoingMessage,
	type RealtimePerformanceStats,
	type RealtimeProcessingLatencyStats,
	type RTCPreferences,
	type RTCServersConfig,
	type ServerMessageEvent,
	type TaskStatus,
} from "./types.js";
