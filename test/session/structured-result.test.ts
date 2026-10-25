import assert from "node:assert/strict";
import { test } from "node:test";
import { findLastSubagentOutputWithSource, type SessionEntry } from "../../src/session/session.ts";

const header: SessionEntry = { type: "session", id: "native-child" };
const tools: SessionEntry = { type: "message", id: "system", message: { role: "system", content: "", toolsAdded: [{ name: "submit_agent_result", description: "Submit the child-bound result", parameters: { type: "object", properties: {} } }] } };
const request: SessionEntry = { type: "message", id: "request-one", parentId: "system", message: { role: "user", content: "The actual assignment" } };
const submission: SessionEntry = { type: "message", id: "submission", parentId: "request-one", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "submit-one", name: "submit_agent_result", arguments: {} }] } };
const acknowledgement: SessionEntry = { type: "message", id: "acknowledgement", parentId: "submission", message: { role: "toolResult", toolCallId: "submit-one", toolName: "submit_agent_result", content: [{ type: "text", text: "Recorded, not delivered. Continue to a normal final assistant response." }], details: { version: 1, schemaId: "worker", assignment: { sessionId: "native-child", requestEntryId: "request-one", branchEntryIds: ["system", "request-one", "submission"] }, fields: {} } } };
const renderedText = "## Status\ndone\n\n## Objective\nComplete the current assignment.\n\n## Current state\nRuntime-rendered final result.\n\n## Key decisions\nNone.\n\n## Verified by\n- Not run: extraction fixture only.\n\n## Next steps\nNone.\n\n## Do not\nTreat an acknowledgement as this report.\n";
const rendered: SessionEntry = { type: "message", id: "rendered-final", parentId: "acknowledgement", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: renderedText }] } };

test("structured narration plus submit and acknowledgement is not a current result", () => {
	const narrated: SessionEntry = { ...submission, message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Narration is not the rendered report." }, { type: "toolCall", id: "submit-one", name: "submit_agent_result", arguments: {} }] } };
	assert.equal(findLastSubagentOutputWithSource([header, tools, request, narrated, acknowledgement]), null);
});

test("textless submit and acknowledgement cannot fall back to earlier Bash output", () => {
	const earlier: SessionEntry = { type: "message", id: "earlier-bash", parentId: "request-one", message: { role: "toolResult", toolName: "bash", toolCallId: "bash-one", content: [{ type: "text", text: "EARLIER_BASH_OUTPUT_IS_NOT_A_REPORT" }] } };
	assert.equal(findLastSubagentOutputWithSource([header, tools, request, earlier, submission, acknowledgement]), null);
});

test("an actual new identical-text user assignment cannot inherit the prior rendered report", () => {
	const followUp: SessionEntry = { ...request, id: "request-two", parentId: "rendered-final" };
	assert.equal(findLastSubagentOutputWithSource([header, tools, request, submission, acknowledgement, rendered, followUp]), null);
});

test("ordinary current rendered assistant final keeps the existing text transport", () => {
	assert.deepEqual(findLastSubagentOutputWithSource([header, tools, request, submission, acknowledgement, rendered]), { summary: renderedText, summarySource: "subagent" });
});
