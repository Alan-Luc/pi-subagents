import assert from "node:assert/strict";
import { test } from "node:test";
import { outstandingWork } from "../../src/runtime/outstanding-work.ts";
import { registerDelegationStatus, DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE } from "../../src/runtime/delegation-status.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerOutstandingWorkReporting, type WorkReporter } from "../../src/runtime/work-reporting.ts";
import { deliverCompletedSubagentResult } from "../../src/runtime/result-router.ts";
import { buildCompletedSubagentResult, requestSubagentBatchStop, resetSubagentBatchStopRequest } from "../../src/runtime/state.ts";
import type { RunningSubagent } from "../../src/types.ts";

test("snapshot producer is session-bound, read-only and invalidated on shutdown", () => {
	const listeners = new Map<string, (value: unknown) => void>();
	const lifecycle = new Map<string, (event: never, ctx: ExtensionContext) => void>();
	const replies: unknown[] = [];
	const events = {
		on(channel: string, listener: (value: unknown) => void) { listeners.set(channel, listener); return () => { listeners.delete(channel); }; },
		emit(channel: string, value: unknown) { listeners.get(channel)?.(value); },
	};
	events.on(DELEGATION_STATUS_RESPONSE, (reply) => replies.push(reply));
	registerDelegationStatus({ events, on(name: string, handler: (event: never, ctx: ExtensionContext) => void) { lifecycle.set(name, handler); } } as unknown as ExtensionAPI);
	const request = { version: 1, requestId: "request", sessionId: "parent" };
	events.emit(DELEGATION_STATUS_REQUEST, request);
	assert.equal(replies.length, 0);
	const ctx = { sessionManager: { getSessionId: () => "parent" } } as unknown as ExtensionContext;
	lifecycle.get("session_start")?.({} as never, ctx);
	outstandingWork.reset();
	outstandingWork.delivery("pending", () => {});
	const before = outstandingWork.snapshot();
	events.emit(DELEGATION_STATUS_REQUEST, request);
	assert.equal(replies.length, 1);
	assert.deepEqual(replies[0], { ...request, generation: (replies[0] as { generation: string }).generation, ...before });
	assert.deepEqual(outstandingWork.snapshot(), before, "query cannot consume results");
	for (const malformed of [{ ...request, sessionId: "other" }, { ...request, version: 2 }, { ...request, extra: true }, { ...request, requestId: "" }]) events.emit(DELEGATION_STATUS_REQUEST, malformed);
	assert.equal(replies.length, 1);
	lifecycle.get("session_shutdown")?.({} as never, ctx);
	events.emit(DELEGATION_STATUS_REQUEST, request);
	assert.equal(replies.length, 1);
	outstandingWork.reset();
});

test("unavailable display transport cannot erase a delivery arriving during startup", async () => {
	outstandingWork.reset();
	let finish: ((reporter: WorkReporter | undefined) => void) | undefined;
	const connected = new Promise<WorkReporter | undefined>((resolve) => { finish = resolve; });
	const reporting = registerOutstandingWorkReporting({ on() {} } as unknown as ExtensionAPI, () => connected);
	const starting = reporting.start({} as ExtensionContext);
	try {
		outstandingWork.delivery("startup-result", () => {});
		assert.ok(finish);
		finish(undefined);
		await starting;
		assert.equal(outstandingWork.count, 1, "missing optional display must not delete real work");
	} finally {
		finish?.(undefined);
		await starting;
		await reporting.stop();
	}
});

test("next-turn delivery is not consumption until it reaches model context", () => {
	outstandingWork.reset();
	const unsubscribe = outstandingWork.subscribe(() => {});
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
	delete process.env.PI_SUBAGENT_AUTO_EXIT;
	try {
		const running: RunningSubagent = { id: "queued-result", name: "queued", task: "observe", mode: "background", executionState: "running", deliveryState: "detached", parentClosePolicy: "terminate", async: true, sessionFile: "owned-child.jsonl", startTime: 1 };
		const completed = buildCompletedSubagentResult(running, { name: running.name, task: running.task, summary: "report", exitCode: 0, elapsed: 1 });
		requestSubagentBatchStop();
		let deliveryMode: unknown;
		deliverCompletedSubagentResult({ sendMessage(_message: unknown, options: unknown) { deliveryMode = options; } }, completed, String);
		assert.deepEqual(deliveryMode, { triggerTurn: true, deliverAs: "nextTurn" });
		outstandingWork.settle();
		assert.equal(outstandingWork.count, 1, "queued result is still unread");
		outstandingWork.consume([{ role: "custom", customType: "subagent_result", details: { id: "queued-result" } }]);
		outstandingWork.settle();
		assert.equal(outstandingWork.count, 0);
	} finally {
		if (autoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
		else process.env.PI_SUBAGENT_AUTO_EXIT = autoExit;
		resetSubagentBatchStopRequest();
		unsubscribe();
		outstandingWork.reset();
	}
});

test("snapshot excludes consumed reports while retaining their UI lease until settle", () => {
	outstandingWork.reset();
	try {
		outstandingWork.delivery("read-report", () => {});
		assert.deepEqual(outstandingWork.snapshot().pendingResultIds, ["read-report"]);
		outstandingWork.consume([{ role: "custom", customType: "subagent_result", details: { id: "read-report" } }]);
		assert.deepEqual(outstandingWork.snapshot().pendingResultIds, [], "a result already in model context is not awaiting consumption");
		assert.equal(outstandingWork.count, 1, "keep the UI lease through the continuation");
		outstandingWork.settle();
		assert.equal(outstandingWork.count, 0);
	} finally { outstandingWork.reset(); }
});

test("headless delivery remains outstanding until the parent consumes and settles it", () => {
	outstandingWork.reset();
	outstandingWork.running.clear();
	try {
		let delivered = false;
		outstandingWork.delivery("terminal-child", () => { delivered = true; });
		assert.equal(delivered, true);
		assert.equal(outstandingWork.count, 1, "absence of a widget reporter must not erase unconsumed delivery");
		outstandingWork.settle();
		assert.equal(outstandingWork.count, 1);
		outstandingWork.consume([{ role: "custom", customType: "subagent_result", details: { id: "terminal-child" } }]);
		outstandingWork.settle();
		assert.equal(outstandingWork.count, 0);
	} finally { outstandingWork.reset(); }
});
