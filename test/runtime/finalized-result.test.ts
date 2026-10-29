import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
	buildCompletedSubagentResult,
	cacheCompletedSubagentResult,
	completedSubagentResults,
} from "../../src/runtime/state.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { consumeSubagentExitSignal } from "../../src/mux/poll.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import subagentDoneExtension from "../../src/tools/subagent-done.ts";
import { registerDelegationStatus } from "../../src/runtime/delegation-status.ts";
import { outstandingWork } from "../../src/runtime/outstanding-work.ts";
import {
	resumeSubagentSession,
	type ResumeServiceRuntime,
} from "../../src/runtime/resume-service.ts";
import {
	DELEGATION_RESULT_REQUEST,
	DELEGATION_RESULT_RESPONSE,
} from "../../src/runtime/finalized-result.ts";
import {
	captureFinalizedResult,
	envelopeSha256,
	FINALIZED_RESULT_ENTRY,
	FINALIZE_RESULT_REQUEST,
	FINALIZE_RESULT_RESPONSE,
	mintPublicationLaunchBinding,
	requestFinalizedResult,
	revokePublicationBinding,
	resetPublicationBindings,
	type FinalizedResultEnvelope,
	type FinalizedResultRef,
} from "../../src/runtime/finalized-result.ts";

test("unbound completion cannot smuggle a finalized result reference", () => {
	const running: RunningSubagent = {
		id: "child",
		name: "child",
		task: "check",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		sessionFile: "/missing.jsonl",
		startTime: 1,
	};
	const result = {
		name: "child",
		task: "check",
		summary: "ok",
		exitCode: 0,
		elapsed: 1,
		finalizedResultRef: {
			state: "finalized",
			entryId: "forged",
			envelopeSha256: "0".repeat(64),
			childSessionId: "child",
			rootGeneration: "root",
			incarnationId: "old",
		},
	};
	const completed = buildCompletedSubagentResult(
		running,
		result as SubagentResult,
	);
	assert.equal(
		"finalizedResultRef" in completed,
		false,
		"a sidecar alone cannot confer proof authority",
	);
});

