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
	it("describes session-local Task tools without shared coordination", () => {
		for (const tool of TASK_TOOLS) assert.match(ORCHESTRATOR_COMMON_PROMPT, new RegExp(`\\*\\*${tool}\\*\\*`));
		assert.match(ORCHESTRATOR_COMMON_PROMPT, /this session's own meaningful multi-step work/);
		assert.doesNotMatch(ORCHESTRATOR_COMMON_PROMPT, /coordination workflow supplied|parent task|shared task/);
	});

	it("requires self-contained implementation evidence without authorizing commits", () => {
		assert.doesNotMatch(
			ORCHESTRATOR_BASE_PROMPT,
			/Run the tests, commit, and report the hash\./,
		);
		assert.match(ORCHESTRATOR_BASE_PROMPT, /Implement the null-pointer fix/);
		assert.match(ORCHESTRATOR_BASE_PROMPT, /Run the focused tests/);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Report the changed files, commands run, and actual results as artifacts\/evidence/,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Do not commit or push; those actions are prohibited unless the user separately authorizes them\./,
		);
	});

	it("requires a terse non-trivial preflight without a named heading", () => {
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Before the first tool call or delegation on non-trivial work, give a terse 1–3 sentence preflight/,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/stating the objective\/result being addressed, then the approach and planned checks, plus what completion and verification look like/,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Lead with the intended result or decision, not chronology/,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Skip it for trivial Q&A, no-ops, or direct clarification questions/,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/A named BLUF heading is optional; do not require one/,
		);
		assert.doesNotMatch(ORCHESTRATOR_BASE_PROMPT, /BLUF:/);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Continue progress updates only at meaningful slice boundaries/,
		);
	});

	it("uses the concise BLUF communication rule", () => {
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/- \*\*BLUF communication\*\* -- Use BLUF structure for every user-facing answer\./,
		);
		assert.doesNotMatch(ORCHESTRATOR_BASE_PROMPT, /Every user-facing explanation must begin/);
		assert.doesNotMatch(ORCHESTRATOR_BASE_PROMPT, /silently inspect the first sentence/);
		assert.doesNotMatch(ORCHESTRATOR_BASE_PROMPT, /Good opening:/);
	});

	it("assigns verification acceptance and the final integration claim to the Tech Lead", () => {
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/When warranted, delegate an independent verification seam/,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/The top-level Tech Lead reviews and accepts the returned artifacts and focused check evidence, then owns the final integration claim\./,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/A verifier's prose alone is not sufficient evidence/,
		);
	});

	it("selects the smallest lane and keeps briefs information-dense", () => {
		for (const phrase of [
			/Trivial conversational answers or no-ops: do not spawn a sub-agent/,
			/Small known seams \(roughly 1–2 known files with clear behavior\): use one implementation agent, one pass/,
			/Unknown or root-cause work: use one bounded explorer only until the seam and callers are known/,
			/synthesize concrete findings into the implementation brief so research is not repeated/,
			/Use a separate reviewer only for security, permissions, migrations\/data loss, broad or high-risk changes, or an explicit user request/,
			/Parallelize only independent, non-overlapping scopes; keep shared contracts with one owner/,
			/Resume high-overlap context instead of spawning fresh\. Spawn fresh only for independent verification or a genuinely different seam/,
			/low overlap alone is not a reason to fan out/,
			/Stop broad reading once enough evidence exists to implement safely/,
			/Include paths and line evidence already known; do not hand understanding back to the worker/,
		]) {
			assert.match(ORCHESTRATOR_BASE_PROMPT, phrase);
		}

		const briefSections = [
			"1. Objective",
			"2. Known facts/root cause",
			"3. Exact owned files and change",
			"4. Non-goals",
			"5. Focused checks",
			"6. Required return",
		];
		let previous = -1;
		for (const section of briefSections) {
			const index = ORCHESTRATOR_BASE_PROMPT.indexOf(section);
			assert.ok(index > previous, `${section} must follow the default brief ordering`);
			previous = index;
		}
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Use this six-part brief format by default, especially for fast-lane work/,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Keep it concise: bullets are preferred, and known sections should not be padded with boilerplate\./,
		);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/For deep\/high-risk work, append only the extra fields actually needed: user intent; dependencies\/shared contracts; acceptance criteria; risks\/edge cases; stop\/escalation conditions\./,
		);
		assert.match(ORCHESTRATOR_BASE_PROMPT, /Do not replace the default core\./);
		assert.match(
			ORCHESTRATOR_BASE_PROMPT,
			/Research found the implementation seam \| \*\*Resume\*\*/,
		);
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
		assert.match(ORCHESTRATOR_BASE_PROMPT, /work_log.*required verified work or decision record/s);
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
			"You are an orchestrator",
		]) {
			assert.match(renderedPrompt, new RegExp(sentinel));
		}
		assert.doesNotMatch(renderedPrompt, /parent creates, assigns/);
		let previousIndex = -1;
		for (const sentinel of [
			"prior append sentinel",
			"Tech Lead sentinel",
			"artifact brief sentinel",
			"You are an orchestrator",
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
