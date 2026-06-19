import { describe, expect, it } from "vitest";
import {
	applyToolBudget,
	applyToolBudgetToMessagesInPlace,
	type PersistedToolResultWriter,
} from "../runtime/tool-budget.js";

function toolResult(text: string, toolCallId = "tool_call_1") {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	};
}

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function makeFakeWriter(): { writer: PersistedToolResultWriter; calls: Array<{ id: string; chars: number }> } {
	const calls: Array<{ id: string; chars: number }> = [];
	const writer: PersistedToolResultWriter = (id, fullOutput) => {
		calls.push({ id, chars: fullOutput.length });
		return `mem://tool-results/${id}.json`;
	};
	return { writer, calls };
}

function toolResultText(msg: any): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	return (content as Array<{ type: string; text?: string }>)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

describe("applyToolBudget", () => {
	it("leaves a small tool result untouched", () => {
		const msg = toolResult("small output");
		const { writer, calls } = makeFakeWriter();
		const result = applyToolBudget(msg, { maxSingleResultChars: 1_000, writer });
		expect(result.changed).toBe(false);
		expect(result.persisted).toHaveLength(0);
		expect(calls).toHaveLength(0);
		expect(result.message).toBe(msg);
	});

	it("persists oversized output via the injected writer and replaces with a preview", () => {
		const big = "X".repeat(5_000);
		const msg = toolResult(big, "call_big");
		const { writer, calls } = makeFakeWriter();
		const result = applyToolBudget(msg, {
			maxSingleResultChars: 1_000,
			previewChars: 100,
			writer,
		});

		expect(result.changed).toBe(true);
		expect(calls).toEqual([{ id: "call_big", chars: 5_000 }]);
		expect(result.persisted).toHaveLength(1);
		expect(result.persisted[0].path).toContain("mem://tool-results/call_big.json");
		expect(result.persisted[0].originalChars).toBe(5_000);

		const text = toolResultText(result.message);
		expect(text).toContain("[persisted-output] Output too large (5000 chars)");
		expect(text).toContain("mem://tool-results/call_big.json");
		expect(text).toContain("[/persisted-output]");
		// Preview only ~100 chars + framing, far below the original.
		expect(text.length).toBeLessThan(500);
	});

	it("does not require real disk because the writer is injected", () => {
		const msg = toolResult("Y".repeat(2_000));
		const { writer } = makeFakeWriter();
		expect(() =>
			applyToolBudget(msg, { maxSingleResultChars: 100, writer }),
		).not.toThrow();
	});
});

describe("applyToolBudgetToMessagesInPlace", () => {
	it("caps each oversized result and persists overflow (injected writer)", () => {
		const messages: any[] = [
			toolResult("A".repeat(3_000), "a"),
			userMessage("middle"),
			toolResult("B".repeat(50), "b"),
		];
		const { writer, calls } = makeFakeWriter();
		const out = applyToolBudgetToMessagesInPlace({
			messages,
			maxSingleResultChars: 1_000,
			maxResultsPerMessageChars: 1_000_000,
			previewChars: 50,
			writer,
		});

		expect(out.changed).toBe(true);
		expect(calls.map((c) => c.id)).toEqual(["a"]);
		expect(toolResultText(messages[0])).toContain("[persisted-output]");
		// Small result and user message untouched.
		expect(toolResultText(messages[2])).toBe("B".repeat(50));
		expect(messages[1].content).toBe("middle");
	});

	it("reduces largest-first until the per-message aggregate cap is satisfied", () => {
		const messages: any[] = [
			toolResult("A".repeat(400), "a"),
			toolResult("B".repeat(900), "b"),
			toolResult("C".repeat(300), "c"),
		];
		const { writer, calls } = makeFakeWriter();
		// Per-single cap is high so phase 1 does nothing; aggregate cap forces
		// phase-2 reduction starting with the largest ("b").
		applyToolBudgetToMessagesInPlace({
			messages,
			maxSingleResultChars: 10_000,
			maxResultsPerMessageChars: 900,
			previewChars: 20,
			writer,
		});

		// The largest ("b") must have been persisted first.
		expect(calls[0].id).toBe("b");
		expect(toolResultText(messages[1])).toContain("[persisted-output]");
	});

	it("returns unchanged when everything is within budget", () => {
		const messages: any[] = [toolResult("tiny", "a")];
		const { writer, calls } = makeFakeWriter();
		const out = applyToolBudgetToMessagesInPlace({
			messages,
			maxSingleResultChars: 10_000,
			maxResultsPerMessageChars: 10_000,
			writer,
		});
		expect(out.changed).toBe(false);
		expect(calls).toHaveLength(0);
	});
});