test("binding is unavailable without a persistent normal launch and actual parent tool/leaf identity", () => {
	const sessionManager = {
		getSessionId: () => "parent",
		getLeafId: () => "leaf",
	};
	assert.equal(
		mintPublicationLaunchBinding(
			{ sessionManager, launchToolCallId: "call" },
			"child",
			"/missing/child.jsonl",
			0,
			true,
		),
		undefined,
	);
	assert.equal(
		mintPublicationLaunchBinding(
			{ sessionManager },
			"child",
			"/missing/child.jsonl",
			0,
			false,
		),
		undefined,
	);
	assert.equal(
		mintPublicationLaunchBinding(
			{
				sessionManager: { getSessionId: () => "parent" },
				launchToolCallId: "call",
			},
			"child",
			"/missing/child.jsonl",
			0,
			false,
		),
		undefined,
	);
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-finalized-"));
	const file = join(dir, "child.jsonl");
	const binding = mintPublicationLaunchBinding(
		{
			sessionManager: {
				getSessionId: () => "parent",
				getLeafId: () => "parent-leaf",
			},
			launchToolCallId: "call",
		},
		"child",
		file,
		1,
		false,
	)!;
	const envelope: FinalizedResultEnvelope = {
		version: 1,
		launchBinding: binding,
		rootGeneration: "root-generation",
		assignment: {
			sessionId: "child-session",
			requestEntryId: "request",
			branchEntryIds: ["request", "answer"],
		},
		finalAssistantEntryId: "answer",
		resultSchemaId: "opaque-root-schema",
		validatedFields: { result: "ok" },
		renderedSha256: "a".repeat(64),
		candidate: { opaque: true },
		inputPins: [],
		proofs: [{ opaqueRootEvidence: true }],
	};
	const ref: FinalizedResultRef = {
		state: "finalized",
		entryId: "finalized",
		envelopeSha256: envelopeSha256(envelope),
		childSessionId: "child-session",
		rootGeneration: envelope.rootGeneration,
		incarnationId: binding.incarnationId,
	};
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: "child-session" },
		{
			type: "message",
			id: "request",
			parentId: null,
			message: { role: "user", content: "actual request" },
		},
		{
			type: "message",
			id: "answer",
			parentId: "request",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "ok" }],
			},
		},
		{
			type: "custom",
			id: "finalized",
			parentId: "answer",
			customType: FINALIZED_RESULT_ENTRY,
			data: envelope,
		},
		{
			type: "custom",
			id: "completion",
			parentId: "finalized",
			customType: "subagent-completion",
			data: {},
		},
	];
	const save = () =>
		writeFileSync(
			file,
			entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
		);
	save();
	const running: RunningSubagent = {
		id: "child",
		name: "child",
		task: "check",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		sessionFile: file,
		startTime: 1,
		launchBinding: binding,
	};
	const result: SubagentResult = {
		name: "child",
		task: "check",
		summary: "ok",
		exitCode: 0,
		elapsed: 1,
		finalizedResultRef: ref,
	};
	return {
		dir,
		file,
		binding,
		envelope,
		ref,
		entries,
		save,
		running,
		result,
		cleanup() {
			revokePublicationBinding(file);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("no-session completion cannot capture proof even with a supplied ref", () => {
	const f = fixture();
	try {
		assert.equal(
			buildCompletedSubagentResult({ ...f.running, noSession: true }, f.result)
				.finalizedResultEnvelope,
			undefined,
		);
	} finally {
		f.cleanup();
	}
});

test("capture freezes the exact referenced envelope before completion and survives later file mutation", () => {
	const f = fixture();
	try {
		const completed = buildCompletedSubagentResult(f.running, f.result);
		assert.deepEqual(completed.finalizedResultEnvelope, f.envelope);
		assert.ok(Object.isFrozen(completed.finalizedResultEnvelope));
		assert.ok(Object.isFrozen(completed.finalizedResultEnvelope?.proofs[0]));
		writeFileSync(f.file, "malicious replacement\n");
		assert.deepEqual(completed.finalizedResultEnvelope, f.envelope);
		assert.equal(captureFinalizedResult(f.file, f.binding, f.ref), undefined);
	} finally {
		f.cleanup();
	}
});

for (const scenario of [
	"malformed-json",
	"duplicate-id",
	"wrong-header",
	"broken-parent",
	"wrong-ancestry",
	"new-input",
	"inherited-request",
	"wrong-ref",
	"wrong-incarnation",
	"wrong-generation",
	"tampered-envelope",
	"aborted-assistant",
	"revoked",
	"restart",
] as const) {
	test(`capture rejects ${scenario}`, () => {
		const f = fixture();
		try {
			let ref = f.ref;
			switch (scenario) {
				case "malformed-json":
					writeFileSync(f.file, readFileSync(f.file, "utf8") + "{bad\n");
					break;
				case "duplicate-id":
					f.entries.push({
						type: "custom",
						id: "answer",
						parentId: "completion",
					});
					f.save();
					break;
				case "wrong-header":
					f.entries[0].id = "other";
					f.save();
					break;
				case "broken-parent":
					f.entries[3].parentId = "missing";
					f.save();
					break;
				case "wrong-ancestry":
					f.entries[4].parentId = "request";
					f.save();
					break;
				case "new-input":
					f.entries.push({
						type: "message",
						id: "new-input",
						parentId: "completion",
						message: { role: "user" },
					});
					f.save();
					break;
				case "inherited-request": {
					const binding = mintPublicationLaunchBinding(
						{
							sessionManager: {
								getSessionId: () => "parent",
								getLeafId: () => "parent-leaf",
							},
							launchToolCallId: "call",
						},
						"child",
						f.file,
						2,
						false,
					)!;
					const envelope = { ...f.envelope, launchBinding: binding };
					f.entries[3].data = envelope;
					f.save();
					assert.equal(
						captureFinalizedResult(f.file, binding, {
							...f.ref,
							incarnationId: binding.incarnationId,
							envelopeSha256: envelopeSha256(envelope),
						}),
						undefined,
					);
					return;
				}
				case "wrong-ref":
					ref = { ...ref, entryId: "completion" };
					break;
				case "wrong-incarnation":
					ref = { ...ref, incarnationId: "stale" };
					break;
				case "wrong-generation":
					ref = { ...ref, rootGeneration: "stale" };
					break;
				case "tampered-envelope":
					f.entries[3].data = { ...f.envelope, validatedFields: "malicious" };
					f.save();
					break;
				case "aborted-assistant":
					f.entries[2].message = { role: "assistant", stopReason: "aborted" };
					f.save();
					break;
				case "revoked":
					revokePublicationBinding(f.file);
					break;
				case "restart":
					resetPublicationBindings();
					break;
			}
			assert.equal(captureFinalizedResult(f.file, f.binding, ref), undefined);
		} finally {
			f.cleanup();
		}
	});
}

for (const fields of [
	{ exitCode: 1 },
	{ ping: { name: "child", message: "help" } },
	{ error: "cancelled" },
	{ errorMessage: "provider failed" },
	{ timedOut: "timeout" as const },
	{ timeoutWrapUp: { kind: "timeout" as const, seconds: 1, threshold: 80 } },
]) {
	test(`nonterminal-success completion cannot carry proof: ${JSON.stringify(fields)}`, () => {
		const f = fixture();
		try {
			assert.equal(
				buildCompletedSubagentResult(f.running, { ...f.result, ...fields })
					.finalizedResultEnvelope,
				undefined,
			);
		} finally {
			f.cleanup();
		}
	});
}

function bus() {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	return {
		on(channel: string, listener: (value: unknown) => void) {
			const set = listeners.get(channel) ?? new Set();
			set.add(listener);
			listeners.set(channel, set);
			return () => {
				set.delete(listener);
			};
		},
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
	};
}

for (const scenario of [
	"success",
	"missing",
	"duplicate",
	"wrong-correlation",
	"throws",
	"timeout",
	"aborted",
] as const) {
	test(`callable finalizer handshake: ${scenario}`, async () => {
		const f = fixture();
		const events = bus();
		const controller = new AbortController();
		let calls = 0;
		try {
			const context = {
				sessionManager: {
					getSessionId: () => "child-session",
					getLeafId: () => "answer",
					getSessionFile: () => f.file,
				},
				signal: controller.signal,
			} as unknown as ExtensionContext;
			if (scenario !== "missing")
				events.on(FINALIZE_RESULT_REQUEST, (value) => {
					const request = value as {
						requestId: string;
						context: ExtensionContext;
					};
					assert.equal(
						request.context,
						context,
						"actual context is an in-process capability",
					);
					const response = {
						version: 1,
						requestId:
							scenario === "wrong-correlation" ? "wrong" : request.requestId,
						childSessionId: "child-session",
						incarnationId: f.binding.incarnationId,
						rootGeneration: f.ref.rootGeneration,
						finalize: async () => {
							calls++;
							if (scenario === "throws") throw new Error("root unavailable");
							if (scenario === "timeout") return new Promise<never>(() => {});
							if (scenario === "aborted") controller.abort();
							return f.ref;
						},
					};
					events.emit(FINALIZE_RESULT_RESPONSE, response);
					if (scenario === "duplicate")
						events.emit(FINALIZE_RESULT_RESPONSE, response);
				});
			const ref = await requestFinalizedResult(
				{ events } as Pick<ExtensionAPI, "events">,
				context,
				f.binding,
				10,
			);
			assert.deepEqual(ref, scenario === "success" ? f.ref : undefined);
			assert.equal(
				calls,
				["success", "throws", "timeout", "aborted"].includes(scenario) ? 1 : 0,
			);
		} finally {
			f.cleanup();
		}
	});
}

test("a separate process transports a real persisted reference without sharing proof authority", () => {
	const f = fixture();
	try {
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`
			import { readFileSync } from 'node:fs';
			import { createHash } from 'node:crypto';
			const values = readFileSync(process.argv[1], 'utf8').trim().split('\\n').map(JSON.parse);
			const entry = values.find(value => value.customType === '${FINALIZED_RESULT_ENTRY}');
			const envelope = entry.data;
			console.log(JSON.stringify({ state: 'finalized', entryId: entry.id, envelopeSha256: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'), childSessionId: values[0].id, rootGeneration: envelope.rootGeneration, incarnationId: envelope.launchBinding.incarnationId }));
		`,
				f.file,
			],
			{ encoding: "utf8", timeout: 5000 },
		);
		assert.equal(child.status, 0, child.stderr);
		const transported: unknown = JSON.parse(child.stdout);
		assert.deepEqual(transported, f.ref);
		assert.deepEqual(
			captureFinalizedResult(
				f.file,
				f.binding,
				transported as FinalizedResultRef,
			),
			f.envelope,
		);
	} finally {
		f.cleanup();
	}
});

