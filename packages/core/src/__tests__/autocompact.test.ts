import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AUTOCOMPACT_BOUNDARY_MARKER,
	AUTOCOMPACT_BUFFER_TOKENS,
	AUTOCOMPACT_RESERVED_SUMMARY_CAP_TOKENS,
	MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
	computeAutocompactThreshold,
	createAutocompactState,
	evaluateAutocompact,
	rebuildHistoryWithSummary,
	runAutocompact,
} from "../runtime/autocompact.js";

function userMessage(text: string, timestamp = Date.now()) {
	return { role: "user" as const, content: text, timestamp };
}

function assistantMessage(text: string, timestamp = Date.now()) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		timestamp,
	};
}

function systemMessage(text: string) {
	return { role: "system" as const, content: text, timestamp: 0 };
}

function manyMessages(count: number): any[] {
	return Array.from({ length: count }, (_, i) =>
		i % 2 === 0 ? userMessage(`u${i}`) : assistantMessage(`a${i}`),
	);
}

afterEach(() => {
	delete process.env.UNDERSTUDY_AUTOCOMPACT_DISABLED;
	vi.restoreAllMocks();
});

describe("computeAutocompactThreshold", () => {
	it("reserves min(maxOutputTokens, cap) and subtracts the buffer", () => {
		const result = computeAutocompactThreshold({
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
		});
		// reservedForSummary = min(8000, 20000) = 8000
		expect(result.reservedForSummary).toBe(8_000);
		expect(result.effectiveContextWindow).toBe(200_000 - 8_000);
		expect(result.threshold).toBe(200_000 - 8_000 - AUTOCOMPACT_BUFFER_TOKENS);
	});

	it("caps the reserve at AUTOCOMPACT_RESERVED_SUMMARY_CAP_TOKENS", () => {
		const result = computeAutocompactThreshold({
			contextWindowTokens: 200_000,
			maxOutputTokens: 64_000,
		});
		expect(result.reservedForSummary).toBe(AUTOCOMPACT_RESERVED_SUMMARY_CAP_TOKENS);
	});
});

describe("evaluateAutocompact", () => {
	it("does not trigger below the threshold", () => {
		const decision = evaluateAutocompact({
			messages: manyMessages(20),
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state: createAutocompactState(),
			estimateTokens: () => 1_000,
		});
		expect(decision.shouldCompact).toBe(false);
		expect(decision.reason).toBe("below-threshold");
	});

	it("triggers when estimated tokens reach the threshold", () => {
		const decision = evaluateAutocompact({
			messages: manyMessages(20),
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state: createAutocompactState(),
			estimateTokens: (m) => 999_999,
		});
		expect(decision.shouldCompact).toBe(true);
		expect(decision.reason).toBe("over-threshold");
	});

	it("respects the disabled env flag", () => {
		process.env.UNDERSTUDY_AUTOCOMPACT_DISABLED = "1";
		const decision = evaluateAutocompact({
			messages: manyMessages(20),
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state: createAutocompactState(),
			estimateTokens: () => 999_999,
		});
		expect(decision.shouldCompact).toBe(false);
		expect(decision.reason).toBe("disabled");
	});

	it("opens the circuit after too many failures", () => {
		const state = createAutocompactState();
		state.consecutiveFailures = MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
		const decision = evaluateAutocompact({
			messages: manyMessages(20),
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state,
			estimateTokens: () => 999_999,
		});
		expect(decision.shouldCompact).toBe(false);
		expect(decision.reason).toBe("circuit-open");
	});

	it("skips when there are too few messages to compact", () => {
		const decision = evaluateAutocompact({
			messages: manyMessages(4),
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state: createAutocompactState(),
			keepRecentMessages: 6,
			estimateTokens: () => 999_999,
		});
		expect(decision.shouldCompact).toBe(false);
		expect(decision.reason).toBe("too-few-messages");
	});
});

describe("rebuildHistoryWithSummary", () => {
	it("preserves system messages and appends boundary + summary + recent tail", () => {
		const messages = [
			systemMessage("sys"),
			...manyMessages(10),
		];
		const rebuilt = rebuildHistoryWithSummary({
			messages: messages as any,
			summary: "the summary",
			keepRecentMessages: 3,
			now: 12345,
		});

		expect((rebuilt[0] as any).role).toBe("system");
		expect((rebuilt[1] as any).content).toBe(AUTOCOMPACT_BOUNDARY_MARKER);
		expect((rebuilt[2] as any).content).toContain("the summary");
		// 1 system + boundary + summary + 3 recent = 6
		expect(rebuilt).toHaveLength(6);
		// Last three preserved from the tail.
		const tail = rebuilt.slice(-3).map((m: any) =>
			typeof m.content === "string" ? m.content : m.content[0].text,
		);
		expect(tail).toEqual(["a7", "u8", "a9"]);
	});
});

describe("runAutocompact", () => {
	it("calls the injected summarizer and rebuilds when triggered", async () => {
		const state = createAutocompactState();
		const summarize = vi.fn(async () => "SUMMARY TEXT");
		const result = await runAutocompact({
			messages: manyMessages(20) as any,
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state,
			summarize,
			keepRecentMessages: 4,
			estimateTokens: () => 999_999,
			now: 999,
		});

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(result.compacted).toBe(true);
		expect((result.messages[0] as any).content).toBe(AUTOCOMPACT_BOUNDARY_MARKER);
		expect((result.messages[1] as any).content).toContain("SUMMARY TEXT");
		expect(state.consecutiveFailures).toBe(0);
	});

	it("does not call the summarizer when below threshold", async () => {
		const summarize = vi.fn(async () => "x");
		const result = await runAutocompact({
			messages: manyMessages(20) as any,
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state: createAutocompactState(),
			summarize,
			estimateTokens: () => 10,
		});
		expect(summarize).not.toHaveBeenCalled();
		expect(result.compacted).toBe(false);
		expect(result.reason).toBe("below-threshold");
	});

	it("increments the failure counter when the summarizer throws", async () => {
		const state = createAutocompactState();
		const summarize = vi.fn(async () => {
			throw new Error("boom");
		});
		const result = await runAutocompact({
			messages: manyMessages(20) as any,
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state,
			summarize,
			estimateTokens: () => 999_999,
		});
		expect(result.compacted).toBe(false);
		expect(result.reason).toBe("summary-failed");
		expect(state.consecutiveFailures).toBe(1);
	});

	it("trips the circuit breaker after MAX consecutive failures", async () => {
		const state = createAutocompactState();
		const summarize = vi.fn(async () => {
			throw new Error("boom");
		});
		const opts = {
			messages: manyMessages(20) as any,
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state,
			summarize,
			estimateTokens: () => 999_999,
		};

		for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i += 1) {
			await runAutocompact(opts);
		}
		expect(state.consecutiveFailures).toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);

		// Next run is blocked by the open circuit; summarizer no longer called.
		summarize.mockClear();
		const blocked = await runAutocompact(opts);
		expect(blocked.compacted).toBe(false);
		expect(blocked.reason).toBe("circuit-open");
		expect(summarize).not.toHaveBeenCalled();
	});

	it("resets the failure counter after a successful compaction", async () => {
		const state = createAutocompactState();
		state.consecutiveFailures = 2;
		const summarize = vi.fn(async () => "ok summary");
		const result = await runAutocompact({
			messages: manyMessages(20) as any,
			contextWindowTokens: 200_000,
			maxOutputTokens: 8_000,
			state,
			summarize,
			estimateTokens: () => 999_999,
		});
		expect(result.compacted).toBe(true);
		expect(state.consecutiveFailures).toBe(0);
	});
});
