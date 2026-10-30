import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRegistryLike } from "../../src/launch/child-launch-plan.ts";
import { completedSubagentResults } from "../../src/runtime/state.ts";
import { buildOrchestratorSessionState } from "../../src/session/orchestrator-state.ts";
import type { SubagentsOverlay } from "../../src/tools/subagents-view.ts";
import {
	afterEach,
	assert,
	clearIsolatedSubagentEnv,
	createTestDir,
	describe,
	it,
	join,
	resetSubagentStateForTest,
	subagentsExtension,
	writeExecutable,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

type CapturedHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CapturedCommand = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface CapturedExtension {
	handlers: Map<string, CapturedHandler>;
	commands: Map<string, CapturedCommand>;
	activeTools: () => string[];
	session: SessionManager;
	context: ExtensionContext;
	root: string;
}

function createExtensionHarness(
	orchestratorMode: string,
	child = false,
	availableModels: ReturnType<ModelRegistryLike["getAvailable"]> = [],
): CapturedExtension {
	clearIsolatedSubagentEnv();
	const root = createTestDir();
	const agentDir = join(root, "agent-root");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", "worker.md"),
		"---\nname: worker\ndescription: Wiring test worker\n---\n\nWorker body.",
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_ORCHESTRATOR_MODE = orchestratorMode;
	process.env.PI_SUBAGENT_AGENT = child ? "worker" : "";
	process.env.PI_SUBAGENT_NAME = child ? "worker" : "";

	const session = SessionManager.inMemory(root);
	let tools = ["read", "bash", "subagent", "subagent_kill", "subagent_resume"];
	const handlers = new Map<string, CapturedHandler>();
	const commands = new Map<string, CapturedCommand>();
	const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
	const events = {
		on(channel: string, listener: (payload: unknown) => void) {
			const listeners = eventListeners.get(channel) ?? new Set();
			listeners.add(listener);
			eventListeners.set(channel, listeners);
			return () => listeners.delete(listener);
		},
		emit(channel: string, payload: unknown) {
			for (const listener of eventListeners.get(channel) ?? [])
				listener(payload);
		},
	};
	const api = {
		on(event: string, handler: CapturedHandler) {
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
		events,
		getAllTools() {
			return tools.map((name) => ({ name }));
		},
		registerTool() {},
		registerCommand(name: string, options: { handler: CapturedCommand }) {
			commands.set(name, options.handler);
		},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
	};

	const context = {
		cwd: root,
		mode: "print" as const,
		hasUI: false,
		ui: {
			notify() {},
			setWidget() {},
		},
		sessionManager: session,
		modelRegistry: { getAvailable: () => availableModels },
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "base",
		// SAFETY: This fixture exercises orchestrator event wiring only; the other
		// ExtensionUIContext methods are intentionally unused by these handlers.
	} as unknown as ExtensionContext;

	subagentsExtension(api as unknown as ExtensionAPI);
	return { handlers, commands, activeTools: () => [...tools], session, context, root };
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

describe("orchestrator extension wiring", () => {
	afterEach(() => clearIsolatedSubagentEnv());

	it("enforces the resolved mode at lifecycle, prompt, and tool boundaries", () => {
		const harness = createExtensionHarness("1");
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			harness.context,
		);
		assert.deepEqual(harness.activeTools(), [
			"read",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const startEvent = {
			type: "before_agent_start",
			prompt: "delegate",
			systemPrompt: "base",
			systemPromptOptions: {
				cwd: harness.context.cwd,
				appendSystemPrompt: "preserve this",
			},
		};
		const start = harness.handlers.get("before_agent_start")?.(
			startEvent,
			harness.context,
		) as { systemPrompt?: string } | undefined;
		assert.equal(start?.systemPrompt, undefined);
		assert.match(
			startEvent.systemPromptOptions.appendSystemPrompt ?? "",
			/^preserve this\n\nYou are in delegation-only orchestrator mode/,
		);

		const blocked = harness.handlers.get("tool_call")?.(
			{ toolName: "bash" },
			harness.context,
		) as
			| {
					block?: boolean;
			  }
			| undefined;
		assert.equal(blocked?.block, true);
	});

	it("lets branch state override inherited env mode during reload", () => {
		const harness = createExtensionHarness("1");
		harness.session.appendCustomEntry(
			"pi-subagents:orchestrator",
			buildOrchestratorSessionState(false, [
				"read",
				"bash",
				"subagent",
				"subagent_kill",
				"subagent_resume",
			]),
		);
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "reload" },
			harness.context,
		);
		assert.deepEqual(harness.activeTools(), [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const result = harness.handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: "base",
				systemPromptOptions: { cwd: harness.context.cwd },
			},
			harness.context,
		) as { systemPrompt?: string } | undefined;
		assert.equal(result?.systemPrompt, undefined);
	});

	it("does not inherit orchestration mode in a child process", () => {
		const harness = createExtensionHarness("1", true);
		harness.session.appendCustomEntry(
			"pi-subagents:orchestrator",
			buildOrchestratorSessionState(true, ["read", "bash", "subagent"]),
		);
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			harness.context,
		);
		assert.deepEqual(harness.activeTools(), [
			"read",
			"bash",
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);

		const result = harness.handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "work",
				systemPrompt: "base",
				systemPromptOptions: { cwd: harness.context.cwd },
			},
			harness.context,
		) as { systemPrompt?: string } | undefined;
		assert.equal(result?.systemPrompt, undefined);
	});
});

