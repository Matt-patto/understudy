import { describe, expect, it } from "vitest";
import {
	estimateContextTokens,
	sumUsageTokens,
	tokenCountFromLastApiResponse,
} from "../runtime/token-usage.js";

function assistantWithUsage(usage: Partial<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}>) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			...usage,
		},
		timestamp: Date.now(),
	};
}

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe("sumUsageTokens", () => {
	it("sums input + cacheWrite + cacheRead + output", () => {
		expect(
			sumUsageTokens({ input: 100, cacheWrite: 20, cacheRead: 30, output: 50 }),
		).toBe(200);
	});

	it("ignores non-finite or missing fields", () => {
		expect(sumUsageTokens({ input: 10 })).toBe(10);
		expect(sumUsageTokens({ input: Number.NaN, output: 5 } as any)).toBe(5);
	});
});

describe("tokenCountFromLastApiResponse", () => {
	it("returns the summed tokens from the most recent assistant message with usage", () => {
		const messages = [
			assistantWithUsage({ input: 10, output: 5 }),
			userMessage("hi"),
			assistantWithUsage({ input: 100, cacheRead: 200, output: 50 }),
		];
		expect(tokenCountFromLastApiResponse(messages as any)).toBe(350);
	});

	it("skips assistant messages that carry zero usage", () => {
		const messages = [
			assistantWithUsage({ input: 40, output: 10 }),
			assistantWithUsage({}),
		];
		expect(tokenCountFromLastApiResponse(messages as any)).toBe(50);
	});

	it("returns 0 when no usage is present", () => {
		const messages = [userMessage("a"), userMessage("b")];
		expect(tokenCountFromLastApiResponse(messages as any)).toBe(0);
	});
});

describe("estimateContextTokens", () => {
	it("prefers usage from the last API response when present", () => {
		const messages = [
			userMessage("a".repeat(4_000)),
			assistantWithUsage({ input: 1_234, output: 6 }),
		];
		expect(estimateContextTokens(messages as any)).toBe(1_240);
	});

	it("falls back to char estimation / CHARS_PER_TOKEN_ESTIMATE when no usage", () => {
		// 4000 chars / 4 chars-per-token = 1000 tokens.
		const messages = [userMessage("a".repeat(4_000))];
		expect(estimateContextTokens(messages as any)).toBe(1_000);
	});
});
