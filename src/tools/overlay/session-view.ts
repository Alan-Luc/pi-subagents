import { readCompleteSessionEntries, type SessionEntry } from "../../session/session.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitLine, renderScrollbar, sanitizeTerminalText, wrapPlainTextPreservingWhitespace } from "./render-helpers.ts";
import type { OverlayItem, Theme } from "./render-types.ts";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_TRANSCRIPT_CHARS = 50_000;
const MAX_TRANSCRIPT_LINES = 1_000;
const MAX_RENDER_LINES = 1_200;
const MESSAGE_OMISSION = "[message content omitted after 4000 characters]";
const TRANSCRIPT_OMISSION = "[transcript content omitted after the display limit]";

export type SessionTranscriptState =
	| "ready"
	| "no-session"
	| "missing"
	| "unreadable"
	| "malformed"
	| "boundary-unavailable";

export interface SessionTranscriptLine {
	kind: "role" | "text" | "tool" | "status";
	text: string;
}

export interface SessionTranscript {
	lines: SessionTranscriptLine[];
	status: string;
	state: SessionTranscriptState;
}

interface ReadOptions {
	live: boolean;
	noSession?: boolean;
	previous?: SessionTranscript;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function unavailable(
	state: Exclude<SessionTranscriptState, "ready" | "malformed">,
	status: string,
	previous?: SessionTranscript,
): SessionTranscript {
	return {
		lines: previous?.lines ?? [],
		status,
		state,
	};
}

export function readSessionTranscript(sessionFile: string | undefined, options: ReadOptions): SessionTranscript {
	if (options.noSession || !sessionFile) {
		return unavailable("no-session", "No session was recorded for this agent.");
	}

	try {
		const read = readCompleteSessionEntries(sessionFile);
		const activityStart = activityStartIndex(read.entries);
		if (activityStart === undefined) {
			return unavailable(
				"boundary-unavailable",
				"Session activity boundary is unavailable; inherited history was not rendered.",
			);
		}
		const lines = formatSessionEntries(read.entries.slice(activityStart));
		const notices: string[] = [];
		if (read.malformedLines > 0) notices.push("Some malformed session records were ignored.");
		if (read.incompleteTrailingLine) notices.push("The newest incomplete record was omitted.");

		if (lines.length === 0 && options.previous?.lines.length) {
			return {
				lines: options.previous.lines,
				status: `${notices.join(" ")} Showing the previous display while the session is being written.`.trim(),
				state: read.malformedLines > 0 ? "malformed" : "ready",
			};
		}

		return {
			lines,
			status:
				notices.join(" ") ||
					(lines.length > 0 ? "Live session transcript." : options.live ? "Waiting for session records…" : "No readable session records."),
			state: read.malformedLines > 0 ? "malformed" : "ready",
		};
	} catch (error) {
		const missing = errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
		if (missing) {
			return unavailable(
				"missing",
				options.previous?.lines.length && options.live
					? "Session file disappeared; showing the previous display and retrying."
					: options.live
						? "Session file is not available yet; retrying while the agent runs."
						: "Session file is unavailable.",
				options.previous,
			);
		}
		return unavailable(
			"unreadable",
			options.previous?.lines.length && options.live
				? "Session file became unreadable; showing the previous display and retrying."
				: options.live
					? "Session file is unreadable; retrying while the agent runs."
					: "Session file is unreadable.",
			options.previous,
		);
	}
}

function messageContent(entry: SessionEntry): Record<string, unknown> | undefined {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return undefined;
	return entry.message as Record<string, unknown>;
}

function contentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(message.content)
		? message.content.filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
		: [];
}

function textBlocks(message: Record<string, unknown>): string[] {
	if (typeof message.content === "string") return message.content.length > 0 ? [message.content] : [];
	return contentBlocks(message)
		.filter((block) => block.type === "text" && typeof block.text === "string" && block.text.length > 0)
		.map((block) => block.text as string);
}

const SENSITIVE_KEYS = "password|passwd|secret|token|api[_-]?key|authorization|cookie";
const SENSITIVE_QUOTED_ASSIGNMENT = new RegExp(
	`(\\b(?:${SENSITIVE_KEYS})\\b\\s*(?:["']?\\s*:\\s*|=\\s*|\\bis\\s+))("[^"\\r\\n]*"|'[^'\\r\\n]*')`,
	"gi",
);
const SENSITIVE_ASSIGNMENT = new RegExp(
	`(\\b(?:${SENSITIVE_KEYS})\\b\\s*(?:["']?\\s*:\\s*|=\\s*|\\bis\\s+))(\\[REDACTED\\]|[^\\s,;}\\]"']+)`,
	"gi",
);
const BEARER_OR_BASIC = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+={0,2}/gi;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g;

