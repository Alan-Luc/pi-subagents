import { accessSync, constants, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { ORCHESTRATOR_ARTIFACT_TOOL_NAMES } from "../tools/tool-names.ts";
import { filterOrchestratorTools } from "./orchestrator-policy.ts";

export const ARTIFACT_CAPABILITY_VERSION = 1 as const;
export const ARTIFACT_CAPABILITY_REQUEST_CHANNEL =
	"artifact-contracts:capability-request";
export const ARTIFACT_CAPABILITY_CHANNEL = "artifact-contracts:capability";

export type ArtifactOperation = "read" | "write" | "edit";

type ArtifactPathKind = "plan" | "daily" | "topic" | "handoff" | "report";

const ARTIFACT_PATH_PATTERNS: Readonly<Record<ArtifactPathKind, RegExp>> = {
	plan: /^\.harness\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
	daily: /^\.harness\/\d{4}\/\d{2}\/\d{2}\.md$/,
	topic: /^\.harness\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
	handoff:
		/^\.harness\/handoffs\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
	report:
		/^\.harness\/reports\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function artifactPathKind(path: string): ArtifactPathKind | undefined {
	for (const [kind, pattern] of Object.entries(ARTIFACT_PATH_PATTERNS) as [
		ArtifactPathKind,
		RegExp,
	][]) {
		if (pattern.test(path)) return kind;
	}
	return undefined;
}

function isArtifactOperation(toolName: string): toolName is ArtifactOperation {
	return (
		ORCHESTRATOR_ARTIFACT_TOOL_NAMES.has(toolName) &&
		(toolName === "read" || toolName === "write" || toolName === "edit")
	);
}

/** Check the exact version-1 artifact path and operation grammar. */
export function isArtifactCapabilityPath(
	operation: ArtifactOperation,
	path: string,
	features: Readonly<{ topicLogs?: number }> = {},
): boolean {
	const kind = artifactPathKind(path);
	if (!kind) return false;
	if (kind === "plan") return true;
	if (kind === "daily") return operation === "read";
	if (kind === "topic") return operation === "read" && features.topicLogs === 1;
	if (kind === "handoff") return operation === "read" || operation === "write";
	return operation === "read" || operation === "write" || operation === "edit";
}

/** Return artifact tools that may remain active for one normal-tool baseline. */
export function getOrchestratorArtifactTools(
	normalActiveTools: readonly string[],
	mutationsAvailable: boolean,
): ReadonlySet<string> {
	const baseline = new Set(normalActiveTools);
	const allowed = new Set<string>();
	if (baseline.has("read")) allowed.add("read");
	if (mutationsAvailable) {
		for (const operation of ["write", "edit"] as const) {
			if (baseline.has(operation)) allowed.add(operation);
		}
	}
	return allowed;
}

function isCompatibleCapability(payload: unknown): boolean {
	return (
		isRecord(payload) &&
		payload.version === ARTIFACT_CAPABILITY_VERSION &&
		payload.mutations === true
	);
}

function isMissingError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isContained(boundary: string, candidate: string): boolean {
	const nested = relative(boundary, candidate);
	return (
		Boolean(nested) &&
		nested !== ".." &&
		!nested.startsWith(`..${sep}`) &&
		!isAbsolute(nested)
	);
}

function canRetargetSymlink(path: string): boolean {
	try {
		accessSync(dirname(path), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function rejectSymlinkComponents(
	absolutePath: string,
	boundary: string,
	requestedPath: string,
): string | undefined {
	let insideBoundary = true;
	for (let current = absolutePath; ; current = dirname(current)) {
		try {
			if (
				lstatSync(current).isSymbolicLink() &&
				(insideBoundary || canRetargetSymlink(current))
			) {
				return `Blocked artifact path ${JSON.stringify(requestedPath)}: symlink component ${JSON.stringify(current)} is not allowed.`;
			}
		} catch (error: unknown) {
			if (!isMissingError(error)) {
				const detail = error instanceof Error ? error.message : String(error);
				return `Cannot inspect artifact path ${JSON.stringify(requestedPath)} at ${JSON.stringify(current)}: ${detail}`;
			}
		}
		if (current === boundary) insideBoundary = false;
		const parent = dirname(current);
		if (parent === current) return undefined;
	}
}

function blocked(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

function checkArtifactToolCall(
	event: Pick<ToolCallEvent, "toolName" | "input">,
	ctx: Pick<ExtensionContext, "cwd">,
	normalActiveTools: readonly string[],
	mutationsAvailable: boolean,
	topicLogsAvailable: boolean,
): ToolCallEventResult | undefined {
	if (!isArtifactOperation(event.toolName)) return undefined;
	if (!normalActiveTools.includes(event.toolName)) {
		return blocked(
			`Orchestrator tool ${JSON.stringify(event.toolName)} was not present in the normal active-tool baseline.`,
		);
	}
	if (event.toolName !== "read" && !mutationsAvailable) {
		return blocked(
			`Orchestrator ${JSON.stringify(event.toolName)} requires a compatible artifact capability version ${ARTIFACT_CAPABILITY_VERSION}.`,
		);
	}
	const input: unknown = event.input;
	if (!isRecord(input)) {
		return blocked(
			`Orchestrator ${JSON.stringify(event.toolName)} requires a record input with a string path.`,
		);
	}
	const requestedPath = input.path;
	if (typeof requestedPath !== "string") {
		return blocked(
			`Orchestrator ${JSON.stringify(event.toolName)} requires a record input with a string path.`,
		);
	}
	if (!isArtifactCapabilityPath(event.toolName, requestedPath, topicLogsAvailable ? { topicLogs: 1 } : {})) {
		return blocked(
			`Blocked ${JSON.stringify(event.toolName)} path ${JSON.stringify(requestedPath)}: only the canonical artifact version-1 paths are allowed.`,
		);
	}

	const boundary = resolve(ctx.cwd);
	const absolutePath = resolve(boundary, requestedPath);
	const relativePath = relative(boundary, absolutePath).replaceAll("\\", "/");
	if (!isContained(boundary, absolutePath) || relativePath !== requestedPath) {
		return blocked(
			`Blocked artifact path ${JSON.stringify(requestedPath)}: it is not canonical and lexically contained by cwd ${JSON.stringify(boundary)}.`,
		);
	}
	const symlinkReason = rejectSymlinkComponents(
		absolutePath,
		boundary,
		requestedPath,
	);
	return symlinkReason ? blocked(symlinkReason) : undefined;
}

export interface OrchestratorArtifactGate {
	readonly hasCompatibleCapability: () => boolean;
	readonly allowedToolNames: (
		normalActiveTools: readonly string[],
	) => ReadonlySet<string>;
	readonly filterToolNames: (
		toolNames: readonly string[],
		normalActiveTools: readonly string[],
	) => string[];
	readonly refreshToolNames: (
		normalActiveTools: readonly string[],
		currentTools: readonly string[],
	) => string[];
	readonly handleToolCall: (
		event: Pick<ToolCallEvent, "toolName" | "input">,
		ctx: Pick<ExtensionContext, "cwd">,
		normalActiveTools: readonly string[],
	) => ToolCallEventResult | undefined;
}

/** Listen before requesting so package-first and root-first loading both converge. */
const NO_ARTIFACT_CAPABILITY_EVENTS: ExtensionAPI["events"] = {
	on: () => () => undefined,
	emit: () => undefined,
};

export function createOrchestratorArtifactGate(
	events: ExtensionAPI["events"] | undefined,
): OrchestratorArtifactGate {
	let mutationsAvailable = false;
	let topicLogsAvailable = false;
	events ??= NO_ARTIFACT_CAPABILITY_EVENTS;
	events.on(ARTIFACT_CAPABILITY_CHANNEL, (payload) => {
		mutationsAvailable = isCompatibleCapability(payload);
		topicLogsAvailable = mutationsAvailable && isRecord(payload) && payload.topicLogs === 1;
	});
	events.emit(ARTIFACT_CAPABILITY_REQUEST_CHANNEL, {});
	return {
		hasCompatibleCapability: () => mutationsAvailable,
		allowedToolNames: (normalActiveTools) =>
			getOrchestratorArtifactTools(normalActiveTools, mutationsAvailable),
		filterToolNames: (toolNames, normalActiveTools) =>
			filterOrchestratorTools(
				toolNames,
				getOrchestratorArtifactTools(normalActiveTools, mutationsAvailable),
			),
		refreshToolNames: (normalActiveTools, currentTools) =>
			filterOrchestratorTools(
				[
					...normalActiveTools,
					...currentTools.filter((name) => !normalActiveTools.includes(name)),
				],
				getOrchestratorArtifactTools(normalActiveTools, mutationsAvailable),
			),
		handleToolCall: (event, ctx, normalActiveTools) =>
			checkArtifactToolCall(event, ctx, normalActiveTools, mutationsAvailable, topicLogsAvailable),
	};
}
