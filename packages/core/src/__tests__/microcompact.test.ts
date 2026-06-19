import { describe, expect, it } from "vitest";
import {
	MICROCOMPACT_CLEARED_PLACEHOLDER,
	microcompactMessages,
} from "../runtime/microcompact.js";

function toolResult(text: string, toolName = "bash", timestamp = Date.now()) {
	return {
		role: "toolResult" as const,
		toolCallId: `call_${Math.random().toString(36).slice(2)}`,
		toolName,
		content: [{ type: "text" as const, text }],
		details: {},
		isError: false,
		timestamp,
	};
}

function assistant(timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "thinking" }],
		timestamp,
	};
}

function clearedCount(messages: any[]): number {
	return messages.filter((m) => {
		const c = m.content;
		const text = typeof c === "string" ? c : c?.[0]?.text;
		return text === MICROCOMPACT_CLEARED_PLACEHOLDER;
	}).length;
}

describe("microcompactMessages", () => {
	it("does nothing when at or below keepRecent compactable tool results", () => {
		const messages = [toolResult("a"), toolResult("b"), toolResult("c")];
		const result = microcompactMessages(messages as any, { keepRecent: 5 });
		expect(result.changed).toBe(false);
		expect(result.clearedCount).toBe(0);
		expect(result.messages).toBe(messages);
	});

	it("clears older tool results beyond keepRecent, keeping the most recent intact", () => {
		const messages = Array.from({ length: 8 }, (_, i) => toolResult(`r${i}`));
		const result = microcompactMessages(messages as any, { keepRecent: 3 });
		expect(result.changed).toBe(true);
		// 8 compactable, keepRecent 3 -> clear oldest 5.
		expect(result.clearedCount).toBe(5);
		expect(clearedCount(result.messages as any)).toBe(5);
		// Most recent 3 keep their original text.
		const lastTexts = (result.messages as any[])
			.slice(-3)
			.map((m) => m.content[0].text);
		expect(lastTexts).toEqual(["r5", "r6", "r7"]);
	});

	it("does not re-clear already cleared results (idempotent)", () => {
		const messages = Array.from({ length: 7 }, (_, i) => toolResult(`r${i}`));
		const first = microcompactMessages(messages as any, { keepRecent: 2 });
		expect(first.changed).toBe(true);
		const second = microcompactMessages(first.messages as any, { keepRecent: 2 });
		// After the first pass only 2 compactable remain (the recent ones) -> no trigger.
		expect(second.changed).toBe(false);
	});

	it("gap trigger keeps all results when keepRecent covers the full count", () => {
		const now = 10_000_000;
		const oldTs = now - 61 * 60_000; // 61 minutes ago
		const messages = [
			assistant(oldTs),
			toolResult("a", "bash", oldTs),
			toolResult("b", "bash", oldTs),
		];
		const result = microcompactMessages(messages as any, {
			keepRecent: 5,
			now,
			gapThresholdMinutes: 60,
		});
		// Gap exceeded, but keepRecent (5) >= compactable count (2) so the slice
		// keeps everything and nothing is cleared.
		expect(result.changed).toBe(false);
		expect(result.clearedCount).toBe(0);
	});

	it("gap trigger clears older results when there is a tail to keep", () => {
		const now = 10_000_000;
		const oldTs = now - 61 * 60_000;
		const messages = [
			assistant(oldTs),
			...Array.from({ length: 4 }, () => toolResult("x", "bash", oldTs)),
		];
		const result = microcompactMessages(messages as any, {
			keepRecent: 1,
			now,
			gapThresholdMinutes: 60,
		});
		expect(result.changed).toBe(true);
		expect(result.clearedCount).toBe(3);
	});

	it("does not trigger on gap when within threshold", () => {
		const now = 10_000_000;
		const recentTs = now - 5 * 60_000; // 5 minutes ago
		const messages = [
			assistant(recentTs),
			...Array.from({ length: 4 }, () => toolResult("x", "bash", recentTs)),
		];
		const result = microcompactMessages(messages as any, {
			keepRecent: 10,
			now,
			gapThresholdMinutes: 60,
		});
		expect(result.changed).toBe(false);
	});

	it("respects a compactable tool-name allowlist", () => {
		const messages = [
			toolResult("keep", "write"),
			toolResult("clearable-1", "read"),
			toolResult("clearable-2", "read"),
			toolResult("clearable-3", "read"),
		];
		const result = microcompactMessages(messages as any, {
			keepRecent: 1,
			compactableToolNames: new Set(["read"]),
		});
		expect(result.changed).toBe(true);
		// 3 "read" compactable, keepRecent 1 -> clear 2; "write" never touched.
		expect(result.clearedCount).toBe(2);
		expect((result.messages as any[])[0].content[0].text).toBe("keep");
	});
});
