import type { RunningSubagent } from "../types.ts";

/** Runtime-owned work: running children plus reports awaiting a settled continuation. */
class OutstandingWork {
	private pending = new Set<string>();
	private consumed = new Set<string>();
	private listener?: () => void;
	private revision = 0;
	private changed(): void { this.revision += 1; this.listener?.(); }
	/** Registry changes, including resume/adoption and clear, share one notification boundary. */
	readonly running = new RunningWorkMap(() => this.changed());

	snapshot(): Readonly<{ revision: number; runningChildIds: string[]; pendingResultIds: string[] }> {
		return {
			revision: this.revision,
			runningChildIds: [...this.running.values()].filter((child) => !child.verifiedRunCancelDenied).map((child) => child.id).sort(),
			pendingResultIds: [...this.pending].filter((id) => !this.consumed.has(id)).sort(),
		};
	}

	/** Subscribe for the lifetime of the owning session. */
	subscribe(listener: () => void): () => void {
		this.listener = listener;
		return () => { if (this.listener === listener) this.listener = undefined; };
	}

	/** Count each logical delegation once; foreign verified-run observers own no work. */
	get count(): number {
		const ids = new Set(this.pending);
		for (const running of this.running.values()) {
			if (!running.verifiedRunCancelDenied) ids.add(running.id);
		}
		return ids.size;
	}

	delivery(id: string, send: () => void): void {
		this.pending.add(id);
		this.consumed.delete(id);
		this.changed();
		try { send(); } catch (error) {
			this.pending.delete(id);
			this.consumed.delete(id);
			this.changed();
			throw error;
		}
	}

	/** Mark reports present at the model-context boundary, without releasing their leases yet. */
	consume(messages: readonly unknown[]): void {
		for (const message of messages) {
			if (!message || typeof message !== "object" || !("role" in message) || message.role !== "custom") continue;
			if (!("customType" in message) || !["subagent_result", "subagent_ping"].includes(String(message.customType))) continue;
			if (!("details" in message) || !message.details || typeof message.details !== "object") continue;
			if ("id" in message.details && typeof message.details.id === "string" && this.pending.has(message.details.id)) {
				if (!this.consumed.has(message.details.id)) {
					this.consumed.add(message.details.id);
					this.changed();
				}
			}
		}
	}

	/** Release only deliveries consumed by the just-settled parent continuation. */
	settle(): void {
		for (const id of this.consumed) this.pending.delete(id);
		this.consumed.clear();
		this.changed();
	}

	/** Discard session-scoped delivery bookkeeping at shutdown. */
	reset(): void {
		this.pending.clear();
		this.consumed.clear();
		this.changed();
	}
}

class RunningWorkMap extends Map<string, RunningSubagent> {
	private changed: () => void;
	constructor(changed: () => void) { super(); this.changed = changed; }
	override set(id: string, running: RunningSubagent): this {
		super.set(id, running);
		this.changed();
		return this;
	}
	override delete(id: string): boolean {
		const removed = super.delete(id);
		if (removed) this.changed();
		return removed;
	}
	override clear(): void {
		super.clear();
		this.changed();
	}
}

/** The same module-owned registry is shared by every launch, watcher and resume path. */
export const outstandingWork = new OutstandingWork();
