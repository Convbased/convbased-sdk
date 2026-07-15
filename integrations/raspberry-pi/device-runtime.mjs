/** A missing profile is a legacy API-key client and remains enabled. */
export function isRealtimeEnabled(profile) {
	return profile?.realtime_enabled !== false;
}

/** Stay profile-only while explicitly stopped; failed reads cannot turn the device on. */
export async function waitForRealtimeEnabled({
	initialProfile,
	readProfile,
	pollMs,
	sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	onWaiting = () => {},
	onEnabled = () => {},
}) {
	if (isRealtimeEnabled(initialProfile)) return initialProfile;
	if (!Number.isFinite(pollMs) || pollMs <= 0) {
		throw new RangeError("pollMs must be positive while realtime is disabled");
	}

	onWaiting();
	for (;;) {
		await sleepFn(pollMs);
		const result = await readProfile();
		if (!result?.ok) continue;
		if (!isRealtimeEnabled(result.profile)) continue;
		onEnabled();
		return result.profile;
	}
}
