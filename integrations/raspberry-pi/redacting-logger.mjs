const SENSITIVE_QUERY_VALUE = /([?&](?:api_key|token|ticket)=)[^&\s]+/gi;

export function redactLogValue(value) {
	return typeof value === "string"
		? value.replace(SENSITIVE_QUERY_VALUE, "$1<redacted>")
		: value;
}

export function createRedactingLogger(sink = console) {
	const write = (level) => (...args) => sink[level](...args.map(redactLogValue));
	return {
		debug: write("debug"),
		info: write("info"),
		warn: write("warn"),
		error: write("error"),
	};
}