describe("/subagents overlay resume wiring", () => {
	afterEach(() => {
		resetSubagentStateForTest();
		clearIsolatedSubagentEnv();
	});

	for (const scenario of [
		{
			description: "starts a locked high-effort completed child with the installed model metadata",
			thinking: "high",
			thinkingLevelMap: { low: "low", high: "high" },
			expected: { notice: "Resumed reviewer.", model: "anthropic/claude-sonnet-5:high" },
		},
		{
			description: "rejects locked effort the installed model cannot run before spawning",
			thinking: "off",
			thinkingLevelMap: { off: null, high: "high" },
			expected: { notice: /^Failed: .*does not support thinking level 'off'/ },
		},
	]) {
		it(scenario.description, async () => {
			const harness = createExtensionHarness("0", false, [
				{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: scenario.thinkingLevelMap },
			]);
			harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, harness.context);
			const argvFile = join(harness.root, "child-argv.txt");
			process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
				harness.root,
				"capture-pi",
				`#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`,
			);
			const sessionFile = join(harness.root, "reviewer.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: harness.root })}\n`,
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: "2026-10-23T00:00:00.000Z",
				name: "reviewer",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				model: "anthropic/claude-sonnet-5",
				thinking: scenario.thinking,
				modelRef: `anthropic/claude-sonnet-5:${scenario.thinking}`,
				allowModelOverride: false,
				thinkingOverrides: ["low"],
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: harness.root,
				cwd: harness.root,
				boundarySystemPrompt: false,
			});
			completedSubagentResults.set("reviewer-1", {
				id: "reviewer-1",
				name: "reviewer",
				task: "Review the change",
				summary: "done",
				sessionFile,
				exitCode: 0,
				elapsed: 1,
				mode: "background",
				status: "completed",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				async: true,
				deliveredTo: null,
			});

			const notices: string[] = [];
			let overlay: SubagentsOverlay | undefined;
			const commandContext = {
				...harness.context,
				ui: {
					notify: (message: string) => notices.push(message),
					custom: (
						factory: (
							tui: { requestRender(): void; terminal: { columns: number; rows: number } },
							theme: { fg(tone: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string },
							keybindings: undefined,
							done: () => void,
						) => SubagentsOverlay,
					) => {
						overlay = factory(
							{ requestRender() {}, terminal: { columns: 100, rows: 30 } },
							{ fg: (_tone, text) => text, bg: (_color, text) => text, bold: (text) => text },
							undefined,
							() => {},
						);
						return Promise.resolve(null);
					},
				},
				// SAFETY: The /subagents command reads only cwd, sessionManager and the
				// notify/custom UI methods supplied here.
			} as unknown as ExtensionCommandContext;

			const openCommand = harness.commands.get("subagents");
			assert.ok(openCommand, "subagentsExtension must register /subagents");
			await openCommand("", commandContext);
			const opened = await waitFor(() => overlay, "the overlay");
			try {
				opened.handleInput("\x1b[C");
				await waitFor(
					() => (opened.render(100).some((line) => line.includes("reviewer")) ? true : undefined),
					"the completed reviewer row",
				);
				opened.handleInput("m");
				for (const key of "continue") opened.handleInput(key);
				opened.handleInput("\r");
				const notice = await waitFor(() => notices.at(-1), "the resume notice");

				if (typeof scenario.expected.notice === "string") {
					assert.equal(notice, scenario.expected.notice);
					const argv = (await waitFor(() => (existsSync(argvFile) ? readFileSync(argvFile, "utf8") : undefined), "child argv")).split("\n");
					assert.equal(argv[argv.indexOf("--model") + 1], scenario.expected.model);
				} else {
					assert.match(notice, scenario.expected.notice);
					assert.equal(existsSync(argvFile), false, "a rejected locked effort must not spawn a child");
				}
			} finally {
				opened.dispose();
			}
		});
	}
});
