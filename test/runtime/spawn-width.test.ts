import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import {
	MAX_SPAWN_WIDTH,
	claimSpawnWidthSlot,
	getEffectiveSpawnWidthLimit,
	getLiveSlotCount,
	initializeSpawnWidthForSession,
	releaseSlots,
	tryAcquireSlots,
} from "../../src/runtime/spawn-width.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";

function makeRunning(id: string): RunningSubagent {
	return {
		id,
		name: id,
		task: "Task",
		title: "Task",
		agent: "worker",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: `/tmp/${id}.jsonl`,
	};
}

function makeResult(): SubagentResult {
	return {
		name: "worker",
		task: "Task",
		summary: "Done",
		summarySource: "subagent",
		exitCode: 0,
		elapsed: 1,
	};
}

function registerToolWithRuntime(runtimeOverrides: Partial<SubagentToolRuntime> = {}) {
	const tools = new Map<string, any>();
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => ({ spawning: true }),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: async (params) => makeRunning(params.name),
		launchSubagent: async (params) => makeRunning(params.name),
		watchBackgroundSubagent: async () => new Promise<SubagentResult>(() => {}),
		watchSubagent: async () => new Promise<SubagentResult>(() => {}),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({ content: [{ type: "text", text: "started" }], details: {} }),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [{ type: "text", text: "mux" }], details: {} }),
		...runtimeOverrides,
	};
	registerSubagentCoreTools(
		{
			registerTool(definition: any) {
				tools.set(definition.name, definition);
				return definition;
			},
			getThinkingLevel: () => "low",
		} as any,
		() => true,
		runtime,
	);
	return tools.get("subagent");
}

