import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_CAPABILITY_CHANNEL } from "../../src/runtime/orchestrator-artifacts.ts";
import {
	loadOrchestratorGlobalConfig,
	saveOrchestratorGlobalDefault,
} from "../../src/runtime/orchestrator-config.ts";
import {
	createOrchestratorController,
	type OrchestratorContext,
	type OrchestratorRuntimeAPI,
} from "../../src/runtime/orchestrator-controller.ts";
import {
	appendOrchestratorSessionState,
	buildOrchestratorSessionState,
	readOrchestratorSessionState,
} from "../../src/session/orchestrator-state.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
} from "../support/index.ts";

function createEvents() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, listener: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
		emit(channel: string, payload: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(payload);
		},
	};
}

function createRuntime(
	activeTools: string[],
	session = SessionManager.inMemory(createTestDir()),
) {
	let currentTools = [...activeTools];
	const events = createEvents();
	const cwd = createTestDir();
	const pi: OrchestratorRuntimeAPI = {
		appendEntry(customType: string, data: unknown) {
			assert.equal(customType, "pi-subagents:orchestrator");
			session.appendCustomEntry(customType, data);
		},
		getActiveTools() {
			return [...currentTools];
		},
		setActiveTools(toolNames: string[]) {
			currentTools = [...toolNames];
		},
		events,
	};
	const ctx: OrchestratorContext = {
		hasPendingMessages: () => false,
		isIdle: () => true,
		sessionManager: session,
		ui: { notify() {} },
	};
	return {
		pi,
		session,
		ctx,
		cwd,
		events,
		getActiveTools: () => [...currentTools],
	};
}