for (const scenario of [
	"success",
	"missing-owner",
	"aborted",
	"new-input",
] as const) {
	test(`bound auto-exit waits for settlement and finalizer: ${scenario}`, async () => {
		const f = fixture();
		const envKeys = [
			"PI_SUBAGENT_PUBLICATION_BINDING",
			"PI_SUBAGENT_AUTO_EXIT",
			"PI_SUBAGENT_SESSION",
			"PI_SUBAGENT_SURFACE",
		];
		const old = envKeys.map((key) => process.env[key]);
		const events = bus();
		const lifecycle = new Map<
			string,
			Array<(event: never, ctx: ExtensionContext) => unknown>
		>();
		let finish: (() => void) | undefined;
		const gate = new Promise<void>((done) => {
			finish = done;
		});
		let shutdown: (() => void) | undefined;
		const shutDown = new Promise<void>((done) => {
			shutdown = done;
		});
		try {
			process.env.PI_SUBAGENT_PUBLICATION_BINDING = JSON.stringify(f.binding);
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = f.file;
			delete process.env.PI_SUBAGENT_SURFACE;
			const context = {
				sessionManager: {
					getSessionId: () => "child-session",
					getLeafId: () => "answer",
					getSessionFile: () => f.file,
				},
				hasPendingMessages: () => false,
				shutdown: () => shutdown?.(),
			} as unknown as ExtensionContext;
			const emit = async (name: string, event: unknown = {}) => {
				for (const handler of lifecycle.get(name) ?? [])
					await handler(event as never, context);
			};
			const pi = {
				events,
				on(
					name: string,
					handler: (event: never, ctx: ExtensionContext) => unknown,
				) {
					const handlers = lifecycle.get(name) ?? [];
					handlers.push(handler);
					lifecycle.set(name, handlers);
				},
				getActiveTools: () => [],
				setActiveTools() {},
				getAllTools: () => [],
				registerTool() {},
				registerCommand() {},
				appendEntry() {},
				sendUserMessage() {},
			} as unknown as ExtensionAPI;
			subagentDoneExtension(pi);
			if (scenario !== "missing-owner")
				events.on(FINALIZE_RESULT_REQUEST, (value) => {
					const request = value as { requestId: string };
					events.emit(FINALIZE_RESULT_RESPONSE, {
						version: 1,
						requestId: request.requestId,
						childSessionId: "child-session",
						incarnationId: f.binding.incarnationId,
						rootGeneration: f.ref.rootGeneration,
						finalize: async () => {
							await gate;
							return f.ref;
						},
					});
				});
			await emit("agent_start");
			await emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop" }],
			});
			assert.equal(
				existsSync(`${f.file}.exit`),
				false,
				"agent_end must not publish an early success",
			);
			const settled = emit("agent_settled", {
				aborted: scenario === "aborted",
			});
			assert.equal(
				existsSync(`${f.file}.exit`),
				false,
				"a pending finalizer must not publish success",
			);
			if (scenario === "new-input")
				await emit("input", { source: "extension" });
			finish?.();
			await settled;
			if (scenario === "aborted" || scenario === "new-input") {
				assert.equal(existsSync(`${f.file}.exit`), false);
			} else {
				await shutDown;
				const payload = JSON.parse(readFileSync(`${f.file}.exit`, "utf8"));
				assert.equal(payload.type, "done");
				assert.deepEqual(
					payload.finalizedResultRef,
					scenario === "success" ? f.ref : undefined,
				);
			}
		} finally {
			finish?.();
			for (let index = 0; index < envKeys.length; index++) {
				if (old[index] === undefined) delete process.env[envKeys[index]];
				else process.env[envKeys[index]] = old[index];
			}
			f.cleanup();
		}
	});
}

