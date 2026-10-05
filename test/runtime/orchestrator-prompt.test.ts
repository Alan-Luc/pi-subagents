import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
	getPackageDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getOrchestratorPrompt, ORCHESTRATOR_BASE_PROMPT as ORCHESTRATOR_COMMON_PROMPT } from "../../src/runtime/orchestrator-prompt.ts";
import { filterOrchestratorTools } from "../../src/runtime/orchestrator-policy.ts";
import { createOrchestratorController, type OrchestratorRuntimeAPI } from "../../src/runtime/orchestrator-controller.ts";
import subagentsExtension from "../../src/subagents.ts";
import { getSubagentToolLaunchArgs } from "../../src/tools/policy.ts";
import { ORCHESTRATOR_ALLOWED_TOOL_NAMES, WORK_LOG_TOOL_NAME } from "../../src/tools/tool-names.ts";

const ORCHESTRATOR_BASE_PROMPT = getOrchestratorPrompt();
const { buildSystemPrompt } = (await import(
	pathToFileURL(join(getPackageDir(), "dist/core/system-prompt.js")).href,
)) as {
	buildSystemPrompt(options: {
		customPrompt?: string;
		appendSystemPrompt?: string;
		cwd: string;
		contextFiles?: Array<{ path: string; content: string }>;
	}): string;
};
const TASK_TOOLS = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"];
const FORBIDDEN_TASK_TOOLS = ["TaskExecute", "TaskOutput", "TaskStop"];

function createTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function withEnvironment<T>(values: Record<string, string | undefined>, callback: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return callback();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function createExtensionHarness(environment: Record<string, string | undefined>): {
	root: string;
	activeTools: () => string[];
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	context: ExtensionContext;
} {
	const root = createTempDir("pi-subagents-extension-");
	const agentDir = join(root, "agent-root");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", "worker.md"),
		"---\nname: worker\ndescription: Hermetic worker\n---\n\nWorker body.",
	);
	const session = SessionManager.inMemory(root);
	let tools = ["read", "bash", "subagent", ...TASK_TOOLS];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
		appendEntry(customType: string, data: unknown) {
			session.appendCustomEntry(customType, data);
		},
		getActiveTools() {
			return [...tools];
		},
		setActiveTools(next: string[]) {
			tools = [...next];
		},
		getAllTools() {
			return tools.map((name) => ({ name }));
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
	};
	const context = {
		cwd: root,
		mode: "print" as const,
		hasUI: false,
		ui: { notify() {}, setWidget() {} },
		sessionManager: session,
		modelRegistry: { getAvailable: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	withEnvironment(
		{
			PI_CODING_AGENT_DIR: agentDir,
			PI_ORCHESTRATOR_MODE: "1",
			PI_SUBAGENT_AGENT: undefined,
			PI_SUBAGENT_NAME: undefined,
			...environment,
		},
		() => subagentsExtension(api as unknown as ExtensionAPI),
	);
	return { root, activeTools: () => [...tools], handlers, context };
}


describe("orchestrator prompt", () => {
	it("adds only the delegation-specific mode delta", () => {
		for (const phrase of [
			/You are in delegation-only orchestrator mode/,
			/Do not inspect files, run commands, edit code, or perform implementation work yourself/,
			/Delegate substantive work to sub-agents, then synthesize their returned results/,
			/under the existing system, AGENTS\.md, and Tech Lead instructions/,
			/Task tools manage this session's checklist/,
			/work_log may append required records/,
			/Never fabricate or predict asynchronous results/,
		]) {
			assert.match(ORCHESTRATOR_BASE_PROMPT, phrase);
		}
		for (const duplicatedPolicy of [
			/Before the first tool call/,
			/BLUF communication/,
			/Use this six-part brief format/,
			/Choose the smallest coordination path/,
			/Continue vs spawn fresh/,
			/Task workflow/,
		]) {
			assert.doesNotMatch(ORCHESTRATOR_BASE_PROMPT, duplicatedPolicy);
		}
		assert.ok(ORCHESTRATOR_BASE_PROMPT.length < 1_000);
	});

	it("keeps self-managed Task tools available without cross-session coordination", () => {
		assert.deepEqual(
			[...ORCHESTRATOR_ALLOWED_TOOL_NAMES].filter((name) => name.startsWith("Task")),
			TASK_TOOLS,
		);
		assert.deepEqual(filterOrchestratorTools(TASK_TOOLS), TASK_TOOLS);
		assert.deepEqual(filterOrchestratorTools(FORBIDDEN_TASK_TOOLS), []);
		assert.doesNotMatch(ORCHESTRATOR_BASE_PROMPT, /Task(Execute|Output|Stop)/);
	});

	it("keeps append-only work logging available without repository tools", () => {
		assert.ok(ORCHESTRATOR_ALLOWED_TOOL_NAMES.has(WORK_LOG_TOOL_NAME));
		assert.deepEqual(filterOrchestratorTools(["read", WORK_LOG_TOOL_NAME]), [WORK_LOG_TOOL_NAME]);
		assert.match(ORCHESTRATOR_BASE_PROMPT, /work_log may append required records/);
	});

	it("forwards all self-managed Task tools to workers", () => {
		for (const tool of TASK_TOOLS) {
			assert.deepEqual(getSubagentToolLaunchArgs(tool, new Set(), false), [
				"--tools",
				`${tool},caller_ping,subagent_done`,
			]);
		}
	});

	it("keeps session task tools in Pi's rendered prompt", () => {
		let tools = ["read", "bash", "subagent", WORK_LOG_TOOL_NAME, ...TASK_TOOLS];
		const session = SessionManager.inMemory(createTempDir("pi-subagents-controller-"));
		const api: OrchestratorRuntimeAPI = {
			appendEntry(type, data) {
				session.appendCustomEntry(type, data);
			},
			getActiveTools: () => [...tools],
			setActiveTools: (next) => {
				tools = [...next];
			},
		};
		const notices: Array<{ message: string; type?: string }> = [];
		const context = {
			sessionManager: session,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: {
				notify(message: string, type?: string) {
					notices.push({ message, type });
				},
			},
		};
		const controller = createOrchestratorController(api, {
			environment: { PI_ORCHESTRATOR_MODE: "1" },
			agentDir: createTempDir("pi-subagents-agent-"),
		});
		controller.handleSessionStart(context);
		assert.deepEqual(tools, ["subagent", WORK_LOG_TOOL_NAME, ...TASK_TOOLS]);
		assert.deepEqual(notices, []);
		const event = {
			systemPromptOptions: {
				customPrompt: "Pi base sentinel",
				cwd: "/tmp",
				contextFiles: [{ path: "AGENTS.md", content: "AGENTS sentinel" }],
				appendSystemPrompt:
					"prior append sentinel\nTech Lead sentinel\nartifact brief sentinel",
			},
		};
		assert.equal(controller.beforeAgentStart(event), undefined);
		const renderedPrompt = buildSystemPrompt(event.systemPromptOptions);
		for (const sentinel of [
			"Pi base sentinel",
			"AGENTS sentinel",
			"prior append sentinel",
			"Tech Lead sentinel",
			"artifact brief sentinel",
			"You are in delegation-only orchestrator mode",
		]) {
			assert.match(renderedPrompt, new RegExp(sentinel));
		}
		assert.doesNotMatch(renderedPrompt, /parent creates, assigns/);
		let previousIndex = -1;
		for (const sentinel of [
			"prior append sentinel",
			"Tech Lead sentinel",
			"artifact brief sentinel",
			"You are in delegation-only orchestrator mode",
		]) {
			const index = renderedPrompt.indexOf(sentinel);
			assert.ok(index > previousIndex, `${sentinel} must preserve append order`);
			previousIndex = index;
		}
		assert.equal(controller.handleToolCall({ toolName: "TaskGet" }), undefined);
		assert.equal(controller.handleToolCall({ toolName: WORK_LOG_TOOL_NAME }), undefined);
		assert.equal(controller.handleToolCall({ toolName: "subagent" }), undefined);
	});

	it("adds exactly one orchestrator delta when Pi has no prior append", () => {
		const session = SessionManager.inMemory(createTempDir("pi-subagents-controller-"));
		const api: OrchestratorRuntimeAPI = {
			appendEntry(type, data) {
				session.appendCustomEntry(type, data);
			},
			getActiveTools: () => ["subagent", ...TASK_TOOLS],
			setActiveTools() {},
		};
		const controller = createOrchestratorController(api, {
			environment: { PI_ORCHESTRATOR_MODE: "1" },
			agentDir: createTempDir("pi-subagents-agent-"),
		});
		controller.handleSessionStart({
			sessionManager: session,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: { notify() {} },
		});
		const event: {
			systemPromptOptions: {
				customPrompt: string;
				cwd: string;
				appendSystemPrompt?: string;
			};
		} = {
			systemPromptOptions: { customPrompt: "Pi base sentinel", cwd: "/tmp" },
		};
		assert.equal(controller.beforeAgentStart(event), undefined);
		assert.equal(event.systemPromptOptions.appendSystemPrompt, ORCHESTRATOR_COMMON_PROMPT);
		const renderedPrompt = buildSystemPrompt(event.systemPromptOptions);
		const orchestratorIndex = renderedPrompt.indexOf(ORCHESTRATOR_COMMON_PROMPT);
		assert.notEqual(orchestratorIndex, -1);
		assert.equal(orchestratorIndex, renderedPrompt.lastIndexOf(ORCHESTRATOR_COMMON_PROMPT));
	});

	it("keeps task tools available in a session", () => {
		const harness = createExtensionHarness({});
		try {
			harness.handlers.get("session_start")?.({ reason: "startup" }, harness.context);
			const taskTools = harness.activeTools().filter((name) => name.startsWith("Task"));
			assert.deepEqual(taskTools, TASK_TOOLS);
		} finally {
			rmSync(harness.root, { recursive: true, force: true });
		}
	});

});
