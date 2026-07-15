# @convbased/sdk

Browser SDK for the Convbased voice services. Authenticate with an API key and
reach three capabilities through one call each:

- **Real-time voice change** — capture the microphone and stream the converted
  voice back (`Convbased.startVoiceChange`).
- **File conversion (voice-to-voice)** — convert a whole audio file and get a
  download URL (`Convbased.convertFile`).
- **Text-to-speech** — synthesize speech from text with a reference voice
  (`Convbased.textToSpeech`).

Each helper folds the fixed flow — open a session, wire the events, attach the
audio, tear down — into a single call, so you never touch the WebRTC, signaling,
or GraphQL machinery underneath.

## Install

```bash
bun add @convbased/sdk
# or
npm install @convbased/sdk
```

## Quick start — real-time voice change

```ts
import { Convbased } from "@convbased/sdk";

const session = await Convbased.startVoiceChange({
	apiKey: "your_api_key",
	modelId: "model_xxx",
	output: document.querySelector("audio")!, // converted voice is wired + played for you
	preferences: { pitch: 0, rms_mix_rate: 0.25 },
	onStatus: (status) => console.log(status), // "connecting" → "live" → "ended"
	onError: (err) => console.error(err),
});

// Tune the voice live:
session.setPitch(2);
session.mute();

// End the session and release the mic:
await session.stop();
```

`output` also accepts a callback if you want the raw `MediaStream`:

```ts
await Convbased.startVoiceChange({
	apiKey,
	modelId,
	output: (stream) => myAudioGraph.connect(stream),
});
```

To feed a pre-processed input (noise suppression, pitch-shift workers…), pass an
existing stream as `input`:

```ts
const raw = await navigator.mediaDevices.getUserMedia({ audio: true });
await Convbased.startVoiceChange({ apiKey, modelId, input: await applyEffects(raw) });
```

## File conversion (voice-to-voice)

Convert a whole audio file through the model. The SDK opens a session, runs the
task, and tears it down — you get back a presigned download URL.

```ts
const { url } = await Convbased.convertFile({
	apiKey,
	modelId: "model_xxx",
	file: fileInput.files[0], // a File/Blob
	preferences: { pitch: 2, f0_method: "rmvpe" },
	onProgress: (progress) => console.log(`${(progress * 100).toFixed(0)}%`),
});
console.log("converted audio:", url);
```

## Text-to-speech

Clone a reference voice and synthesize speech from text.

```ts
const result = await Convbased.textToSpeech({
	apiKey,
	voice: referenceFile, // a File/Blob, or `{ key }` for an already-uploaded voice
	text: "This is a synthesized speech sample.",
	params: { temperature: 0.8 },
	onProgress: (status, queuePosition) => console.log(status, queuePosition),
});

const audio = document.querySelector<HTMLAudioElement>("#tts")!;
audio.src = result.url!; // presigned, valid ~1h
```

> **Audio upload limits.** Reference / source audio is validated by **filename
> extension** — one of `mp3`, `wav`, `ogg`, `flac`, `m4a`, `aac` — and a max
> size of **100 MB**. When passing a bare `Blob` (no filename), name it
> `source.wav` (or similar) so the extension check passes.

## CDN (no build step)

A single-file build is hosted on the CDN and exposes everything on
`window.Convbased`:

```html
<script src="https://cdn.weights.chat/sdk/convbased-sdk.global.js"></script>
<script>
	const session = await Convbased.startVoiceChange({ apiKey, modelId, output: audioEl });
</script>
```

See `examples/h5/index.html` for a complete single-page demo, and
`examples/vanilla-ts/` for framework-free TypeScript snippets of all three
capabilities.

## API surface

```ts
import { Convbased } from "@convbased/sdk";
// or import the helpers directly:
import { startVoiceChange, convertFile, textToSpeech } from "@convbased/sdk";
```

- `Convbased.startVoiceChange({ apiKey, modelId, output?, input?, preferences?, onStatus?, onError? })`
  → `VoiceSession` — `{ stream, setPitch, update, mute, unmute, setMuted, stop }`
- `Convbased.convertFile({ apiKey, modelId, file, preferences?, onProgress?, signal?, timeoutMs? })`
  → `{ url, key? }`
- `Convbased.textToSpeech({ apiKey, voice, text, params?, onProgress?, signal?, timeoutMs? })`
  → `{ url, audioDurationSec, tokenCount, amountCharged, balanceAfter }`

## Advanced — lower-level clients

The façade is enough for normal use. Reach for `ConvbasedClient` / `TtsClient`
only when you need the raw event stream or a self-hosted endpoint. These expose
the full signaling protocol
(`connect`, `updateConfig`, `startTask`/`stopTask`, the `track` / `taskAck` /
`taskProgress` / `taskFinished` events, `getStats`, etc.) and the GraphQL TTS job
lifecycle (`submit`, `getJob`, `cancel`, `getPricing`). They are exported from
the same package entry point.

## Notes

- The SDK is **browser-only**. WebRTC in pure Node needs `wrtc` / `aiortc`,
  which are out of scope here.
- One session = one connection. Call `startVoiceChange` again for a new session.
- The server rejects upfront if the wallet is empty, so a thrown error during
  `startVoiceChange` may indicate insufficient balance — check `error.message`.