test("lookup is session/generation/revision bound, running-first, read-only and revoked at resume admission", async () => {
	const events = bus();
	const lifecycle = new Map<
		string,
		(event: never, context: ExtensionContext) => void
	>();
	const replies: Array<Record<string, unknown>> = [];
	events.on(DELEGATION_RESULT_RESPONSE, (value) => {
		replies.push(value as Record<string, unknown>);
	});
	registerDelegationStatus({
		events,
		on(
			name: string,
			handler: (event: never, context: ExtensionContext) => void,
		) {
			lifecycle.set(name, handler);
		},
	} as unknown as ExtensionAPI);
	const context = {
		sessionManager: { getSessionId: () => "parent" },
	} as unknown as ExtensionContext;
	const start = () => lifecycle.get("session_start")?.({} as never, context);
	start();
	const f = fixture();
	try {
		const request = {
			version: 1,
			requestId: "lookup",
			sessionId: "parent",
			childId: "child",
			incarnationId: f.binding.incarnationId,
		};
		const query = () => {
			events.emit(DELEGATION_RESULT_REQUEST, request);
			return replies.at(-1)!;
		};
		assert.equal(query().state, "missing");
		cacheCompletedSubagentResult(f.running, f.result);
		outstandingWork.delivery("child", () => {});
		const before = outstandingWork.snapshot();
		const first = query();
		assert.equal(first.state, "completed");
		assert.equal(first.sessionId, "parent");
		assert.equal(first.childId, "child");
		assert.equal(first.incarnationId, request.incarnationId);
		assert.deepEqual(first.envelope, f.envelope);
		assert.deepEqual(first.ref, f.ref);
		assert.deepEqual(query(), first);
		assert.deepEqual(
			outstandingWork.snapshot(),
			before,
			"lookups do not consume delivery",
		);
		outstandingWork.running.set("child", f.running);
		const active = query();
		assert.equal(active.state, "running");
		assert.ok(Number(active.revision) > Number(first.revision));
		outstandingWork.running.delete("child");
		const count = replies.length;
		for (const malformed of [
			{ ...request, sessionId: "wrong" },
			{ ...request, extra: true },
			{ ...request, incarnationId: "" },
		])
			events.emit(DELEGATION_RESULT_REQUEST, malformed);
		assert.equal(replies.length, count);
		events.emit(DELEGATION_RESULT_REQUEST, {
			...request,
			incarnationId: "stale",
		});
		assert.equal(replies.at(-1)?.state, "unavailable");
		const resume = resumeSubagentSession(
			{ sessionFile: f.file, model: "unavailable" },
			{
				runningSubagents: new Map(),
				isMuxAvailable: () => false,
			} as unknown as ResumeServiceRuntime,
		);
		assert.equal(
			query().state,
			"unavailable",
			"revocation occurs before the first resume await",
		);
		await assert.rejects(resume);
		start();
		const restarted = query();
		assert.notEqual(restarted.generation, first.generation);
		assert.equal(
			restarted.state,
			"unavailable",
			"a restart cannot restore captured proof authority",
		);
		lifecycle.get("session_shutdown")?.({} as never, context);
		const terminalCount = replies.length;
		query();
		assert.equal(replies.length, terminalCount);
	} finally {
		f.cleanup();
		outstandingWork.running.clear();
		outstandingWork.reset();
		completedSubagentResults.clear();
	}
});

