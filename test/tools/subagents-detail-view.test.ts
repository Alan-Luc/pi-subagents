import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { completedSubagentResults, runningSubagents } from "../../src/runtime/state.ts";
import { SubagentsOverlay } from "../../src/tools/subagents-view.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest, setRunningSubagentForTest } from "../support/index.ts";

const testRuntime = {
	getShellReadyDelayMs: () => 800,
	isMuxAvailable: () => false,
	watchBackgroundSubagent: async () => ({
		name: "",
		task: "",
		summary: "",
		exitCode: 0,
		elapsed: 0,
	}),
	watchSubagent: async () => ({
		name: "",
		task: "",
		summary: "",
		exitCode: 0,
		elapsed: 0,
	}),
	getWatcherSignal: (_r: any, c: AbortController) => c.signal,
	startWidgetRefresh: () => {},
	getContextWindow: () => undefined,
	runningSubagents: new Map(),
	pi: { on() {} } as any,
	wireSubagentSteerBack: () => {},
};

function createOverlay(rows?: number, tuiOverride?: any): SubagentsOverlay {
	const done = () => {};
	const ctx = {
		cwd: "/tmp",
		ui: {
			confirm: async () => true,
			input: async () => "test message",
			notify: () => {},
		},
		sessionManager: {
			getSessionFile: () => null,
		},
	} as any;
	const theme = {
		fg: (_t: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui =
		tuiOverride ??
		({
			requestRender: () => {},
			terminal: { columns: 80, ...(rows === undefined ? {} : { rows }) },
		} as any);
	return new SubagentsOverlay(done as any, ctx, theme, testRuntime as any, tui);
}

function createTestTerminal(columns = 100, rows = 24) {
	let onInput: ((data: string) => void) | undefined;
	return {
		columns,
		rows,
		kittyProtocolActive: false,
		start(input: (data: string) => void, _onResize: () => void) {
			onInput = input;
		},
		stop() {
			onInput = undefined;
		},
		drainInput: async (_maxMs?: number, _idleMs?: number) => {},
		write(_data: string) {},
		moveBy(_lines: number) {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle(_title: string) {},
		setProgress(_active: boolean) {},
		send(data: string) {
			if (!onInput) throw new Error("test terminal is not started");
			onInput(data);
		},
	};
}

function sendMousePress(terminal: ReturnType<typeof createTestTerminal>, x: number, y: number): void {
	terminal.send(`\x1b[<0;${x + 1};${y + 1}M`);
}

function sendMouseRelease(terminal: ReturnType<typeof createTestTerminal>, x: number, y: number): void {
	terminal.send(`\x1b[<0;${x + 1};${y + 1}m`);
}

function sendMouseGesture(terminal: ReturnType<typeof createTestTerminal>, x: number, y: number): void {
	sendMousePress(terminal, x, y);
	sendMouseRelease(terminal, x, y);
}

function simulateKey(overlay: SubagentsOverlay, key: string): void {
	overlay.handleInput(key);
}

function mouseEvent(
	overlay: SubagentsOverlay,
	type: "press" | "release" | "click",
	y: number,
	clickCount = 1,
) {
	return overlay.handleMouse({
		type,
		button: "left",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount,
	});
}

function mouseClick(overlay: SubagentsOverlay, y: number, clickCount = 1): void {
	mouseEvent(overlay, "click", y, clickCount);
}

function renderLines(overlay: SubagentsOverlay, width = 80): string[] {
	return overlay.render(width);
}

function stripAnsi(str: string): string {
	return str.replace(new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g"), "");
}

// ── Helpers to avoid direct key imports ────────────────────────────

function pressUp(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[A");
}

function pressDown(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[B");
}

function pressLeft(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[D");
}

function pressRight(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[C");
}
describe("subagents detail view", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

		describe("detail view", () => {
			it("shows the exact running prompt in the detail view", () => {
				const prompt = "  Inspect the auth flow.  \nReturn  only verified findings.";
				setRunningSubagentForTest({
					id: "prompt-1",
					name: "scout",
					task: prompt,
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: "/tmp/prompt.jsonl",
				} as any);

				const overlay = createOverlay();
				try {
					simulateKey(overlay, "i");
					const lines = renderLines(overlay);
					const text = lines.map(stripAnsi).join("\n");
					assert.match(text, /Prompt/);
					assert.ok(text.includes("Inspect the auth flow."), text);
					assert.ok(text.includes("Return  only verified findings."), text);
					assert.ok(lines.some((line) => line.includes("Inspect the auth flow.") && line.includes("Prompt")));
					assert.ok(lines.some((line) => line.includes("Return  only verified findings.") && !line.includes("Prompt")));
				} finally {
					overlay.dispose();
				}
			});

			it("sanitizes task and latest-assistant text before rendering", () => {
				const task = "\x1b[31mSafe task\x1b[0m\nnext\tline\x1b]0;hidden-title\x07";
				const assistant = "\x1b[2JLatest answer\x1b[0m\nsecond line\x01\x7f";
				setRunningSubagentForTest({
					id: "unsafe-text",
					name: "scout",
					task,
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: "/tmp/unsafe-text.jsonl",
					activity: "safe activity",
					lastAssistantText: assistant,
				} as any);

				const overlay = createOverlay();
				try {
					simulateKey(overlay, "i");
					const top = renderLines(overlay).join("\n");
					for (let i = 0; i < 50; i++) pressDown(overlay);
					const bottom = renderLines(overlay).join("\n");
					const rendered = `${top}\n${bottom}`;
					assert.ok(rendered.includes("Safe task"), rendered);
					assert.ok(rendered.includes("next\tline"), rendered);
					assert.ok(rendered.includes("Latest answer"), rendered);
					assert.ok(rendered.includes("second line"), rendered);
					assert.doesNotMatch(rendered, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/);
					assert.doesNotMatch(rendered, /hidden-title/);
				} finally {
					overlay.dispose();
				}
			});

			it("opens a live session with v, follows the tail, preserves scroll, and returns with Escape", () => {
				const dir = mkdtempSync(join(tmpdir(), "subagents-live-session-"));
				const sessionFile = join(dir, "child.jsonl");
				const records = Array.from({ length: 100 }, (_, index) => ({
					type: "message",
					id: `message-${index}`,
					message: { role: "user", content: [{ type: "text", text: `line-${index}` }] },
				}));
				writeFileSync(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
				setRunningSubagentForTest({
					id: "live-session",
					name: "live-scout",
					task: "watch",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile,
				} as any);

				const overlay = createOverlay();
				try {
					simulateKey(overlay, "i");
					simulateKey(overlay, "v");
					assert.equal((overlay as any).state.view.kind, "session");
					assert.equal((overlay as any).state.view.followTail, true);
					assert.match(renderLines(overlay).map(stripAnsi).join("\n"), /line-99/);

					simulateKey(overlay, "k");
					const preservedScroll = (overlay as any).state.view.scroll;
					assert.equal((overlay as any).state.view.followTail, false);
					writeFileSync(
						sessionFile,
						`${JSON.stringify({ type: "message", id: "late", message: { role: "user", content: [{ type: "text", text: "late-line" }] } })}\n`,
						{ flag: "a" },
					);
					(overlay as any).refreshItems();
					assert.equal((overlay as any).state.view.scroll, preservedScroll);
					assert.doesNotMatch(renderLines(overlay).map(stripAnsi).join("\n"), /late-line/);

					for (let i = 0; i < 200; i++) simulateKey(overlay, "j");
					assert.equal((overlay as any).state.view.followTail, true);
					writeFileSync(
						sessionFile,
						`${JSON.stringify({ type: "message", id: "tail", message: { role: "user", content: [{ type: "text", text: "tail-line" }] } })}\n`,
						{ flag: "a" },
					);
					(overlay as any).refreshItems();
					assert.match(renderLines(overlay).map(stripAnsi).join("\n"), /tail-line/);

					simulateKey(overlay, "\x1b");
					assert.equal((overlay as any).state.view.kind, "detail");
					simulateKey(overlay, "\x1b");
					assert.equal((overlay as any).state.view.kind, "list");
				} finally {
					overlay.dispose();
				}
			});

			it("opens a completed session and renders only the final safe transcript", async () => {
				const dir = mkdtempSync(join(tmpdir(), "subagents-completed-session-"));
				const sessionFile = join(dir, "completed.jsonl");
				writeFileSync(
					sessionFile,
					`${[
						{ type: "session", id: "session-1" },
						{ type: "message", id: "user-1", message: { role: "user", content: [{ type: "text", text: "Review the change" }] } },
						{
							type: "message",
							id: "assistant-1",
							message: {
								role: "assistant",
								content: [
									{ type: "thinking", thinking: "HIDDEN_THINKING" },
									{ type: "text", text: "Final safe answer" },
									{ type: "toolCall", name: "read_file", arguments: { secret: "HIDDEN_ARGUMENT" } },
								],
								stopReason: "stop",
							},
						},
						{
							type: "message",
							id: "tool-1",
							message: {
								role: "toolResult",
								toolName: "read_file",
								content: [{ type: "text", text: "HIDDEN_RESULT" }],
								details: { secret: "HIDDEN_DETAILS" },
							},
						},
					].map((record) => JSON.stringify(record)).join("\n")}\n`,
				);
				completedSubagentResults.set("completed-session", {
					id: "completed-session",
					name: "finished-scout",
					task: "Review the change",
					summary: "Final safe answer",
					sessionFile,
					exitCode: 0,
					elapsed: 2,
					status: "completed",
					mode: "background",
					deliveryState: "awaited",
					parentClosePolicy: "terminate",
					async: true,
					deliveredTo: "wait",
				});

				const overlay = createOverlay();
				try {
					pressRight(overlay);
					await new Promise<void>((resolve) => setImmediate(resolve));
					assert.equal((overlay as any).state.items.length, 1);
					simulateKey(overlay, "i");
					simulateKey(overlay, "v");
					assert.equal((overlay as any).state.view.kind, "session");
					const text = renderLines(overlay).map(stripAnsi).join("\n");
					assert.match(text, /Final safe answer/);
					assert.match(text, /Call: read_file/);
					for (const hidden of ["HIDDEN_THINKING", "HIDDEN_ARGUMENT", "HIDDEN_RESULT", "HIDDEN_DETAILS"]) {
						assert.ok(!text.includes(hidden), `${hidden} leaked: ${text}`);
					}
				} finally {
					overlay.dispose();
				}
			});

			it("shows no-session and missing states without breaking session navigation", () => {
				const dir = mkdtempSync(join(tmpdir(), "subagents-unavailable-session-"));
				setRunningSubagentForTest({
					id: "no-session",
					name: "ephemeral-scout",
					task: "watch",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: join(dir, "ephemeral.jsonl"),
					noSession: true,
				} as any);
				setRunningSubagentForTest({
					id: "missing-session",
					name: "pending-scout",
					task: "watch",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: join(dir, "pending.jsonl"),
				} as any);

				const overlay = createOverlay();
				try {
					simulateKey(overlay, "i");
					simulateKey(overlay, "v");
					assert.equal((overlay as any).state.view.transcript.state, "no-session");
					assert.match(renderLines(overlay).map(stripAnsi).join("\n"), /No session was recorded/);
					simulateKey(overlay, "j");
					simulateKey(overlay, "\x1b");
					assert.equal((overlay as any).state.view.kind, "detail");
					simulateKey(overlay, "\x1b");
					pressDown(overlay);
					simulateKey(overlay, "i");
					simulateKey(overlay, "v");
					assert.equal((overlay as any).state.view.transcript.state, "missing");
					assert.match(renderLines(overlay).map(stripAnsi).join("\n"), /not available yet; retrying/);
					simulateKey(overlay, "j");
					simulateKey(overlay, "\x1b");
					assert.equal((overlay as any).state.view.kind, "detail");
				} finally {
					overlay.dispose();
				}
			});

			it("retries a missing running session on refresh after the file is created", () => {
				const dir = mkdtempSync(join(tmpdir(), "subagents-session-retry-"));
				const sessionFile = join(dir, "late.jsonl");
				setRunningSubagentForTest({
					id: "late-session",
					name: "late-scout",
					task: "watch",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile,
				} as any);

				const overlay = createOverlay();
				try {
					simulateKey(overlay, "i");
					simulateKey(overlay, "v");
					assert.equal((overlay as any).state.view.transcript.state, "missing");
					writeFileSync(
						sessionFile,
						`${JSON.stringify({ type: "session", id: "late-session" })}\n${JSON.stringify({
							type: "message",
							id: "late-assistant",
							message: { role: "assistant", content: [{ type: "text", text: "Now visible" }] },
						})}\n`,
					);
					(overlay as any).refreshItems();
					assert.equal((overlay as any).state.view.transcript.state, "ready");
					assert.match(renderLines(overlay).map(stripAnsi).join("\n"), /Now visible/);
				} finally {
					overlay.dispose();
				}
			});

			it("opens detail view with i key", () => {
				setRunningSubagentForTest({
					id: "test-1",
					name: "scout",
					task: "Explore codebase",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: "/tmp/test.jsonl",
				} as any);

				const overlay = createOverlay();
				simulateKey(overlay, "i");
				const lines = renderLines(overlay);
				const text = lines.map(stripAnsi).join("\n");
				assert.ok(text.includes("scout"), `Expected "scout" in detail:\n${text}`);
				assert.ok(text.includes("Identity"), `Expected "Identity" section:\n${text}`);
				overlay.dispose();
			});

			it("keeps running detail visible after the agent leaves the running list", () => {
				setRunningSubagentForTest({
					id: "test-1",
					name: "scout",
					task: "Explore codebase",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: "/tmp/test.jsonl",
				} as any);

				const overlay = createOverlay();
				simulateKey(overlay, "i");
				runningSubagents.clear();
				const lines = renderLines(overlay);
				const text = lines.map(stripAnsi).join("\n");
				assert.ok(text.includes("scout"), `Expected detail snapshot to remain visible:\n${text}`);
				assert.ok(text.includes("Identity"), `Expected detail sections to remain visible:\n${text}`);
				overlay.dispose();
			});

			it("refreshes the selected running detail from current runtime data", () => {
				const running = {
					id: "live-1",
					name: "live-scout",
					task: "Keep monitoring",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: "/tmp/live.jsonl",
					activity: "initial activity",
					lastAssistantText: "initial assistant",
					pendingToolCount: 1,
					messageCount: 1,
					toolUses: 1,
					contextTokens: 100,
					modelContextWindow: 1_000,
				} as any;
				setRunningSubagentForTest(running);

				const overlay = createOverlay();
				try {
					simulateKey(overlay, "i");
					for (let i = 0; i < 50; i++) pressDown(overlay);
					assert.match(renderLines(overlay).map(stripAnsi).join("\n"), /initial activity/);

					running.activity = "updated activity";
					running.lastAssistantText = "updated assistant";
					running.pendingToolCount = 3;
					running.messageCount = 4;
					running.toolUses = 5;
					running.contextTokens = 900;
					(overlay as any).refreshItems();

					const text = renderLines(overlay).map(stripAnsi).join("\n");
					assert.match(text, /updated activity/);
					assert.match(text, /updated assistant/);
					assert.match(text, /pending tools.*3/);
					assert.match(text, /messages.*4/);
					assert.match(text, /tool uses.*5/);
					assert.match(text, /900\/1K/);
					assert.doesNotMatch(text, /initial activity|initial assistant/);
				} finally {
					overlay.dispose();
				}
			});

			it("selects rows and opens details through TUI mouse clicks", () => {
				for (const [id, name, task] of [
					["mouse-1", "first", "first task"],
					["mouse-2", "second", "second task"],
				] as const) {
					setRunningSubagentForTest({
						id,
						name,
						task,
						mode: "background",
						executionState: "running",
						deliveryState: "detached",
						parentClosePolicy: "terminate",
						startTime: Date.now(),
						sessionFile: `/tmp/${id}.jsonl`,
					} as any);
				}

				const overlay = createOverlay();
				try {
					// Header is five rows; the first item is three rows tall.
					assert.equal(mouseEvent(overlay, "press", 8)?.capture, true);
					mouseEvent(overlay, "release", 8);
					mouseEvent(overlay, "click", 8);
					assert.equal((overlay as any).state.selectedIndex, 1);
					mouseEvent(overlay, "press", 8);
					mouseEvent(overlay, "release", 8);
					mouseEvent(overlay, "click", 8, 2);
					const text = renderLines(overlay).map(stripAnsi).join("\n");
					assert.match(text, /second/);
					assert.match(text, /Prompt/);
					assert.match(text, /second task/);
				} finally {
					overlay.dispose();
				}
			});

			it("routes mouse input through the installed alt-screen dispatcher", () => {
				for (const [id, name, task] of [
					["dispatch-1", "first", "first task"],
					["dispatch-2", "second", "second task"],
				] as const) {
					setRunningSubagentForTest({
						id,
						name,
						task,
						mode: "background",
						executionState: "running",
						deliveryState: "detached",
						parentClosePolicy: "terminate",
						startTime: Date.now(),
						sessionFile: `/tmp/${id}.jsonl`,
					} as any);
				}

				const terminal = createTestTerminal();
				const tui = new TuiAltScreen(terminal as any, false);
				const overlay = createOverlay(24, tui);
				let handle: ReturnType<typeof tui.showOverlay> | undefined;
				try {
					tui.start();
					handle = tui.showOverlay(overlay, { width: 80, row: 2, col: 3, maxHeight: 20 });
					tui.renderNow(true);
					const bounds = handle.getBounds();
					assert.ok(bounds);
					const x = bounds!.col + 1;
					const secondRow = bounds!.row + 8;

					// Release outside the overlay after an in-bounds press; alt-screen capture must retarget it.
					sendMousePress(terminal, x, secondRow);
					sendMouseRelease(terminal, x, bounds!.row + bounds!.height);
					assert.equal((overlay as any).state.selectedIndex, 1);
					assert.equal((overlay as any).state.view.kind, "list");

					sendMouseGesture(terminal, x, secondRow);
					sendMouseGesture(terminal, x, secondRow);
					assert.equal((overlay as any).state.view.kind, "detail");
					assert.match(overlay.render(80).join("\n"), /second task/);
				} finally {
					handle?.hide();
					overlay.dispose();
					tui.stop({ preserveScreen: true });
				}
			});

			it("ignores footer and off-screen mouse clicks", () => {
				for (let i = 0; i < 10; i++) {
					setRunningSubagentForTest({
						id: `offscreen-${i}`,
						name: `scout-${i}`,
						task: `task-${i}`,
						mode: "background",
						executionState: "running",
						deliveryState: "detached",
						parentClosePolicy: "terminate",
						startTime: Date.now(),
						sessionFile: `/tmp/offscreen-${i}.jsonl`,
					} as any);
				}

				const overlay = createOverlay(24);
				try {
					// Production-like 24-row terminal: header 5 + body 18, so row 23 is the footer.
					mouseClick(overlay, 23);
					mouseClick(overlay, 24, 2);
					assert.equal((overlay as any).state.selectedIndex, 0);
					assert.equal((overlay as any).state.view.kind, "list");
				} finally {
					overlay.dispose();
				}
			});

			it("closes detail view with Escape", () => {
				setRunningSubagentForTest({
					id: "test-1",
					name: "scout",
					task: "Explore codebase",
					mode: "background",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					startTime: Date.now(),
					sessionFile: "/tmp/test.jsonl",
				} as any);

				const overlay = createOverlay();
				simulateKey(overlay, "i"); // Open detail
				pressLeft(overlay); // Should NOT switch tab in detail mode
				simulateKey(overlay, "\x1b"); // Escape closes detail
				const lines = renderLines(overlay);
				const text = lines.map(stripAnsi).join("\n");
				assert.ok(text.includes("Running"), `Expected back to Running tab:\n${text}`);
				overlay.dispose();
			});
		});
	});
