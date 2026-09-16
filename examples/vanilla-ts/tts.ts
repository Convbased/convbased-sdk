// Text-to-speech usage sketch. Clone a reference voice and synthesize speech
// from text. Pure GraphQL under the hood — no WebSocket, no WebRTC. Wire it to a
// file input + a text field + an <audio> element.
//
//   import { runTtsDemo } from "./tts";
//   document.getElementById("synth")!.addEventListener("click", () =>
//     runTtsDemo({
//       auth,
//       referenceFile: fileInput.files![0],
//       text: textArea.value,
//       audioEl: document.querySelector("audio")!,
//     }),
//   );

import { Convbased, type SdkAuthOptions } from "@convbased/sdk";

export interface TtsDemoOptions {
	auth: SdkAuthOptions;
	referenceFile: Blob; // the voice to clone
	text: string;
	audioEl: HTMLAudioElement;
}

export async function runTtsDemo(opts: TtsDemoOptions): Promise<void> {
	// One call: upload the reference voice, submit, and poll until done.
	const result = await Convbased.textToSpeech({
		auth: opts.auth,
		voice: opts.referenceFile,
		text: opts.text,
		params: { temperature: 0.8 },
		onProgress: (status, queuePosition) =>
			console.log(`[tts] ${status}`, queuePosition ? `queue #${queuePosition}` : ""),
	});

	console.log(
		`[tts] done — ${result.tokenCount} tokens, ${result.audioDurationSec.toFixed(2)}s, ` +
			`charged ${result.amountCharged} (balance ${result.balanceAfter})`,
	);

	opts.audioEl.src = result.url ?? "";
	void opts.audioEl.play();
}
