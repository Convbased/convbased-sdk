// Minimal typed event emitter; we avoid pulling Node's EventEmitter so the
// SDK stays browser-first with no polyfill chain.

export type Listener<T> = (payload: T) => void;

export class TypedEmitter<TEvents extends Record<string, unknown>> {
	private readonly listeners: {
		[K in keyof TEvents]?: Set<Listener<TEvents[K]>>;
	} = {};

	on<K extends keyof TEvents>(event: K, fn: Listener<TEvents[K]>): () => void {
		(this.listeners[event] ??= new Set()).add(fn);
		return () => this.off(event, fn);
	}

	off<K extends keyof TEvents>(event: K, fn: Listener<TEvents[K]>): void {
		this.listeners[event]?.delete(fn);
	}

	emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
		const set = this.listeners[event];
		if (!set) return;
		for (const fn of set) {
			try {
				fn(payload);
			} catch (e) {
				// Listeners shouldn't crash the emitter.
				console.error(`[convbased-sdk] listener for "${String(event)}" threw:`, e);
			}
		}
	}

	removeAllListeners(): void {
		for (const key of Object.keys(this.listeners)) {
			delete this.listeners[key as keyof TEvents];
		}
	}
}