for (const type of ["ping", "error", "unknown"] as const) {
	test(`non-done sidecar cannot transport proof: ${type}`, () => {
		const f = fixture();
		try {
			writeFileSync(
				`${f.file}.exit`,
				JSON.stringify({ type, finalizedResultRef: f.ref }),
			);
			assert.equal(
				consumeSubagentExitSignal(f.file)?.finalizedResultRef,
				undefined,
			);
		} finally {
			f.cleanup();
		}
	});
}

for (const bound of [true, false]) {
	test(`stable summary reaping respects bound=${bound} and genuine timeouts`, async () => {
		const f = fixture();
		mock.timers.enable({
			apis: ["Date", "setInterval", "setTimeout"],
			now: 10_000,
		});
		const child = new EventEmitter() as ChildProcess;
		const running: RunningSubagent = {
			...f.running,
			startTime: Date.now(),
			childProcess: child,
			autoExit: true,
			launchBinding: bound ? f.binding : undefined,
			timeoutBudget: { timeoutSeconds: 5 },
		};
		let terminations = 0;
		try {
			const result = watchBackgroundSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					terminateBackgroundChildProcess() {
						terminations++;
					},
				},
				new AbortController().signal,
			);
			mock.timers.tick(1000);
			mock.timers.tick(1000);
			mock.timers.tick(1000);
			assert.equal(
				terminations,
				bound ? 0 : 2,
				"only unbound stable summaries may be reaped",
			);
			if (bound) {
				mock.timers.tick(2000);
				assert.equal(
					terminations,
					1,
					"proof finalization does not suppress the real deadline",
				);
			}
			child.emit("exit", bound ? 1 : 0);
			assert.equal((await result).timedOut, bound ? "timeout" : undefined);
		} finally {
			mock.timers.reset();
			f.cleanup();
		}
	});
}