/** Best-effort coverage for common credential forms; this is not arbitrary-secret detection. */
export function redactSensitiveText(text: string): string {
	return text
		.replace(PEM_PRIVATE_KEY, "[REDACTED]")
		.replace(BEARER_OR_BASIC, "[REDACTED]")
		.replace(SENSITIVE_QUOTED_ASSIGNMENT, (_match, prefix: string, quoted: string) =>
			`${prefix}${quoted[0]}[REDACTED]${quoted[quoted.length - 1]}`,
		)
		.replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
		.replace(OPENAI_TOKEN, "[REDACTED]")
		.replace(GITHUB_TOKEN, "[REDACTED]")
		.replace(AWS_ACCESS_KEY, "[REDACTED]")
		.replace(JWT, "[REDACTED]");
}

function safeVisibleText(text: string): string {
	return redactSensitiveText(sanitizeTerminalText(text));
}

function validLaunchMarker(entry: SessionEntry): boolean {
	if (entry.type !== "custom" || entry.customType !== "pi-subagents_launch_metadata") return false;
	const data = entry.data;
	return (
		typeof data === "object" &&
		data !== null &&
		(data as Record<string, unknown>).version === 1 &&
		((data as Record<string, unknown>).mode === "interactive" || (data as Record<string, unknown>).mode === "background")
	);
}

function activityStartIndex(entries: SessionEntry[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (validLaunchMarker(entries[index])) return index + 1;
	}

	const header = entries.find((entry) => entry.type === "session");
	const parentSession = header?.parentSession;
	const inherited =
		(typeof parentSession === "string" && parentSession.trim() !== "") ||
		(parentSession !== undefined && parentSession !== null && typeof parentSession !== "string");
	return inherited ? undefined : 0;
}

function boundedToolName(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "tool";
	return value.slice(0, 120);
}

function isToolError(message: Record<string, unknown>): boolean {
	return message.isError === true || message.error === true || message.status === "error" || message.status === "failed";
}

function formatBashExecution(message: Record<string, unknown>): string {
	const exitCode = typeof message.exitCode === "number" && Number.isSafeInteger(message.exitCode) ? message.exitCode : undefined;
	const status = typeof message.status === "string" ? message.status.toLowerCase() : "";
	const failed = message.cancelled === true || isToolError(message) || (exitCode !== undefined && exitCode !== 0);
	if (failed) return `Bash execution error${exitCode === undefined ? "" : ` (exit ${exitCode})`}`;
	if (exitCode !== undefined || status === "completed" || status === "done" || status === "success") {
		return `Bash execution completed${exitCode === undefined ? "" : ` (exit ${exitCode})`}`;
	}
	return "Bash execution running";
}

