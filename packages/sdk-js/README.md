# @convbased/sdk

Browser SDK for real-time voice conversion, file conversion, and text-to-speech.

```bash
npm install @convbased/sdk
```

## Authentication

Version 0.3 replaces `apiKey` with `auth`. Your backend issues short-lived SDK tokens bound to the requested client, scopes, and resource. Keep API keys on that backend; never embed them in browser code. The service must support signaling tickets; use 0.2 for legacy servers.

Implement `/api/convbased/sdk-token` on your backend, authenticate the caller, and authorize the requested scopes and resource before issuing a token. The SDK caches tokens and calls `tokenProvider` when a refresh is needed.

```ts
import { Convbased, type SdkAuthentication } from "@convbased/sdk";

const auth: SdkAuthentication = {
	clientId: "example.browser",
	tokenProvider: async (request) => {
		const response = await fetch("/api/convbased/sdk-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		if (!response.ok) throw new Error("Token request failed");
		return (await response.json()).access_token;
	},
};
```

For a non-refreshing session, use `auth: { clientId, sessionToken }` instead.

## Real-time voice conversion

```ts
const session = await Convbased.startVoiceChange({
	auth,
	modelId: "model_xxx",
	output: document.querySelector("audio")!,
	preferences: { pitch: 0, rms_mix_rate: 0.25 },
	onStatus: (status) => console.log(status), // "connecting" → "live" → "ended"
	onError: (error) => console.error(error),
});

session.setPitch(2);
session.mute();
await session.stop(); // Release the microphone and connection.
```

`output` also accepts a callback receiving the converted `MediaStream`. Pass an existing stream as `input` to use preprocessed audio. Each session owns one connection; start a new session after stopping it. Browser media APIs are required.

## File conversion

```ts
const { url } = await Convbased.convertFile({
	auth,
	modelId: "model_xxx",
	file: fileInput.files[0],
	preferences: { pitch: 2, f0_method: "rmvpe" },
	onProgress: (progress) => console.log(progress),
});
```

The result contains a presigned download URL.

## Text-to-speech

```ts
const result = await Convbased.textToSpeech({
	auth,
	voice: referenceFile, // File/Blob or an uploaded { key }.
	text: "This is a synthesized speech sample.",
	params: { temperature: 0.8 },
	onProgress: (status, queuePosition) => console.log(status, queuePosition),
});

document.querySelector<HTMLAudioElement>("#tts")!.src = result.url!;
```

## Audio uploads

Source and reference audio must be at most 100 MB and have a `mp3`, `wav`, `ogg`, `flac`, `m4a`, `aac` filename extension. Wrap an unnamed `Blob` in a `File` with an accepted filename, such as `new File([blob], "source.wav")`.

## Lower-level clients

Use `ConvbasedClient` for session events and custom signaling endpoints, or `TtsClient` for the TTS job lifecycle. Both are exported from the package entry point. API types are in [src/convbased.ts](src/convbased.ts), [src/types.ts](src/types.ts), and [src/tts.ts](src/tts.ts).

See the [H5 example](https://github.com/Convbased/convbased-sdk/blob/main/examples/h5/index.html) and [TypeScript examples](https://github.com/Convbased/convbased-sdk/tree/main/examples/vanilla-ts/).