test("sidecar and interactive watcher carry the opaque ref", async () => {
	const f = fixture();
	try {
		writeFileSync(
			`${f.file}.exit`,
			JSON.stringify({ type: "done", finalizedResultRef: f.ref }),
		);
		const signal = consumeSubagentExitSignal(f.file)!;
		assert.deepEqual(signal.finalizedResultRef, f.ref);
		const result = await watchSubagent(
			{ ...f.running, mode: "interactive", surface: "fixture" },
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {},
				async pollForExit() {
					return signal;
				},
			},
			new AbortController().signal,
		);
		assert.deepEqual(result.finalizedResultRef, f.ref);
	} finally {
		f.cleanup();
	}
});

test("normal persistent launch mints actual invocation binding after configured env overrides", async () => {
	const f = fixture();
	const previous = process.env.PI_SUBAGENT_PI_COMMAND;
	try {
		const agentDir = join(f.dir, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "fixture.md"),
			"---\nname: fixture\nmode: background\nsession-mode: standalone\nskills: none\nenv: PI_SUBAGENT_PUBLICATION_BINDING=malicious-config\n---\nFixture\n",
		);
		const script = join(f.dir, "child.mjs");
		const output = join(f.dir, "launch-env.json");
		writeFileSync(
			script,
			"import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FIXTURE_OUTPUT, JSON.stringify({binding:process.env.PI_SUBAGENT_PUBLICATION_BINDING, session:process.env.PI_SUBAGENT_SESSION}));\n",
		);
		process.env.PI_SUBAGENT_PI_COMMAND = `"${process.execPath}" "${script}"`;
		const context = {
			cwd: f.dir,
			sessionManager: {
				getSessionFile: () => f.file,
				getSessionId: () => "actual-parent",
				getLeafId: () => "actual-leaf",
			},
			launchToolCallId: "actual-call",
		};
		const launch = () =>
			launchBackgroundSubagent(
				{
					name: "fixture-child",
					title: "Fixture child transport",
					task: "capture env",
					agent: "fixture",
					launchEnv: {
						PI_SUBAGENT_PUBLICATION_BINDING: "malicious-runtime",
						FIXTURE_OUTPUT: output,
					},
				},
				context,
				{ getContextWindow: () => undefined },
			);
		const first = await launch();
		await new Promise<void>((done, reject) => {
			first.childProcess!.once("exit", (code) =>
				code === 0 ? done() : reject(new Error(`fixture exit ${code}`)),
			);
			first.childProcess!.once("error", reject);
		});
		const captured = JSON.parse(readFileSync(output, "utf8"));
		assert.deepEqual(JSON.parse(captured.binding), first.launchBinding);
		assert.equal(first.launchBinding?.parentSessionId, "actual-parent");
		assert.equal(first.launchBinding?.parentLeafIdAtLaunch, "actual-leaf");
		assert.equal(first.launchBinding?.launchToolCallId, "actual-call");
		assert.equal(first.launchBinding?.childId, first.id);
		assert.equal(
			first.launchBinding?.canonicalSessionFile,
			join(realpathSync(dirname(captured.session)), basename(captured.session)),
		);
		const second = await launch();
		await new Promise<void>((done, reject) => {
			second.childProcess!.once("exit", (code) =>
				code === 0 ? done() : reject(new Error(`fixture exit ${code}`)),
			);
			second.childProcess!.once("error", reject);
		});
		assert.notEqual(
			first.launchBinding?.incarnationId,
			second.launchBinding?.incarnationId,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = previous;
		f.cleanup();
	}
});