describe("orchestrator runtime persistence", () => {
	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("stores the global default beside the agent config and preserves unrelated properties", () => {
		const agentDir = createTestDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const configPath = join(agentDir, "pi-subagents.json");
		writeFileSync(
			configPath,
			JSON.stringify({ theme: "dark", nested: { keep: true } }),
		);

		const result = saveOrchestratorGlobalDefault(true);

		assert.equal(result.ok, true);
		assert.equal(existsSync(configPath), true);
		assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
			theme: "dark",
			nested: { keep: true },
			orchestratorDefault: true,
		});
		assert.deepEqual(loadOrchestratorGlobalConfig(), {
			path: configPath,
			savedDefault: true,
			source: "saved",
		});
	});

	it("persists and restores the selected mode from the current session branch", () => {
		const session = SessionManager.inMemory(createTestDir());

		appendOrchestratorSessionState(session, true, ["read", "subagent"]);

		assert.deepEqual(readOrchestratorSessionState(session.getBranch()), {
			enabled: true,
			activeTools: ["read", "subagent"],
		});
		assert.equal(session.getBranch().at(-1)?.type, "custom");
		assert.equal(
			(session.getBranch().at(-1) as { customType?: string }).customType,
			"pi-subagents:orchestrator",
		);
	});

	it("resolves startup mode from the environment, narrows tools, and restores the active baseline", () => {
		const runtime = createRuntime([
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);

		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, true);
		assert.deepEqual(runtime.getActiveTools(), [
			"read",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);
		assert.deepEqual(controller.getSnapshot(runtime.ctx).normalActiveTools, [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const result = controller.setMode(false, runtime.ctx);
		assert.equal(result.ok, true);
		assert.deepEqual(runtime.getActiveTools(), [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);
	});

	it("restores the persisted active baseline after a restart adds default tools", () => {
		const session = SessionManager.inMemory(createTestDir());
		const initial = createRuntime(["read", "subagent"], session);
		const initialController = createOrchestratorController(initial.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		initialController.handleSessionStart(initial.ctx);
		assert.equal(initialController.setMode(true, initial.ctx).ok, true);

		const restarted = createRuntime(
			["read", "bash", "edit", "write", "subagent"],
			session,
		);
		const restartedController = createOrchestratorController(restarted.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		restartedController.handleSessionStart(restarted.ctx);

		assert.equal(
			restartedController.getSnapshot(restarted.ctx).currentMode,
			true,
		);
		assert.deepEqual(
			restartedController.getSnapshot(restarted.ctx).normalActiveTools,
			["read", "subagent"],
		);
		assert.equal(restartedController.setMode(false, restarted.ctx).ok, true);
		assert.deepEqual(restarted.getActiveTools(), ["read", "subagent"]);
	});

	it("persists off/on/off transitions from the live normal tool snapshot", () => {
		const runtime = createRuntime(["read", "bash", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		controller.handleSessionStart(runtime.ctx);

		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, false);
		assert.equal(controller.setMode(true, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), ["read", "subagent"]);
		assert.equal(controller.setMode(false, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), ["read", "bash", "subagent"]);
	});

	it("applies env, saved, and branch precedence in that order", () => {
		const agentDir = createTestDir();
		assert.equal(saveOrchestratorGlobalDefault(true, agentDir).ok, true);

		const envOff = createRuntime(["read", "subagent"]);
		const envController = createOrchestratorController(envOff.pi, {
			agentDir,
			environment: { PI_ORCHESTRATOR_MODE: "0" },
		});
		envController.handleSessionStart(envOff.ctx);
		assert.equal(envController.getSnapshot(envOff.ctx).currentMode, false);

		const savedOn = createRuntime(["read", "subagent"]);
		const savedController = createOrchestratorController(savedOn.pi, {
			agentDir,
			environment: {},
		});
		savedController.handleSessionStart(savedOn.ctx);
		assert.equal(savedController.getSnapshot(savedOn.ctx).currentMode, true);

		const branchOn = createRuntime(["read", "subagent"]);
		appendOrchestratorSessionState(branchOn.session, true, [
			"read",
			"subagent",
		]);
		const branchController = createOrchestratorController(branchOn.pi, {
			agentDir,
			environment: { PI_ORCHESTRATOR_MODE: "0" },
		});
		branchController.handleSessionStart(branchOn.ctx);
		assert.equal(branchController.getSnapshot(branchOn.ctx).currentMode, true);
	});

	it("does not restore a stale baseline when another extension already disabled a tool", () => {
		const runtime = createRuntime(["read"]);
		appendOrchestratorSessionState(runtime.session, false, ["read", "bash"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: {},
		});
		controller.handleSessionStart(runtime.ctx);

		assert.deepEqual(controller.getSnapshot(runtime.ctx).normalActiveTools, [
			"read",
		]);
		assert.equal(controller.setMode(true, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), ["read"]);
		assert.equal(controller.setMode(false, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), ["read"]);
	});

	it("restores branch state across tree navigation and session reload", () => {
		const runtime = createRuntime(["read", "bash", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);
		const enabledEntry = runtime.session.getLeafId();
		assert.ok(enabledEntry);

		runtime.session.appendCustomEntry(
			"pi-subagents:orchestrator",
			buildOrchestratorSessionState(false, ["read"]),
		);
		runtime.session.branch(enabledEntry);
		controller.handleSessionTree(runtime.ctx);
		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, true);
		assert.deepEqual(runtime.getActiveTools(), ["read", "subagent"]);

		controller.handleSessionStart(runtime.ctx);
		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, true);
		assert.deepEqual(runtime.getActiveTools(), ["read", "subagent"]);
	});

	it("blocks mode changes for busy parents and all orchestration changes in children", () => {
		const runtime = createRuntime(["read", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: {},
			getRunningSubagentCount: () => 1,
		});
		controller.handleSessionStart(runtime.ctx);
		assert.equal(
			controller.setMode(true, runtime.ctx).reason,
			"running-subagents",
		);

		const child = createRuntime(["read", "subagent"]);
		const childController = createOrchestratorController(child.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1", PI_SUBAGENT_AGENT: "worker" },
		});
		childController.handleSessionStart(child.ctx);
		assert.equal(childController.getSnapshot(child.ctx).currentMode, false);
		assert.deepEqual(child.getActiveTools(), ["read", "subagent"]);
		assert.equal(
			childController.setMode(true, child.ctx).reason,
			"child-session",
		);
		assert.equal(
			childController.saveGlobalDefault(true, child.ctx).reason,
			"child-session",
		);
	});

	it("blocks disallowed calls and preserves appended system prompt text", () => {
		const runtime = createRuntime(["read", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);

		const event = {
			systemPromptOptions: { cwd: "/tmp", appendSystemPrompt: "keep this" },
		};
		const result = controller.beforeAgentStart(event);
		assert.equal(result, undefined);
		assert.match(
			event.systemPromptOptions.appendSystemPrompt ?? "",
			/^keep this\n\nYou are in delegation-only orchestrator mode/,
		);
		assert.equal(
			controller.handleToolCall(
				{ toolName: "bash", input: { command: "true" } },
				{ cwd: runtime.cwd },
			)?.block,
			true,
		);
		assert.equal(
			controller.handleToolCall(
				{ toolName: "subagent", input: {} },
				{ cwd: runtime.cwd },
			),
			undefined,
		);
	});

	it("gates artifact operations by baseline and live capability", () => {
		const runtime = createRuntime([
			"read",
			"write",
			"edit",
			"bash",
			"subagent",
		]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);
		assert.deepEqual(runtime.getActiveTools(), ["read", "subagent"]);
		const readEvent = {
			toolName: "read",
			input: {
				path: ".harness/plans/2026-10-12-lean-instruction-architecture.md",
			},
		};
		assert.equal(
			controller.handleToolCall(readEvent, { cwd: runtime.cwd }),
			undefined,
		);
		const writeEvent = {
			toolName: "write",
			input: {
				path: ".harness/plans/2026-10-12-lean-instruction-architecture.md",
				content: "content",
			},
		};
		assert.equal(
			controller.handleToolCall(writeEvent, { cwd: runtime.cwd })?.block,
			true,
		);

		runtime.events.emit(ARTIFACT_CAPABILITY_CHANNEL, {
			version: 1,
			mutations: true,
		});
		controller.beforeAgentStart({ systemPromptOptions: { cwd: runtime.cwd } });
		assert.deepEqual(runtime.getActiveTools(), [
			"read",
			"write",
			"edit",
			"subagent",
		]);
		assert.equal(
			controller.handleToolCall(writeEvent, { cwd: runtime.cwd }),
			undefined,
		);
		runtime.events.emit(ARTIFACT_CAPABILITY_CHANNEL, {
			version: 2,
			mutations: true,
		});
		controller.beforeAgentStart({ systemPromptOptions: { cwd: runtime.cwd } });
		assert.deepEqual(runtime.getActiveTools(), ["read", "subagent"]);
		assert.equal(
			controller.handleToolCall(writeEvent, { cwd: runtime.cwd })?.block,
			true,
		);

		assert.equal(controller.setMode(false, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), [
			"read",
			"write",
			"edit",
			"bash",
			"subagent",
		]);
	});

	it("restores normal tools when capability is revoked immediately before disable", () => {
		const runtime = createRuntime([
			"read",
			"write",
			"edit",
			"bash",
			"subagent",
		]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);
		runtime.events.emit(ARTIFACT_CAPABILITY_CHANNEL, {
			version: 1,
			mutations: true,
		});
		controller.beforeAgentStart({ systemPromptOptions: { cwd: runtime.cwd } });
		assert.deepEqual(runtime.getActiveTools(), [
			"read",
			"write",
			"edit",
			"subagent",
		]);

		runtime.events.emit(ARTIFACT_CAPABILITY_CHANNEL, {
			version: 2,
			mutations: true,
		});
		assert.equal(controller.setMode(false, runtime.ctx).ok, true);
		assert.deepEqual(runtime.getActiveTools(), [
			"read",
			"write",
			"edit",
			"bash",
			"subagent",
		]);
	});

	it("uses each tool call's live cwd for symlink and ordinary path checks", () => {
		const runtime = createRuntime(["read", "subagent"]);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		controller.handleSessionStart(runtime.ctx);
		const symlinkCwd = createTestDir();
		const ordinaryCwd = createTestDir();
		const artifactPath =
			".harness/plans/2026-10-12-lean-instruction-architecture.md";
		mkdirSync(join(symlinkCwd, ".harness"));
		mkdirSync(join(symlinkCwd, "target"));
		symlinkSync(
			join(symlinkCwd, "target"),
			join(symlinkCwd, ".harness", "plans"),
			"dir",
		);
		mkdirSync(join(ordinaryCwd, ".harness", "plans"), { recursive: true });
		const event = { toolName: "read", input: { path: artifactPath } };
		assert.equal(
			controller.handleToolCall(event, { cwd: symlinkCwd })?.block,
			true,
		);
		assert.equal(
			controller.handleToolCall(event, { cwd: ordinaryCwd }),
			undefined,
		);
	});

	it("keeps child sessions unrestricted and never grants unavailable startup tools", () => {
		const parent = createRuntime(["subagent"]);
		const parentController = createOrchestratorController(parent.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1" },
		});
		parentController.handleSessionStart(parent.ctx);
		const readEvent = {
			toolName: "read",
			input: {
				path: ".harness/plans/2026-10-12-lean-instruction-architecture.md",
			},
		};
		assert.equal(
			parentController.handleToolCall(readEvent, { cwd: parent.cwd })?.block,
			true,
		);

		const child = createRuntime(["subagent"]);
		const childController = createOrchestratorController(child.pi, {
			agentDir: createTestDir(),
			environment: { PI_ORCHESTRATOR_MODE: "1", PI_SUBAGENT_AGENT: "worker" },
		});
		childController.handleSessionStart(child.ctx);
		assert.equal(
			childController.handleToolCall(readEvent, { cwd: child.cwd }),
			undefined,
		);
	});

	it("falls back safely for malformed config and write failures", () => {
		const agentDir = createTestDir();
		writeFileSync(join(agentDir, "pi-subagents.json"), "not json");
		const notices: string[] = [];
		const runtime = createRuntime(["read"]);
		runtime.ctx.ui.notify = (message) => notices.push(message);
		const controller = createOrchestratorController(runtime.pi, {
			agentDir,
			environment: {},
		});
		controller.handleSessionStart(runtime.ctx);
		assert.equal(controller.getSnapshot(runtime.ctx).currentMode, false);
		assert.ok(controller.getSnapshot(runtime.ctx).globalConfigError);
		assert.equal(notices.length, 1);

		const fileAgentDir = join(createTestDir(), "not-a-directory");
		writeFileSync(fileAgentDir, "file");
		const writeController = createOrchestratorController(runtime.pi, {
			agentDir: fileAgentDir,
		});
		assert.equal(writeController.saveGlobalDefault(true).ok, false);
	});

	it("does not accept mode aliases from the new session metadata format", () => {
		const session = SessionManager.inMemory(createTestDir());
		session.appendCustomEntry("pi-subagents:orchestrator", {
			version: 1,
			mode: "on",
		});
		assert.equal(readOrchestratorSessionState(session.getBranch()), undefined);
	});
});
