# Convbased SDK

Public source for the shipped Convbased browser SDK and the verified Raspberry Pi 4 Bluetooth voice-conversion integration.

This repository contains client code only. It does not include backend services, model serving, billing, production deployment, or private infrastructure.

## Included

| Path | Product |
| --- | --- |
| [`packages/sdk-js`](packages/sdk-js/) | Browser SDK published as `@convbased/sdk`. |
| [`integrations/raspberry-pi`](integrations/raspberry-pi/) | Raspberry Pi 4 Bluetooth HFP reference integration. |
| [`examples`](examples/) | Browser and framework-free TypeScript examples. |

Unfinished SDKs, internal protocol documents, unverified hardware modes, private history, and development branches are excluded from this public snapshot.

## Browser SDK

```bash
npm install @convbased/sdk
```

```ts
import { Convbased } from "@convbased/sdk";

const session = await Convbased.startVoiceChange({
	apiKey: "your_api_key",
	modelId: "model_xxx",
	output: document.querySelector("audio")!,
});

await session.stop();
```

See [`packages/sdk-js/README.md`](packages/sdk-js/README.md) for real-time voice conversion, file conversion, and text-to-speech.

## Raspberry Pi

The reference path turns a Pi 4 into an HFP headset named **Convbased Mic**. A USB headset provides local capture and playback; the far end of a phone call hears the converted voice.

Start with [`integrations/raspberry-pi/README.md`](integrations/raspberry-pi/README.md). The verified platform is Debian 13 arm64 with Node.js 20, BlueZ, PipeWire, WirePlumber, and a USB headset.

## Checks

```bash
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run check --workspace convbased-raspberry-pi
git diff --check
```

On Linux or a Raspberry Pi:

```bash
./integrations/raspberry-pi/bluetooth-mic/check.sh
```

## Documentation

- [Developer documentation](https://docs.weights.chat/)
- [Raspberry Pi reproduction guide](https://docs.weights.chat/device/)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