function formatSessionEntries(entries: SessionEntry[]): SessionTranscriptLine[] {
	const lines: SessionTranscriptLine[] = [];
	let usedChars = 0;
	let omitted = false;

	const omit = () => {
		if (omitted) return;
		omitted = true;
		lines.unshift({ kind: "status", text: TRANSCRIPT_OMISSION });
		usedChars += TRANSCRIPT_OMISSION.length + 1;
	};

	const add = (kind: SessionTranscriptLine["kind"], text: string): boolean => {
		if (!omitted && (lines.length >= MAX_TRANSCRIPT_LINES || usedChars + text.length + 1 > MAX_TRANSCRIPT_CHARS)) omit();
		while (lines.length >= MAX_TRANSCRIPT_LINES || usedChars + text.length + 1 > MAX_TRANSCRIPT_CHARS) {
			const removeIndex = omitted ? 1 : 0;
			const removed = lines.splice(removeIndex, 1)[0];
			if (!removed) return false;
			usedChars -= removed.text.length + 1;
		}
		lines.push({ kind, text });
		usedChars += text.length + 1;
		return true;
	};

	const addMessageText = (message: Record<string, unknown>): boolean => {
		let remaining = 0;
		for (const text of textBlocks(message)) {
			const safeText = safeVisibleText(text);
			const available = Math.max(0, MAX_MESSAGE_CHARS - remaining);
			const bounded = safeText.slice(0, available);
			remaining += bounded.length;
			for (const line of bounded.split(/\r?\n/)) {
				if (!add("text", line)) return false;
			}
			if (safeText.length > available) {
				if (!add("status", MESSAGE_OMISSION)) return false;
				return true;
			}
		}
		return true;
	};

	for (const entry of entries) {
		const message = messageContent(entry);
		if (!message) continue;
		const role = message.role;
		if (role === "user") {
			if (!textBlocks(message).length) continue;
			if (!add("role", "User") || !addMessageText(message)) break;
			continue;
		}
		if (role === "assistant") {
			const blocks = contentBlocks(message);
			const hasText = textBlocks(message).length > 0;
			const calls = blocks.filter((block) => block.type === "toolCall" || block.type === "toolUse");
			const stopReason = typeof message.stopReason === "string" ? message.stopReason.slice(0, 80) : "";
			if (!hasText && calls.length === 0 && !stopReason) continue;
			if (!add("role", "Assistant") || !addMessageText(message)) break;
			for (const call of calls) {
				if (!add("tool", `Call: ${redactSensitiveText(boundedToolName(call.name))}`)) break;
			}
			if (stopReason) {
				const status = stopReason === "error" ? "Assistant error" : `Assistant stopped: ${stopReason}`;
				if (!add("status", status)) break;
			}
			continue;
		}
		if (role === "toolResult") {
			const name = redactSensitiveText(boundedToolName(message.toolName));
			add("tool", `Tool ${isToolError(message) ? "✕" : "✓"} ${name} ${isToolError(message) ? "error" : "completed"}`);
			continue;
		}
		if (role === "bashExecution") add("status", formatBashExecution(message));
	}

	return lines;
}

function buildContentLines(item: OverlayItem, transcript: SessionTranscript, theme: Theme, width: number): string[] {
	const contentWidth = Math.max(10, width - 5);
	const lines: string[] = [
		` ${theme.fg("accent", "▸")} ${theme.bold(theme.fg("accent", `Session: ${safeVisibleText(item.name)}`))}`,
		`   ${theme.fg("muted", sanitizeTerminalText(transcript.status))}`,
		"",
	];
	let renderedTranscriptLines = 0;
	for (const line of transcript.lines) {
		if (renderedTranscriptLines >= MAX_RENDER_LINES) {
			lines.push(`   ${theme.fg("muted", TRANSCRIPT_OMISSION)}`);
			break;
		}
		const text = safeVisibleText(line.text);
		const prefix = line.kind === "role" ? "   " : line.kind === "text" ? "      " : "   ";
		const wrapped = wrapPlainTextPreservingWhitespace(text, contentWidth - visibleWidth(prefix), MAX_RENDER_LINES - renderedTranscriptLines);
		for (const value of wrapped) {
			if (renderedTranscriptLines >= MAX_RENDER_LINES) break;
			const styled =
				line.kind === "role"
					? theme.bold(theme.fg("accent", value))
					: line.kind === "tool"
						? theme.fg("dim", value)
						: line.kind === "status"
							? theme.fg("warning", value)
							: theme.fg("text", value);
			lines.push(`${prefix}${styled}`);
			renderedTranscriptLines++;
		}
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function getSessionMaxScroll(item: OverlayItem, transcript: SessionTranscript, theme: Theme, width: number, maxHeight: number): number {
	return Math.max(0, buildContentLines(item, transcript, theme, width).length - maxHeight);
}

export function renderSession(
	item: OverlayItem,
	transcript: SessionTranscript,
	scroll: number,
	theme: Theme,
	width: number,
	maxHeight: number,
): string[] {
	const contentLines = buildContentLines(item, transcript, theme, width);
	const visibleHeight = Math.min(maxHeight, contentLines.length);
	const clampedScroll = Math.max(0, Math.min(scroll, Math.max(0, contentLines.length - visibleHeight)));
	return contentLines.slice(clampedScroll, clampedScroll + visibleHeight).map((line, index) => {
		const content = fitLine(line, Math.max(1, width - 2));
		const gutter = renderScrollbar(index, visibleHeight, contentLines.length, clampedScroll, theme);
		return truncateToWidth(`${content} ${gutter}`, width);
	});
}
