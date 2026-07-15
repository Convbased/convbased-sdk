// SDP mangling helpers. Mirrors `setAudioParameters` in Convbased-Web — we
// rewrite the Opus `a=fmtp:` line so the offer requests our target bitrate,
// stereo mode, and inband FEC. The signaling node passes the SDP through to
// aiortc largely unchanged, so changes here directly shape the negotiated
// audio.

export interface OpusSdpOptions {
	bitrateKbps: number;
	stereo: boolean;
}

export function applyOpusSdpOptions(sdp: string, opts: OpusSdpOptions): string {
	const lines = sdp.split("\r\n");
	let payloadType: string | null = null;

	for (const line of lines) {
		const match = line.match(/a=rtpmap:(\d+) opus\/48000\/2/);
		if (match) {
			payloadType = match[1]!;
			break;
		}
	}

	if (!payloadType) return sdp;

	let fmtpIndex = lines.findIndex((line) =>
		line.startsWith(`a=fmtp:${payloadType}`)
	);

	if (fmtpIndex === -1) {
		lines.push(`a=fmtp:${payloadType}`);
		fmtpIndex = lines.length - 1;
	}

	let fmtp = lines[fmtpIndex]!;
	fmtp = fmtp.replace(/;\s*stereo=\d/, "");
	fmtp = fmtp.replace(/;\s*maxaveragebitrate=\d+/, "");

	if (opts.stereo) fmtp += "; stereo=1";
	fmtp += `; maxaveragebitrate=${opts.bitrateKbps * 1000}`;
	if (!fmtp.includes("useinbandfec=1")) fmtp += "; useinbandfec=1";

	lines[fmtpIndex] = fmtp;
	return lines.join("\r\n");
}
