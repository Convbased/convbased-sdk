// Read the model and conversion settings bound to this API key. The Pi calls this at
// startup and while connected so web-console changes reach the active device.
//
// Returns `{ model_id, preferences, realtime_enabled } | null`. Null means the key has no profile.
// Transport, HTTP, and GraphQL failures throw a credential-safe error so callers can
// keep local settings without hiding a broken synchronization path.
export async function fetchDeviceProfile({
	graphqlUrl,
	apiKey,
	timeoutMs = 10000,
	fetchFn = fetch,
}) {
	if (!graphqlUrl) throw new TypeError("graphqlUrl is required");
	if (!apiKey) throw new TypeError("apiKey is required");
	const query = "query { myDeviceProfile { model_id preferences realtime_enabled } }";
	let resp;
	try {
		resp = await fetchFn(graphqlUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": apiKey },
			body: JSON.stringify({ query }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		const timeout = cause?.name === "TimeoutError" || cause?.name === "AbortError";
		throw new Error(
			`device profile request failed (${timeout ? "timeout" : "network"})`,
			{ cause },
		);
	}
	if (!resp.ok) throw new Error(`device profile request failed (HTTP ${resp.status})`);

	let payload;
	try {
		payload = await resp.json();
	} catch (cause) {
		throw new Error("device profile response is not valid JSON", { cause });
	}
	if (Array.isArray(payload?.errors) && payload.errors.length) {
		const summary = payload.errors
			.slice(0, 3)
			.map((error) => {
				const code = error?.extensions?.code || "ERROR";
				const field = error?.extensions?.field;
				return field ? `${code} field=${field}` : code;
			})
			.join("; ");
		throw new Error(`device profile query rejected (${summary})`);
	}
	if (!payload?.data || !("myDeviceProfile" in payload.data)) {
		throw new Error("device profile response is missing data");
	}
	const profile = payload.data.myDeviceProfile;
	if (profile === null) return null;
	if (typeof profile !== "object") {
		throw new Error("device profile has an invalid shape");
	}
	return {
		model_id: profile.model_id || null,
		// Older profile payloads had no switch. Preserve their connected behavior.
		realtime_enabled: profile.realtime_enabled !== false,
		preferences:
			profile.preferences && typeof profile.preferences === "object"
				? profile.preferences
				: null,
	};
}
