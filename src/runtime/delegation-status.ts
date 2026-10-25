import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { outstandingWork } from "./outstanding-work.ts";

export const DELEGATION_STATUS_REQUEST = "workflow:delegation-status:request:v1";
export const DELEGATION_STATUS_RESPONSE = "workflow:delegation-status:response:v1";

/** Read the same registry used by launches and delivery, never widget or task text. */
export function registerDelegationStatus(pi: ExtensionAPI): void {
	let sessionId: string | undefined;
	let generation = randomUUID();
	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		generation = randomUUID();
	});
	pi.on("session_shutdown", () => { sessionId = undefined; });
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
