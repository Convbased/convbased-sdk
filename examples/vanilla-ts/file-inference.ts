// File inference (voice-to-voice) usage sketch. Converts a whole audio file
// through the model and resolves with a presigned download URL. The SDK opens
// the session, runs the task, and tears it down for you.
//
//   import { runFileInferenceDemo } from "./file-inference";
//   runFileInferenceDemo({
//     apiKey: import.meta.env.VITE_CONVBASED_API_KEY,
//     modelId: "model_xxx",
//     sourceFile: fileInput.files![0],
//   }).then((url) => console.log("converted:", url));

import { Convbased } from "@convbased/sdk";

export interface FileInferenceDemoOptions {
	apiKey: string;
	modelId: string;
	sourceFile: Blob; // the audio to convert
}

export async function runFileInferenceDemo(
	opts: FileInferenceDemoOptions,
): Promise<string> {
	const { url } = await Convbased.convertFile({
		apiKey: opts.apiKey,
		modelId: opts.modelId,
		file: opts.sourceFile,
		preferences: { pitch: 0, f0_method: "rmvpe" },
		onProgress: (progress) =>
			console.log(`[file-inference] ${(progress * 100).toFixed(0)}%`),
	});
	console.log("[file-inference] done:", url);
	return url;
}
