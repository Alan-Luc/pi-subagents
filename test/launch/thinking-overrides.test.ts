import {
	assert,
	createTestDir,
	describe,
	getEffectiveAgentDefinitionsForTest,
	it,
	join,
	mkdirSync,
	resolveResumeLaunchMetadataForInvocationForTest,
	writeFileSync,
} from "../support/index.ts";
import { enforceAgentFrontmatter } from "../../src/launch/policy.ts";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";
import { mergeResumeInvocationMetadata, resolveResumeLaunchMetadataForInvocation } from "../../src/runtime/resume-service.ts";
import { getPersistedSessionParityArgs } from "../../src/launch/prep.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";

const params = {
	name: "risk-check",
	task: "Run the requested check",
	title: "Run requested check",
	agent: "test-automation-engineer",
};

describe("thinking-only task effort overrides", () => {
	it("advertises the approved effort boundary in the actual resume tool definition", () => {
		const tools: Array<{ promptSnippet: string; parameters: { properties: Record<string, { description: string }> } }> = [];
		registerSubagentResumeTool({
			registerTool: (definition: typeof tools[number]) => tools.push(definition),
		} as never, () => true, {} as never);
		const tool = tools[0];
		assert.ok(tool);
		assert.match(tool.promptSnippet, /original launch explicitly opted into an approved task\/risk thinking-overrides list/);
		assert.match(tool.parameters.properties.model.description, /Rejected when allow-model-override: false/);
		assert.match(tool.parameters.properties.thinking.description, /forbidden or unsupported levels are rejected/);
	});

	it("allows an opted-in effort while preserving the locked model", () => {
		const result = enforceAgentFrontmatter({ ...params, thinking: "off" }, {
			model: "anthropic/claude-sonnet-5",
			thinking: "high",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
		});
		assert.equal(result.model, undefined);
		assert.equal(result.thinking, "off");
	});

	it("keeps pinned defaults when no override is requested", () => {
		const result = enforceAgentFrontmatter(params, {
			model: "anthropic/claude-sonnet-5",
			thinking: "high",
			allowModelOverride: false,
		});
		assert.equal(result.model, undefined);
		assert.equal(result.thinking, undefined);
	});

	it("does not silently ignore a replacement model when the model is locked", () => {
		assert.throws(() => enforceAgentFrontmatter({ ...params, model: "other/model" }, {
			model: "anthropic/claude-sonnet-5",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
		}), /model override is not allowed/);
	});

	it("rejects an effort outside the configured allowlist", () => {
		assert.throws(() => enforceAgentFrontmatter({ ...params, thinking: "xhigh" }, {
			model: "anthropic/claude-sonnet-5",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
		}), /not allowed/);
	});

	it("rejects thinking embedded in a replacement-model suffix", () => {
		assert.throws(() => enforceAgentFrontmatter({ ...params, model: "anthropic/claude-sonnet-5:off" }, {
			model: "anthropic/claude-sonnet-5",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
		}), /model override is not allowed/);
	});

	it("rejects an unopted reviewer override", () => {
		assert.throws(() => enforceAgentFrontmatter({ ...params, thinking: "off" }, {
			model: "anthropic/claude-sonnet-5",
			allowModelOverride: false,
		}), /thinking override is not allowed/);
	});

	it("allows only explicitly permitted resume effort on the persisted model", () => {
		const base = {
			version: 1 as const,
			timestamp: "2026-10-23T00:00:00.000Z",
			name: "test-automation-engineer",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			model: "anthropic/claude-sonnet-5",
			modelRef: "anthropic/claude-sonnet-5:high",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};
		const changed = resolveResumeLaunchMetadataForInvocationForTest(base, undefined, {
			getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" } }],
		}, "off");
		assert.equal(changed?.modelRef, "anthropic/claude-sonnet-5:off");
		assert.equal(changed?.thinking, "off");
		assert.equal(changed?.modelSource, "resume-override");
		const unlocked = { ...base, allowModelOverride: true };
		assert.equal(resolveResumeLaunchMetadataForInvocation(unlocked, undefined, undefined), unlocked, "a no-override unlocked resume must not create or persist an override");
	});

	it("checks an opted-in level against the selected model's installed support metadata", async () => {
		const dir = createTestDir();
		const launchParams = { ...params, thinking: "off" };
		const agentDefs = {
			model: "anthropic/claude-sonnet-5",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"] as const,
		};
		const base = { params: launchParams, agentDefs, parentCwd: dir, parentSessionDir: dir };
		const supported = await buildChildLaunchPlan({
			...base,
			modelRegistry: {
				getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { off: "none" } }],
			},
		});
		assert.equal(supported.effectiveModelRef, "anthropic/claude-sonnet-5:off");
		await assert.rejects(() => buildChildLaunchPlan({
			...base,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { off: null, high: "high" } }] },
		}), /does not support thinking level 'off'/);
	});

	it("uses explicit allowed effort instead of the locked definition's thinking suffix", async () => {
		const dir = createTestDir();
		const plan = await buildChildLaunchPlan({
			params: { ...params, thinking: "off" },
			agentDefs: {
				model: "anthropic/claude-sonnet-5:high",
				allowModelOverride: false,
				thinkingOverrides: ["off", "low", "medium", "high"],
			},
			parentCwd: dir,
			parentSessionDir: dir,
			modelRegistry: {
				getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { off: "none", high: "high" } }],
			},
		});
		assert.equal(plan.effectiveModel, "anthropic/claude-sonnet-5");
		assert.equal(plan.effectiveThinking, "off");
		assert.equal(plan.effectiveModelRef, "anthropic/claude-sonnet-5:off");
	});

	it("anchors resumed opt-in and model identity to the original launch entry", () => {
		const launch = {
			version: 1 as const,
			timestamp: "2026-10-23T00:00:00.000Z",
			name: "test-automation-engineer",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			model: "anthropic/claude-sonnet-5",
			thinking: "high",
			modelRef: "anthropic/claude-sonnet-5:high",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};
		const forged = mergeResumeInvocationMetadata(launch, {
			...launch,
			model: "other/model",
			modelRef: "other/model:off",
			allowModelOverride: true,
			thinkingOverrides: ["off"],
		});
		assert.equal(forged.allowModelOverride, false);
		assert.equal(forged.model, launch.model);
		assert.equal(forged.modelRef, launch.modelRef);
		assert.deepEqual(forged.thinkingOverrides, launch.thinkingOverrides);
		const forgedEffort = mergeResumeInvocationMetadata(launch, { ...launch, thinking: "xhigh" });
		assert.equal(forgedEffort.thinking, "high");
		assert.equal(forgedEffort.modelRef, launch.modelRef);
		const forgedProvider = mergeResumeInvocationMetadata(launch, {
			...launch,
			model: "other/claude-sonnet-5",
			thinking: "low",
			modelRef: "other/claude-sonnet-5:low",
		});
		assert.equal(forgedProvider.thinking, "high");
		assert.equal(forgedProvider.modelRef, launch.modelRef);

		const effortChange = mergeResumeInvocationMetadata(launch, {
			...launch,
			thinking: "off",
			modelRef: "anthropic/claude-sonnet-5:off",
		});
		assert.equal(effortChange.model, launch.model);
		assert.equal(effortChange.modelRef, "anthropic/claude-sonnet-5:off");
	});

	it("rejects locked thinking unsupported by installed metadata on a no-override resume", () => {
		const launch = {
			version: 1 as const,
			timestamp: "2026-10-23T00:00:00.000Z",
			name: "reviewer",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			model: "anthropic/claude-sonnet-5",
			thinking: "high",
			modelRef: "anthropic/claude-sonnet-5:high",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};
		const metadata = mergeResumeInvocationMetadata(launch, {
			...launch,
			thinking: "off",
			modelRef: "anthropic/claude-sonnet-5:off",
		});
		assert.throws(
			() => resolveResumeLaunchMetadataForInvocation(metadata, undefined, undefined, {
				getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { off: null, high: "high" } }],
			}),
			/does not support thinking level 'off'/,
		);
	});

	it("keeps an approved effort when a bare locked model becomes provider-qualified", async () => {
		const launch = {
			version: 1 as const,
			timestamp: "2026-10-23T00:00:00.000Z",
			name: "reviewer",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			model: "claude-sonnet-5",
			thinking: "high",
			modelRef: "claude-sonnet-5:high",
			allowModelOverride: false,
			thinkingOverrides: ["low"],
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};
		const registry = {
			getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { low: "low", high: "high" } }],
		};
		const metadata = mergeResumeInvocationMetadata(launch, {
			...launch,
			model: "anthropic/claude-sonnet-5",
			thinking: "low",
			modelRef: "anthropic/claude-sonnet-5:low",
		}, registry);
		const resumed = resolveResumeLaunchMetadataForInvocation(metadata, undefined, undefined, registry);
		assert.deepEqual(await getPersistedSessionParityArgs(resumed), ["--model", "anthropic/claude-sonnet-5:low", "--no-approve"]);

	});

	for (const scenario of [
		{
			description: "executes low when only low is allowed despite a contradictory off suffix",
			launchThinking: "low", allowedThinking: ["low"], laterThinking: "low",
			laterModelRef: "anthropic/claude-sonnet-5:off", expectedModelRef: "anthropic/claude-sonnet-5:low",
		},
		{
			description: "executes allowed off instead of a forbidden xhigh suffix",
			launchThinking: "low", allowedThinking: ["off"], laterThinking: "off",
			laterModelRef: "anthropic/claude-sonnet-5:xhigh", expectedModelRef: "anthropic/claude-sonnet-5:off",
		},
		{
			description: "executes allowed low when later metadata retains the launch high suffix",
			launchThinking: "high", allowedThinking: ["low"], laterThinking: "low",
			laterModelRef: "anthropic/claude-sonnet-5:high", expectedModelRef: "anthropic/claude-sonnet-5:low",
		},
		{
			description: "executes allowed low when later metadata omits its executable reference",
			launchThinking: "high", allowedThinking: ["low"], laterThinking: "low",
			laterModelRef: undefined, expectedModelRef: "anthropic/claude-sonnet-5:low",
		},
	]) {
		it(scenario.description, async () => {
			const launch = {
				version: 1 as const,
				timestamp: "2026-10-23T00:00:00.000Z",
				name: "test-automation-engineer",
				mode: "background" as const,
				sessionMode: "lineage-only" as const,
				parentClosePolicy: "terminate" as const,
				async: true,
				model: "anthropic/claude-sonnet-5",
				thinking: scenario.launchThinking,
				modelRef: `anthropic/claude-sonnet-5:${scenario.launchThinking}`,
				allowModelOverride: false,
				thinkingOverrides: scenario.allowedThinking,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			};
			const registry = { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { off: "none", low: "low", high: "high" } }] };
			const metadata = mergeResumeInvocationMetadata(launch, {
				...launch,
				thinking: scenario.laterThinking,
				modelRef: scenario.laterModelRef,
			});
			const resumed = resolveResumeLaunchMetadataForInvocation(metadata, undefined, undefined, registry);
			assert.deepEqual(await getPersistedSessionParityArgs(resumed), ["--model", scenario.expectedModelRef, "--no-approve"]);
		});
	}

	it("rejects unsupported and malformed effort metadata at definition load", () => {
		const configDir = createTestDir();
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = configDir;
		try {
			writeFileSync(join(agentsDir, "valid.md"), "---\nname: valid\nallow-model-override: false\nthinking-overrides: off, low, medium, high\n---\nWorker.");
			assert.deepEqual(getEffectiveAgentDefinitionsForTest().find((agent) => agent.name === "valid")?.thinkingOverrides, ["off", "low", "medium", "high"]);
			for (const value of ["xhigh", "off,", "", "off,high,unknown"]) {
				writeFileSync(join(agentsDir, "invalid.md"), `---\nname: invalid\nallow-model-override: false\nthinking-overrides: ${value}\n---\nWorker.`);
				assert.throws(() => getEffectiveAgentDefinitionsForTest(), /thinking-overrides must be/);
			}
			writeFileSync(join(agentsDir, "invalid.md"), "---\nname: invalid\nallow-model-override: false\nthinking-overrides: low\n---\nWorker.");
			writeFileSync(join(agentsDir, "unlocked.md"), "---\nname: unlocked\nthinking-overrides: off\n---\nWorker.");
			assert.throws(() => getEffectiveAgentDefinitionsForTest(), /thinking-overrides requires allow-model-override: false/);
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		}
	});

	it("rejects forbidden or unsupported resume overrides rather than ignoring them", () => {
		const base = {
			version: 1 as const,
			timestamp: "2026-10-23T00:00:00.000Z",
			name: "reviewer",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			model: "anthropic/claude-sonnet-5",
			modelRef: "anthropic/claude-sonnet-5:high",
			allowModelOverride: false,
			thinkingOverrides: ["off", "low", "medium", "high"],
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};
		assert.throws(() => resolveResumeLaunchMetadataForInvocationForTest(base, "other/model"), /Model override is not allowed/);
		assert.throws(() => resolveResumeLaunchMetadataForInvocationForTest(base, undefined, {
			getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5", thinkingLevelMap: { off: null, high: "high" } }],
		}, "off"), /does not support thinking level 'off'/);
	});
});
