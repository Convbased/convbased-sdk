// Only permanent credential failures should stop systemd retries. Network and
// session failures may recover, so they keep the normal non-zero exit path.
export function isCredentialFailure(error) {
	if (
		error &&
		typeof error === "object" &&
		typeof error.code === "string" &&
		/^AUTH_(?:AUDIENCE_MISMATCH|EXPIRED|INVALID_CREDENTIAL|REQUIRED|RESOURCE_FORBIDDEN|REVOKED|SCOPE_FORBIDDEN)$/.test(error.code)
	) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /(?:^|\b)(?:unauthori[sz]ed|forbidden)(?:\b|$)|\b(?:401|403)\b|(?:api[\s_-]*key|credential).*(?:invalid|expired|revoked|missing)/i.test(message);
}
