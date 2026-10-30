import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	ARTIFACT_CAPABILITY_CHANNEL,
	ARTIFACT_CAPABILITY_REQUEST_CHANNEL,
	ARTIFACT_CAPABILITY_VERSION,
	createOrchestratorArtifactGate,
	getOrchestratorArtifactTools,
	isArtifactCapabilityPath,
} from "../../src/runtime/orchestrator-artifacts.ts";

type EventListener = (payload: unknown) => void;

function createEvents() {
	const listeners = new Map<string, Set<EventListener>>();
	const order: string[] = [];
	return {
		order,
		on(channel: string, listener: EventListener) {
			order.push(`on:${channel}`);
			const channelListeners =
				listeners.get(channel) ?? new Set<EventListener>();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
		emit(channel: string, payload: unknown) {
			order.push(`emit:${channel}`);
			for (const listener of listeners.get(channel) ?? []) listener(payload);
		},
	};
}

const CAPABILITY_PATHS = {
	plan: ".harness/plans/2026-10-12-lean-instruction-architecture.md",
	daily: ".harness/2026/10/12.md",
	handoff:
		".harness/handoffs/2026/10/12/01234567-89ab-cdef-0123-456789abcdef-task.md",
	report:
		".harness/reports/2026/10/12/01234567-89ab-cdef-0123-456789abcdef-audit.md",
} as const;

const CAPABILITY_MATRIX: Readonly<
	Record<"read" | "write" | "edit", readonly string[]>
> = {
	read: Object.values(CAPABILITY_PATHS),
	write: [
		CAPABILITY_PATHS.plan,
		CAPABILITY_PATHS.handoff,
		CAPABILITY_PATHS.report,
	],
	edit: [CAPABILITY_PATHS.plan, CAPABILITY_PATHS.report],
};

const REJECTED_CAPABILITY_PATHS = [
	".harness/plans/2026-10-12-Lean-instruction-architecture.md",
	".harness/plans/2026-10-12-lean_instruction_architecture.md",
	".harness/handoffs/2026/10/12/01234567-89ab-cdef-0123-456789ABCDEf-task.md",
	".harness/handoffs/2026/10/12/zzzzzzzz-89ab-cdef-0123-456789abcdef-task.md",
	".harness/handoffs/2026/10/12/task.md",
	".harness/reports/2026/10/12/extra/01234567-89ab-cdef-0123-456789abcdef-audit.md",
	".harness/reports/2026/10/12/01234567-89ab-cdef-0123-456789abcdef-audit.txt",
	"/.harness/plans/2026-10-12-lean-instruction-architecture.md",
	"~/.harness/plans/2026-10-12-lean-instruction-architecture.md",
	".harness\\plans\\2026-10-12-lean-instruction-architecture.md",
	".harness//plans/2026-10-12-lean-instruction-architecture.md",
	".harness/./plans/2026-10-12-lean-instruction-architecture.md",
	".harness/plans/ignored/../2026-10-12-lean-instruction-architecture.md",
] as const;

test("capability version 1 uses the exact path and operation matrix", () => {
	assert.equal(ARTIFACT_CAPABILITY_VERSION, 1);
	for (const operation of ["read", "write", "edit"] as const) {
		for (const path of Object.values(CAPABILITY_PATHS)) {
			assert.equal(
				isArtifactCapabilityPath(operation, path),
				CAPABILITY_MATRIX[operation].includes(path),
				`${operation} ${path}`,
			);
		}
		for (const path of REJECTED_CAPABILITY_PATHS) {
			assert.equal(
				isArtifactCapabilityPath(operation, path),
				false,
				`${operation} ${path}`,
			);
		}
	}
});

test("topic log reads require additive negotiation without widening mutations or legacy paths", () => {
	const events = createEvents();
	const gate = createOrchestratorArtifactGate(events);
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-topic-"));
	const path = ".harness/2026/10/24/local-feature.md";
	const readEvent = { toolName: "read", input: { path } } as const;
	try {
		mkdirSync(join(cwd, ".harness/2026/10/24"), { recursive: true });
		writeFileSync(join(cwd, path), "topic history\n");
		assert.equal(gate.handleToolCall(readEvent, { cwd }, ["read"])?.block, true);
		events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 1, mutations: true });
		assert.equal(gate.handleToolCall(readEvent, { cwd }, ["read"])?.block, true);
		events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 1, mutations: true, topicLogs: 1 });
		assert.equal(gate.handleToolCall(readEvent, { cwd }, ["read"]), undefined, "the real announced topic feature must unlock its read grammar");
		assert.equal(readFileSync(join(cwd, path), "utf8"), "topic history\n");
		for (const toolName of ["write", "edit"] as const) {
			assert.equal(gate.handleToolCall({ toolName, input: { path } }, { cwd }, ["read", "write", "edit"])?.block, true);
		}
		for (const topicLogs of [undefined, 2, "1"]) {
			events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 1, mutations: true, topicLogs });
			assert.equal(gate.handleToolCall(readEvent, { cwd }, ["read"])?.block, true);
			assert.equal(gate.handleToolCall({ toolName: "read", input: { path: CAPABILITY_PATHS.daily } }, { cwd }, ["read"]), undefined);
		}
		events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 2, mutations: true, topicLogs: 1 });
		assert.equal(gate.handleToolCall(readEvent, { cwd }, ["read"])?.block, true);
		assert.equal(readFileSync(join(cwd, path), "utf8"), "topic history\n");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the normal baseline controls artifact tools and capability gates mutations", () => {
	assert.deepEqual([...getOrchestratorArtifactTools(["subagent"], true)], []);
	assert.deepEqual(
		[...getOrchestratorArtifactTools(["read", "write", "edit"], false)],
		["read"],
	);
	assert.deepEqual(
		[...getOrchestratorArtifactTools(["read", "write", "edit"], true)],
		["read", "write", "edit"],
	);

	const events = createEvents();
	const gate = createOrchestratorArtifactGate(events);
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-artifacts-"));
	try {
		const event = {
			toolName: "write",
			input: { path: CAPABILITY_PATHS.plan, content: "content" },
		} as Pick<ToolCallEvent, "toolName" | "input">;
		assert.equal(
			gate.handleToolCall(event, { cwd }, ["read", "write"])?.block,
			true,
		);
		events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 2, mutations: true });
		assert.equal(gate.hasCompatibleCapability(), false);
		events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 1, mutations: "yes" });
		assert.equal(gate.hasCompatibleCapability(), false);
		events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 1, mutations: true });
		assert.equal(gate.hasCompatibleCapability(), true);
		assert.equal(gate.handleToolCall(event, { cwd }, ["read"])?.block, true);
		assert.equal(
			gate.handleToolCall(event, { cwd }, ["read", "write"]),
			undefined,
		);
		events.emit(ARTIFACT_CAPABILITY_CHANNEL, { version: 1 });
		assert.equal(gate.hasCompatibleCapability(), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("malformed artifact inputs and ordinary paths fail closed", () => {
	const events = createEvents();
	const gate = createOrchestratorArtifactGate(events);
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-artifacts-"));
	try {
		for (const input of [undefined, null, [], {}, { path: 42 }]) {
			const event = { toolName: "read", input } as unknown as Pick<
				ToolCallEvent,
				"toolName" | "input"
			>;
			assert.equal(gate.handleToolCall(event, { cwd }, ["read"])?.block, true);
		}
		for (const path of [
			"src/source.ts",
			"",
			".",
			"..",
			"../.harness/plans/2026-10-12-plan.md",
		]) {
			const event = { toolName: "read", input: { path } } as Pick<
				ToolCallEvent,
				"toolName" | "input"
			>;
			assert.equal(
				gate.handleToolCall(event, { cwd }, ["read"])?.block,
				true,
				path,
			);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("symlinked parents and leaves are rejected before artifact execution", () => {
	const events = createEvents();
	const gate = createOrchestratorArtifactGate(events);
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-artifacts-"));
	try {
		const harnessDir = join(cwd, ".harness");
		const targetDir = join(cwd, "target");
		mkdirSync(targetDir, { recursive: true });
		mkdirSync(harnessDir);
		symlinkSync(targetDir, join(harnessDir, "plans"), "dir");
		const artifact = {
			toolName: "read",
			input: { path: CAPABILITY_PATHS.plan },
		} as Pick<ToolCallEvent, "toolName" | "input">;
		assert.equal(gate.handleToolCall(artifact, { cwd }, ["read"])?.block, true);

		unlinkSync(join(harnessDir, "plans"));
		mkdirSync(join(harnessDir, "plans"));
		const targetFile = join(cwd, "target.md");
		writeFileSync(targetFile, "target");
		symlinkSync(
			targetFile,
			join(harnessDir, "plans", "2026-10-12-lean-instruction-architecture.md"),
		);
		assert.equal(gate.handleToolCall(artifact, { cwd }, ["read"])?.block, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("symlinked ancestors of the live cwd are rejected", () => {
	const events = createEvents();
	const gate = createOrchestratorArtifactGate(events);
	const realRoot = mkdtempSync(join(tmpdir(), "pi-subagents-real-cwd-"));
	const aliasRoot = mkdtempSync(join(tmpdir(), "pi-subagents-alias-cwd-"));
	try {
		mkdirSync(join(realRoot, "project", ".harness", "plans"), {
			recursive: true,
		});
		symlinkSync(realRoot, join(aliasRoot, "linked-parent"), "dir");
		const event = {
			toolName: "read",
			input: { path: CAPABILITY_PATHS.plan },
		} as Pick<ToolCallEvent, "toolName" | "input">;
		assert.equal(
			gate.handleToolCall(
				event,
				{ cwd: join(aliasRoot, "linked-parent", "project") },
				["read"],
			)?.block,
			true,
		);
	} finally {
		rmSync(realRoot, { recursive: true, force: true });
		rmSync(aliasRoot, { recursive: true, force: true });
	}
});

test("capability handshake supports package-first and root-first loading", () => {
	const packageFirst = createEvents();
	const packageFirstGate = createOrchestratorArtifactGate(packageFirst);
	assert.deepEqual(packageFirst.order.slice(0, 2), [
		`on:${ARTIFACT_CAPABILITY_CHANNEL}`,
		`emit:${ARTIFACT_CAPABILITY_REQUEST_CHANNEL}`,
	]);
	assert.equal(packageFirstGate.hasCompatibleCapability(), false);
	packageFirst.emit(ARTIFACT_CAPABILITY_CHANNEL, {
		version: 1,
		mutations: true,
	});
	assert.equal(packageFirstGate.hasCompatibleCapability(), true);

	const rootFirst = createEvents();
	rootFirst.on(ARTIFACT_CAPABILITY_REQUEST_CHANNEL, () => {
		rootFirst.emit(ARTIFACT_CAPABILITY_CHANNEL, {
			version: 1,
			mutations: true,
		});
	});
	const rootFirstGate = createOrchestratorArtifactGate(rootFirst);
	assert.equal(rootFirstGate.hasCompatibleCapability(), true);
});
