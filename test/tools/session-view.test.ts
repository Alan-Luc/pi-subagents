import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTranscript, renderSession } from "../../src/tools/overlay/session-view.ts";
import { assert, describe, it } from "../support/index.ts";

const theme = { fg: (_tone: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const item = {
	id: "session",
	icon: "●",
	iconColor: "accent",
	name: "scout",
	stats: [],
	activity: "",
	detailSections: [],
	canKill: false,
	canResume: false,
};

function renderTranscript(file: string): string {
	const transcript = readSessionTranscript(file, { live: false });
	return renderSession(item, transcript, 0, theme, 120, 2_000).join("\n");
}

function writeRecords(file: string, records: unknown[]): void {
	writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("session viewer transcript", () => {
	it("supports string content, redacts covered credentials, and keeps ordinary text", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-view-security-"));
		const file = join(dir, "session.jsonl");
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature12345";
		const visible = [
			"password=pass-one passwd: pass-two secret: pass-three token=pass-four",
			"api_key: key-one api-key=key-two authorization: Bearer bearer-value cookie=crumb",
			"Bearer direct-value Basic ZGVtbzpwYXNz sk-proj-abcdefghijklmnop ghp_12345678901234567890",
			`github_pat_12345678901234567890 AKIAIOSFODNN7EXAMPLE ${jwt}`,
			"-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----",
		].join(" ");
		writeRecords(file, [
			{ type: "message", id: "user", message: { role: "user", content: "User string content" } },
			{ type: "message", id: "assistant", message: { role: "assistant", content: visible } },
			{
				type: "message",
				id: "json-assistant",
				message: {
					role: "assistant",
					content: '{"password":"json-secret","api_key":"json-key","note":"visible"}',
				},
			},
			{
				type: "message",
				id: "tool",
				message: {
					role: "toolResult",
					toolName: "read_file",
					content: [{ type: "text", text: "raw tool result must stay hidden" }],
					arguments: { token: "raw argument must stay hidden" },
				},
			},
			{
				type: "message",
				id: "ordinary",
				message: {
					role: "assistant",
					content:
						'A token bucket, authorization header, secret sauce, cookie cutter, and password reset are ordinary text. {"tokenizer":"visible-token","note":"token bucket"}',
				},
			},
		]);

		const rendered = renderTranscript(file);
		assert.match(rendered, /User string content/);
		assert.match(rendered, /\[REDACTED\]/);
		assert.match(rendered, /password=\[REDACTED\]/);
		assert.match(rendered, /\{"password":"\[REDACTED\]","api_key":"\[REDACTED\]","note":"visible"\}/);
		assert.match(rendered, /A token bucket, authorization header, secret sauce, cookie cutter, and password reset/);
		assert.match(rendered.replace(/\s+/g, ""), /\{"tokenizer":"visible-token","note":"tokenbucket"\}/);
		for (const hidden of [
			"pass-one",
			"pass-two",
			"pass-three",
			"pass-four",
			"json-secret",
			"json-key",
			"key-one",
			"key-two",
			"bearer-value",
			"crumb",
			"direct-value",
			"ZGVtbzpwYXNz",
			"sk-proj-abcdefghijklmnop",
			"ghp_12345678901234567890",
			"github_pat_12345678901234567890",
			"AKIAIOSFODNN7EXAMPLE",
			jwt,
			"private material",
			"raw tool result must stay hidden",
			"raw argument must stay hidden",
		]) assert.ok(!rendered.includes(hidden), `${hidden} leaked: ${rendered}`);
	});

	it("renders bash execution status without exposing command, output, environment, or details", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-view-bash-"));
		const file = join(dir, "session.jsonl");
		writeRecords(file, [
			{
				type: "message",
				id: "running",
				message: {
					role: "bashExecution",
					command: "rm -rf /secret-command",
					output: "bash-output-secret",
					env: { API_KEY: "ENV_SECRET" },
					details: { secret: "detail-secret" },
					exitCode: null,
				},
			},
			{
				type: "message",
				id: "completed",
				message: { role: "bashExecution", command: "echo done", output: "done-output", exitCode: 0 },
			},
			{
				type: "message",
				id: "failed",
				message: { role: "bashExecution", command: "echo failed", output: "failed-output", exitCode: 7 },
			},
		]);

		const rendered = renderTranscript(file);
		assert.match(rendered, /Bash execution running/);
		assert.match(rendered, /Bash execution completed \(exit 0\)/);
		assert.match(rendered, /Bash execution error \(exit 7\)/);
		for (const hidden of ["rm -rf /secret-command", "bash-output-secret", "ENV_SECRET", "detail-secret", "echo done", "failed-output"]) {
			assert.ok(!rendered.includes(hidden), `${hidden} leaked: ${rendered}`);
		}
	});

	it("keeps the newest tail after the transcript cap and after appends", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-view-tail-"));
		const file = join(dir, "session.jsonl");
		const records = Array.from({ length: 650 }, (_, index) => ({
			type: "message",
			id: `message-${index}`,
			message: { role: "user", content: `record-${index}` },
		}));
		writeRecords(file, records);

		let transcript = readSessionTranscript(file, { live: true });
		assert.equal(transcript.lines[0]?.text, "[transcript content omitted after the display limit]");
		assert.ok(!transcript.lines.some((line) => line.text === "record-0"));
		assert.ok(transcript.lines.some((line) => line.text === "record-649"));

		writeFileSync(
			file,
			`${JSON.stringify({ type: "message", id: "tail", message: { role: "user", content: "new-tail-record" } })}\n`,
			{ flag: "a" },
		);
		transcript = readSessionTranscript(file, { live: true });
		assert.ok(transcript.lines.some((line) => line.text === "new-tail-record"));
		assert.equal(transcript.lines[0]?.text, "[transcript content omitted after the display limit]");
	});

	describe("launch boundary", () => {
		it("uses a valid launch marker after inherited history", () => {
			const dir = mkdtempSync(join(tmpdir(), "session-view-boundary-valid-"));
			const file = join(dir, "session.jsonl");
			writeRecords(file, [
				{ type: "session", id: "child", parentSession: join(dir, "parent.jsonl") },
				{ type: "message", id: "old", message: { role: "user", content: "old inherited history" } },
				{ type: "custom", id: "launch", customType: "pi-subagents_launch_metadata", data: { version: 1, mode: "background" } },
				{ type: "message", id: "own", message: { role: "assistant", content: "new child activity" } },
			]);
			const transcript = readSessionTranscript(file, { live: false });
			assert.equal(transcript.state, "ready");
			assert.match(transcript.lines.map((line) => line.text).join("\n"), /new child activity/);
			assert.doesNotMatch(transcript.lines.map((line) => line.text).join("\n"), /old inherited history/);
		});

		it("renders a fresh session safely when the marker is missing", () => {
			const dir = mkdtempSync(join(tmpdir(), "session-view-boundary-fresh-"));
			const file = join(dir, "session.jsonl");
			writeRecords(file, [
				{ type: "session", id: "fresh" },
				{ type: "message", id: "own", message: { role: "user", content: "fresh activity" } },
			]);
			const transcript = readSessionTranscript(file, { live: false });
			assert.equal(transcript.state, "ready");
			assert.match(transcript.lines.map((line) => line.text).join("\n"), /fresh activity/);
		});

		it("fails closed when an inherited session has no marker", () => {
			const dir = mkdtempSync(join(tmpdir(), "session-view-boundary-missing-"));
			const file = join(dir, "session.jsonl");
			writeRecords(file, [
				{ type: "session", id: "child", parentSession: join(dir, "parent.jsonl") },
				{ type: "message", id: "old", message: { role: "user", content: "old inherited history" } },
			]);
			const transcript = readSessionTranscript(file, { live: false });
			assert.equal(transcript.state, "boundary-unavailable");
			assert.match(transcript.status, /boundary is unavailable/);
			assert.deepEqual(transcript.lines, []);
		});

		it("fails closed when an inherited marker is malformed", () => {
			const dir = mkdtempSync(join(tmpdir(), "session-view-boundary-malformed-"));
			const file = join(dir, "session.jsonl");
			writeRecords(file, [
				{ type: "session", id: "child", parentSession: join(dir, "parent.jsonl") },
				{ type: "message", id: "old", message: { role: "user", content: "old inherited history" } },
				{ type: "custom", id: "launch", customType: "pi-subagents_launch_metadata", data: { version: 1 } },
			]);
			const transcript = readSessionTranscript(file, { live: false });
			assert.equal(transcript.state, "boundary-unavailable");
			assert.doesNotMatch(transcript.lines.map((line) => line.text).join("\n"), /old inherited history/);
		});
	});

	it("reports no-session, missing, and malformed file states truthfully", () => {
		const missing = join(tmpdir(), `missing-session-view-${Date.now()}.jsonl`);
		assert.match(readSessionTranscript(undefined, { live: true, noSession: true }).status, /No session/);
		assert.match(readSessionTranscript(missing, { live: true }).status, /retrying/);
		assert.match(readSessionTranscript(missing, { live: false }).status, /unavailable/);
		const dir = mkdtempSync(join(tmpdir(), "session-view-malformed-"));
		const file = join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"one"}\nnot-json\n');
		assert.match(readSessionTranscript(file, { live: false }).status, /malformed/);
		assert.ok(readFileSync(file, "utf8").includes("not-json"));
	});
});
