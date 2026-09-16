// Minimal TS usage sketch — live voice change. Drop this into a Vite / Vue /
// React app; it depends only on `@convbased/sdk` and the browser's WebRTC stack.
//
// Build the SDK first (`npm run build` at the repo root), then in your own
// project:
//
//   import { runDemo } from "./main";
//   document.getElementById("start")!.addEventListener("click", async () => {
//     const session = await runDemo({
//       auth: {
//         clientId: "example.browser",
//         tokenProvider: async (request) => {
//           const response = await fetch("/api/convbased/sdk-token", {
//             method: "POST",
//             headers: { "content-type": "application/json" },
//             body: JSON.stringify(request),
//           });
//           if (!response.ok) throw new Error("token provider failed");
//           return (await response.json()).access_token;
//         },
//       },
//       modelId: "model_xxx",
//       audioEl: document.querySelector("audio")!,
//     });
//     document.getElementById("stop")!.addEventListener("click", () => session.stop());
//   });

import {
	Convbased,
	type SdkAuthOptions,
	type VoiceSession,
} from "@convbased/sdk";

export interface DemoOptions {
	auth: SdkAuthOptions;
	modelId: string;
	audioEl: HTMLAudioElement;
}

export async function runDemo(opts: DemoOptions): Promise<VoiceSession> {
	// One call: capture the mic, negotiate, and start streaming the converted
	// voice into `output`. The SDK wires the audio element and plays it for us.
	const session = await Convbased.startVoiceChange({
		auth: opts.auth,
		modelId: opts.modelId,
		output: opts.audioEl,
		preferences: { pitch: 0, rms_mix_rate: 0.25, f0_autotune: false },
		onStatus: (status) => console.log(`[convbased] ${status}`),
		onError: (err) => console.error("[convbased] error:", err),
	});

	// Adjust pitch live; `session.stop()` ends the session and releases the mic.
	session.setPitch(2);
	return session;
}
