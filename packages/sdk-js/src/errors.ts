/** Service decisions retain their wire fields; retryable is absent when unspecified. */
export class SdkServiceError extends Error {
	readonly code: string | number;
	readonly meter?: string;
	readonly retryable?: boolean;
	readonly resetAt?: string | null;
	readonly taskId?: string;
	readonly executionStopped?: boolean;

	constructor(message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "SdkServiceError";
		this.code = typeof details.code === "string" || typeof details.code === "number"
			? details.code : "SERVICE_ERROR";
		if (typeof details.meter === "string") this.meter = details.meter;
		if (typeof details.retryable === "boolean") this.retryable = details.retryable;
		if (typeof details.reset_at === "string" || details.reset_at === null)
			this.resetAt = details.reset_at;
		if (typeof details.task_id === "string") this.taskId = details.task_id;
		if (typeof details.execution_stopped === "boolean")
			this.executionStopped = details.execution_stopped;
	}
}
