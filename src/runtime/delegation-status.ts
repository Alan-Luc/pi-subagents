import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { outstandingWork } from "./outstanding-work.ts";
import { completedSubagentResults } from "./state.ts";
import { DELEGATION_RESULT_REQUEST, DELEGATION_RESULT_RESPONSE, isPublicationBindingCurrent, isRecord, publicationResultRevision, resetPublicationBindings } from "./finalized-result.ts";

export const DELEGATION_STATUS_REQUEST = "workflow:delegation-status:request:v1";
export const DELEGATION_STATUS_RESPONSE = "workflow:delegation-status:response:v1";

/** Read the same registry used by launches and delivery, never widget or task text. */
export function registerDelegationStatus(pi: ExtensionAPI): void {
	let sessionId: string | undefined;
	let generation = randomUUID();
	pi.on("session_start", (_event, ctx) => {
		resetPublicationBindings();
		sessionId = ctx.sessionManager.getSessionId();
		generation = randomUUID();
	});
	pi.on("session_shutdown", () => { sessionId = undefined; resetPublicationBindings(); });
	pi.events.on(DELEGATION_RESULT_REQUEST, (value) => {
		if (!sessionId || !isRecord(value) || Object.keys(value).length !== 5 || value.version !== 1
			|| typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 128 || value.sessionId !== sessionId
			|| typeof value.childId !== "string" || !value.childId || typeof value.incarnationId !== "string" || !value.incarnationId) return;
		const correlation = { ...value, generation, revision: outstandingWork.snapshot().revision + publicationResultRevision() };
		const running = outstandingWork.running.get(value.childId);
		if (running) {
			pi.events.emit(DELEGATION_RESULT_RESPONSE, { ...correlation, state: "running" });
			return;
		}
		const completed = completedSubagentResults.get(value.childId);
		const binding = completed?.launchBinding;
		if (!completed) {
			pi.events.emit(DELEGATION_RESULT_RESPONSE, { ...correlation, state: "missing" });
		} else if (!binding || !isPublicationBindingCurrent(binding) || binding.parentSessionId !== sessionId
			|| binding.incarnationId !== value.incarnationId || completed.status !== "completed"
			|| !completed.finalizedResultEnvelope || !completed.finalizedResultRef) {
			pi.events.emit(DELEGATION_RESULT_RESPONSE, { ...correlation, state: "unavailable", reason: "No current finalized result for this invocation." });
		} else {
			pi.events.emit(DELEGATION_RESULT_RESPONSE, { ...correlation, state: "completed", launchBinding: binding,
				status: completed.status, envelope: completed.finalizedResultEnvelope, ref: completed.finalizedResultRef });
		}
	});
	pi.events.on(DELEGATION_STATUS_REQUEST, (value) => {
		if (!sessionId || !value || typeof value !== "object" || Array.isArray(value)
			|| Object.keys(value).length !== 3 || !("version" in value) || value.version !== 1
			|| !("requestId" in value) || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 128
			|| !("sessionId" in value) || value.sessionId !== sessionId) return;
		pi.events.emit(DELEGATION_STATUS_RESPONSE, {
			version: 1,
			requestId: value.requestId,
			sessionId,
			generation,
			...outstandingWork.snapshot(),
		});
	});
}
