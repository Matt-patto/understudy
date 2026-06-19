import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	CHARS_PER_TOKEN_ESTIMATE,
	createMessageCharEstimateCache,
	estimateContextChars,
} from "./tool-result-char-estimator.js";

/**
 * Usage-aware token counting, mirroring Claude Code's approach of trusting the
 * provider-reported usage from the most recent API response over local heuristics.
 *
 * pi-ai's `AssistantMessage.usage` shape: { input, output, cacheRead, cacheWrite, totalTokens }.
 * `cacheRead` == cache_read tokens, `cacheWrite` == cache_creation tokens.
 */

type UsageLike = {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	totalTokens?: unknown;
};

function isAssistantMessage(msg: AgentMessage): boolean {
	return (msg as { role?: unknown }).role === "assistant";
}

function readUsage(msg: AgentMessage): UsageLike | undefined {
	const usage = (msg as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") {
		return undefined;
	}
	return usage as UsageLike;
}

function toFiniteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Sum the input + cache_creation + cache_read + output tokens carried by a usage
 * object. This represents the full prompt+completion footprint for that call.
 */
export function sumUsageTokens(usage: UsageLike): number {
	return (
		toFiniteNumber(usage.input) +
		toFiniteNumber(usage.cacheWrite) +
		toFiniteNumber(usage.cacheRead) +
		toFiniteNumber(usage.output)
	);
}

/**
 * Scan from newest to oldest and return the summed token count from the most
 * recent assistant message that carries usage. Returns 0 when no usage exists.
 */
export function tokenCountFromLastApiResponse(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!isAssistantMessage(msg)) {
			continue;
		}
		const usage = readUsage(msg);
		if (!usage) {
			continue;
		}
		const summed = sumUsageTokens(usage);
		if (summed > 0) {
			return summed;
		}
	}
	return 0;
}

/**
 * Estimate the current context size in tokens. Prefers the provider-reported
 * usage from the last API response; falls back to the char estimator divided by
 * CHARS_PER_TOKEN_ESTIMATE when no usage is available (e.g. before the first
 * assistant turn completes).
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
	const fromUsage = tokenCountFromLastApiResponse(messages);
	if (fromUsage > 0) {
		return fromUsage;
	}
	const cache = createMessageCharEstimateCache();
	const chars = estimateContextChars(messages, cache);
	return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}