async function runAsRootCaller<T>(run: () => Promise<T>): Promise<T> {
	const keys = [
		"PI_SUBAGENT_AGENT",
		"PI_SUBAGENT_SPAWN_BUDGET",
		"PI_SUBAGENT_SPAWN_DEPTH",
		"PI_SUBAGENT_SPAWN_WIDTH",
		"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
		"PI_SUBAGENT_SPAWNABLE",
	] as const;
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.PI_SUBAGENT_SPAWNABLE = "true";
	try {
		return await run();
	} finally {
		for (const key of keys) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function toolContext() {
	return {
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: {
			getSessionFile: () => "/tmp/parent.jsonl",
			getSessionId: () => "parent",
		},
	};
}

const child = (name: string) => ({
	name,
	task: `Task for ${name}`,
	title: `Title for ${name}`,
	agent: "worker-a",
});

describe("spawn width semaphore", () => {
	afterEach(() => resetSubagentStateForTest());

	it("counts acquired slots and releases them without going below zero", () => {
		assert.equal(tryAcquireSlots(2, 3), true);
		assert.equal(getLiveSlotCount(), 2);
		assert.equal(tryAcquireSlots(2, 3), false);
		releaseSlots(1);
		assert.equal(getLiveSlotCount(), 1);
		assert.equal(tryAcquireSlots(2, 3), true);
		assert.equal(getLiveSlotCount(), 3);
		releaseSlots(99);
		assert.equal(getLiveSlotCount(), 0);
	});

	it("applies the width backstop to configured and unlimited sessions", () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "99";
		initializeSpawnWidthForSession();
		assert.equal(getEffectiveSpawnWidthLimit(), MAX_SPAWN_WIDTH);

		delete process.env.PI_SUBAGENT_SPAWN_WIDTH;
		initializeSpawnWidthForSession();
		assert.equal(getEffectiveSpawnWidthLimit(), MAX_SPAWN_WIDTH);
		assert.equal(tryAcquireSlots(MAX_SPAWN_WIDTH, getEffectiveSpawnWidthLimit()), true);
		assert.equal(tryAcquireSlots(1, getEffectiveSpawnWidthLimit()), false);
	});

	it("returns a recoverable refusal with a kill remedy at the live limit", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "1";
		initializeSpawnWidthForSession();
		assert.equal(tryAcquireSlots(1, getEffectiveSpawnWidthLimit()), true);
		let launches = 0;
		const tool = registerToolWithRuntime({
			launchBackgroundSubagent: async (params) => {
				launches++;
				return makeRunning(params.name);
			},
		});

		const result = await tool.execute("call-1", child("worker-a"), undefined, undefined, toolContext());
		assert.match(result.content[0].text, /Spawn width limit reached \(1\/1 slots busy\)/);
		assert.match(result.content[0].text, /subagent_kill/);
		assert.equal(launches, 0);
	});

	it("launches approved thinking overrides without model substitution", async () => {
		let launched: SubagentParamsInput | undefined;
		const tool = registerToolWithRuntime({
			loadAgentDefaults: () => ({ model: "provider/locked", spawning: true, allowModelOverride: false, thinkingOverrides: ["off", "low", "medium", "high"] }),
			launchBackgroundSubagent: async (params) => {
				launched = params;
				return makeRunning(params.name);
			},
		});
		await runAsRootCaller(() => tool.execute("call-override", { ...child("worker-a"), thinking: "off" }, undefined, undefined, toolContext()));
		assert.equal(launched?.model, undefined);
		assert.equal(launched?.thinking, "off");
	});

	it("rejects a spoofed model suffix in a batch before launching any child", async () => {
		let launches = 0;
		const tool = registerToolWithRuntime({
			loadAgentDefaults: () => ({ model: "provider/locked", spawning: true, allowModelOverride: false, thinkingOverrides: ["off", "low", "medium", "high"] }),
			launchBackgroundSubagent: async (params) => {
				launches++;
				return makeRunning(params.name);
			},
		});
		await runAsRootCaller(() => assert.rejects(() => tool.execute("call-batch", {
			children: [
				{ ...child("worker-a"), thinking: "off" },
				{ ...child("worker-b"), model: "provider/locked:off" },
			],
		}, undefined, undefined, toolContext()), /model override is not allowed/));
		assert.equal(launches, 0);
	});

	it("rejects an oversized batch before launching or acquiring slots", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "2";
		initializeSpawnWidthForSession();
		let launches = 0;
		const tool = registerToolWithRuntime({
			launchBackgroundSubagent: async (params) => {
				launches++;
				return makeRunning(params.name);
			},
		});

		const result = await tool.execute(
			"call-2",
			{ children: [child("worker-a"), child("worker-b"), child("worker-c")] },
			undefined,
			undefined,
			toolContext(),
		);
		assert.match(result.content[0].text, /batch of 3.*width limit.*2/i);
		assert.equal(launches, 0);
		assert.equal(getLiveSlotCount(), 0);
	});

	it("rolls back reservations for children that were not launched", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "3";
		initializeSpawnWidthForSession();
		let launches = 0;
		const tool = registerToolWithRuntime({
			launchBackgroundSubagent: async (params) => {
				launches++;
				if (launches === 2) throw new Error("launch failed");
				return makeRunning(params.name);
			},
		});

		await assert.rejects(
			tool.execute(
				"call-3",
				{ children: [child("worker-a"), child("worker-b"), child("worker-c")] },
				undefined,
				undefined,
				toolContext(),
			),
			/launch failed/,
		);
		assert.equal(launches, 2);
		assert.equal(getLiveSlotCount(), 1);
	});

	it("releases a claimed slot through the completion routing path", () => {
		assert.equal(tryAcquireSlots(1, 1), true);
		const running = makeRunning("completed-child");
		claimSpawnWidthSlot(running);
		setRunningSubagentForTest(running);
		routeSubagentOutcome({
			pi: { sendMessage() {} },
			running,
			result: makeResult(),
			formatElapsed: (elapsed) => `${elapsed}s`,
			updateWidget: () => {},
		});
		assert.equal(getLiveSlotCount(), 0);
	});
});
