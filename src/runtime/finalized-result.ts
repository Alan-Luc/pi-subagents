import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const FINALIZE_RESULT_REQUEST =
	"artifact-contracts:finalize-result:request:v1";
export const FINALIZE_RESULT_RESPONSE =
	"artifact-contracts:finalize-result:response:v1";
export const FINALIZED_RESULT_ENTRY = "artifact-contracts.finalized-result.v1";
export const DELEGATION_RESULT_REQUEST =
	"workflow:delegation-result:request:v1";
export const DELEGATION_RESULT_RESPONSE =
	"workflow:delegation-result:response:v1";
export const LAUNCH_BINDING_ENV = "PI_SUBAGENT_PUBLICATION_BINDING";

export type PublicationLaunchBinding = Readonly<{
	parentSessionId: string;
	parentLeafIdAtLaunch: string;
	launchToolCallId: string;
	childId: string;
	incarnationId: string;
	canonicalSessionFile: string;
	entryFloor: number;
}>;
export type FinalizedResultRef = Readonly<{
	state: "finalized";
	entryId: string;
	envelopeSha256: string;
	childSessionId: string;
	rootGeneration: string;
	incarnationId: string;
}>;
// Root owns these payloads' schemas and proof validity; this package only captures transport.
export type FinalizedResultEnvelope = Readonly<{
	version: 1;
	launchBinding: PublicationLaunchBinding;
	rootGeneration: string;
	assignment: Readonly<{
		sessionId: string;
		requestEntryId: string;
		branchEntryIds: readonly string[];
	}>;
	finalAssistantEntryId: string;
	resultSchemaId: string;
	validatedFields: unknown;
	renderedSha256: string;
	candidate: unknown;
	inputPins: readonly unknown[];
	proofs: readonly unknown[];
}>;
export type FinalizeResultRequest = Readonly<{
	version: 1;
	requestId: string;
	childSessionId: string;
	incarnationId: string;
	expectedLeafId: string;
	context: ExtensionContext;
}>;
export type FinalizeResultResponse = Readonly<{
	version: 1;
	requestId: string;
	childSessionId: string;
	incarnationId: string;
	rootGeneration: string;
	finalize: () => Promise<
		FinalizedResultRef | Readonly<{ state: "unavailable"; reason: string }>
	>;
}>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return (
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
export function isLaunchBinding(
	value: unknown,
): value is PublicationLaunchBinding {
	return (
		isRecord(value) &&
		exactKeys(value, [
			"parentSessionId",
			"parentLeafIdAtLaunch",
			"launchToolCallId",
			"childId",
			"incarnationId",
			"canonicalSessionFile",
			"entryFloor",
		]) &&
		[
			value.parentSessionId,
			value.parentLeafIdAtLaunch,
			value.launchToolCallId,
			value.childId,
			value.incarnationId,
			value.canonicalSessionFile,
		].every(nonempty) &&
		Number.isSafeInteger(value.entryFloor) &&
		Number(value.entryFloor) >= 0
	);
}
function sameLaunchBinding(
	left: PublicationLaunchBinding,
	right: PublicationLaunchBinding,
): boolean {
	return (
		left.parentSessionId === right.parentSessionId &&
		left.parentLeafIdAtLaunch === right.parentLeafIdAtLaunch &&
		left.launchToolCallId === right.launchToolCallId &&
		left.childId === right.childId &&
		left.incarnationId === right.incarnationId &&
		left.canonicalSessionFile === right.canonicalSessionFile &&
		left.entryFloor === right.entryFloor
	);
}
export function isFinalizedResultRef(
	value: unknown,
): value is FinalizedResultRef {
	return (
		isRecord(value) &&
		exactKeys(value, [
			"state",
			"entryId",
			"envelopeSha256",
			"childSessionId",
			"rootGeneration",
			"incarnationId",
		]) &&
		value.state === "finalized" &&
		[
			value.entryId,
			value.childSessionId,
			value.rootGeneration,
			value.incarnationId,
		].every(nonempty) &&
		typeof value.envelopeSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.envelopeSha256)
	);
}
export function canonicalSessionFile(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute
			? absolute
			: join(canonicalSessionFile(parent), basename(absolute));
	}
}
const invocationOwners = new Map<string, string>();
let proofRevision = 0;
export function publicationResultRevision(): number {
	return proofRevision;
}
export function notePublicationResultChange(): void {
	proofRevision++;
}
export function resetPublicationBindings(): void {
	invocationOwners.clear();
	proofRevision++;
}
export function revokePublicationBinding(sessionFile: string): void {
	invocationOwners.delete(canonicalSessionFile(sessionFile));
	proofRevision++;
}
export function isPublicationBindingCurrent(
	binding: PublicationLaunchBinding,
): boolean {
	return (
		invocationOwners.get(binding.canonicalSessionFile) === binding.incarnationId
	);
}
export function mintPublicationLaunchBinding(
	ctx: {
		sessionManager: { getSessionId(): string; getLeafId?(): string | null };
		launchToolCallId?: string;
	},
	childId: string,
	sessionFile: string,
	entryFloor: number,
	noSession: boolean,
): PublicationLaunchBinding | undefined {
	const parentLeafIdAtLaunch = ctx.sessionManager.getLeafId?.();
	if (noSession || !ctx.launchToolCallId || !parentLeafIdAtLaunch)
		return undefined;
	const binding = Object.freeze({
		parentSessionId: ctx.sessionManager.getSessionId(),
		parentLeafIdAtLaunch,
		launchToolCallId: ctx.launchToolCallId,
		childId,
		incarnationId: randomUUID(),
		canonicalSessionFile: canonicalSessionFile(sessionFile),
		entryFloor,
	});
	invocationOwners.set(binding.canonicalSessionFile, binding.incarnationId);
	proofRevision++;
	return binding;
}
export function readPublicationLaunchBinding(
	value = process.env[LAUNCH_BINDING_ENV],
): PublicationLaunchBinding | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isLaunchBinding(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function requestFinalizedResult(
	pi: Pick<ExtensionAPI, "events">,
	context: ExtensionContext,
	binding: PublicationLaunchBinding,
	timeoutMs = 5000,
): Promise<FinalizedResultRef | undefined> {
	const childSessionId = context.sessionManager.getSessionId();
	const expectedLeafId = context.sessionManager.getLeafId();
	if (
		!expectedLeafId ||
		canonicalSessionFile(context.sessionManager.getSessionFile() ?? "") !==
			binding.canonicalSessionFile
	)
		return undefined;
	const request: FinalizeResultRequest = {
		version: 1,
		requestId: randomUUID(),
		childSessionId,
		incarnationId: binding.incarnationId,
		expectedLeafId,
		context,
	};
	const responses: unknown[] = [];
	const off = pi.events.on(FINALIZE_RESULT_RESPONSE, (value) => {
		responses.push(value);
	});
	try {
		pi.events.emit(FINALIZE_RESULT_REQUEST, request);
	} catch {
		return undefined;
	} finally {
		off();
	}
	if (responses.length !== 1) return undefined;
	const response = responses[0];
	if (
		!isRecord(response) ||
		!exactKeys(response, [
			"version",
			"requestId",
			"childSessionId",
			"incarnationId",
			"rootGeneration",
			"finalize",
		]) ||
		response.version !== 1 ||
		response.requestId !== request.requestId ||
		response.childSessionId !== childSessionId ||
		response.incarnationId !== binding.incarnationId ||
		!nonempty(response.rootGeneration) ||
		typeof response.finalize !== "function"
	)
		return undefined;
	const finalize = response.finalize;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result: unknown = await Promise.race([
			Promise.resolve().then(() => finalize()),
			new Promise<undefined>((done) => {
				timer = setTimeout(() => done(undefined), timeoutMs);
			}),
		]);
		return isFinalizedResultRef(result) &&
			result.childSessionId === childSessionId &&
			result.incarnationId === binding.incarnationId &&
			result.rootGeneration === response.rootGeneration &&
			!context.signal?.aborted &&
			context.sessionManager.getSessionId() === childSessionId
			? Object.freeze({ ...result })
			: undefined;
	} catch {
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function freezeJson<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const nested of Object.values(value)) freezeJson(nested);
		Object.freeze(value);
	}
	return value;
}
export function envelopeSha256(envelope: unknown): string {
	return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

/** Capture only the referenced finalized entry, never a latest-summary approximation. */
export function captureFinalizedResult(
	sessionFile: string,
	binding: PublicationLaunchBinding,
	ref: FinalizedResultRef,
): FinalizedResultEnvelope | undefined {
	if (
		!isPublicationBindingCurrent(binding) ||
		!isFinalizedResultRef(ref) ||
		canonicalSessionFile(sessionFile) !== binding.canonicalSessionFile ||
		ref.incarnationId !== binding.incarnationId
	)
		return undefined;
	try {
		const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		const values: unknown[] = lines.map((line) => JSON.parse(line));
		const header = values[0];
		if (
			!isRecord(header) ||
			header.type !== "session" ||
			header.version !== 3 ||
			header.id !== ref.childSessionId
		)
			return undefined;
		const entries = new Map<
			string,
			{ entry: Record<string, unknown>; index: number }
		>();
		for (let index = 1; index < values.length; index++) {
			const entry = values[index];
			if (
				!isRecord(entry) ||
				entry.type === "session" ||
				!nonempty(entry.type) ||
				!nonempty(entry.id) ||
				entries.has(entry.id) ||
				!(
					entry.parentId === null ||
					(nonempty(entry.parentId) && entries.has(entry.parentId))
				)
			)
				return undefined;
			entries.set(entry.id, { entry, index });
		}
		const referenced = entries.get(ref.entryId);
		if (
			!referenced ||
			referenced.index < binding.entryFloor ||
			referenced.entry.type !== "custom" ||
			referenced.entry.customType !== FINALIZED_RESULT_ENTRY
		)
			return undefined;
		const envelope = referenced.entry.data;
		if (
			!isRecord(envelope) ||
			envelope.version !== 1 ||
			!isLaunchBinding(envelope.launchBinding) ||
			!sameLaunchBinding(envelope.launchBinding, binding) ||
			envelope.rootGeneration !== ref.rootGeneration ||
			envelopeSha256(envelope) !== ref.envelopeSha256 ||
			!isRecord(envelope.assignment) ||
			envelope.assignment.sessionId !== ref.childSessionId ||
			!nonempty(envelope.assignment.requestEntryId) ||
			!Array.isArray(envelope.assignment.branchEntryIds) ||
			!envelope.assignment.branchEntryIds.every(nonempty) ||
			!nonempty(envelope.finalAssistantEntryId) ||
			!nonempty(envelope.resultSchemaId) ||
			!nonempty(envelope.renderedSha256) ||
			!Array.isArray(envelope.inputPins) ||
			!Array.isArray(envelope.proofs) ||
			!exactKeys(envelope, [
				"version",
				"launchBinding",
				"rootGeneration",
				"assignment",
				"finalAssistantEntryId",
				"resultSchemaId",
				"validatedFields",
				"renderedSha256",
				"candidate",
				"inputPins",
				"proofs",
			])
		)
			return undefined;
		const branch: string[] = [];
		let cursor: unknown = (values.at(-1) as Record<string, unknown> | undefined)
			?.id;
		while (typeof cursor === "string") {
			const item = entries.get(cursor);
			if (!item) return undefined;
			branch.unshift(cursor);
			cursor = item.entry.parentId;
		}
		const refPosition = branch.indexOf(ref.entryId);
		const assistantPosition = branch.indexOf(envelope.finalAssistantEntryId);
		const requestPosition = branch.indexOf(envelope.assignment.requestEntryId);
		const requestEntry = entries.get(envelope.assignment.requestEntryId);
		const assistant = entries.get(envelope.finalAssistantEntryId)?.entry;
		if (
			requestPosition < 0 ||
			assistantPosition <= requestPosition ||
			refPosition <= assistantPosition ||
			!requestEntry ||
			requestEntry.index < binding.entryFloor ||
			!isRecord(requestEntry.entry.message) ||
			requestEntry.entry.message.role !== "user" ||
			!assistant ||
			assistant.type !== "message" ||
			!isRecord(assistant.message) ||
			assistant.message.role !== "assistant" ||
			assistant.message.stopReason !== "stop" ||
			envelope.assignment.branchEntryIds.some(
				(id, index) => branch[index] !== id,
			) ||
			branch
				.slice(assistantPosition + 1)
				.some((id) => entries.get(id)?.entry.type === "message")
		)
			return undefined;
		return freezeJson(structuredClone(envelope)) as FinalizedResultEnvelope;
	} catch {
		return undefined;
	}
}
