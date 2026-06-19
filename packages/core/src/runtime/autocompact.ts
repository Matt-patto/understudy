import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateContextTokens } from "./token-usage.js";

/**
 * Autocompact: when the conversation approaches the model's context window, call
 * the model to produce a structured summary and replace the bulk of history with
 * [boundary marker, summary, ...recent kept messages]. Mirrors Claude Code's
 * autocompaction threshold math and circuit breaker.
 */

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** Reserved-for-summary cap; effective window = contextWindow - min(maxOutputTokens, this). */
export const AUTOCOMPACT_RESERVED_SUMMARY_CAP_TOKENS = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const DEFAULT_AUTOCOMPACT_KEEP_RECENT_MESSAGES = 6;

export const AUTOCOMPACT_BOUNDARY_MARKER = "[context-compacted]";

function readNumericEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) {
		return undefined;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isAutocompactDisabled(): boolean {
	const raw = process.env.UNDERSTUDY_AUTOCOMPACT_DISABLED;
	if (raw === undefined) {
		return false;
	}
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

/**
 * effectiveContextWindow = contextWindow - reservedForSummary,
 * reservedForSummary = min(maxOutputTokens, AUTOCOMPACT_RESERVED_SUMMARY_CAP_TOKENS).
 * Trigger threshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS.
 */
export function computeAutocompactThreshold(params: {
	contextWindowTokens: number;
	maxOutputTokens: number;
	bufferTokens?: number;
	reservedSummaryCapTokens?: number;
}): {
	effectiveContextWindow: number;
	reservedForSummary: number;
	threshold: number;
} {
	const bufferTokens = params.bufferTokens ?? AUTOCOMPACT_BUFFER_TOKENS;
	const reservedSummaryCap =
		params.reservedSummaryCapTokens ?? AUTOCOMPACT_RESERVED_SUMMARY_CAP_TOKENS;
	const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
	const maxOutputTokens = Math.max(0, Math.floor(params.maxOutputTokens));
	const reservedForSummary = Math.min(maxOutputTokens || reservedSummaryCap, reservedSummaryCap);
	const effectiveContextWindow = Math.max(1, contextWindowTokens - reservedForSummary);
	const threshold = Math.max(1, effectiveContextWindow - bufferTokens);
	return { effectiveContextWindow, reservedForSummary, threshold };
}

/** Resolve the effective context window override from env, if present. */
export function resolveAutocompactContextWindow(defaultWindow: number): number {
	return readNumericEnv("UNDERSTUDY_AUTOCOMPACT_WINDOW") ?? defaultWindow;
}

/**
 * Structured summarization prompt, modeled on Claude Code's analysis/summary
 * format. Appended as a user turn before calling the model.
 */
export const AUTOCOMPACT_SUMMARY_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing the work without losing context.

Wrap your analysis in <analysis> tags to organize your thoughts, then provide the final summary in <summary> tags. Structure the summary with these sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include why each is important and full code snippets where relevant.
4. Errors and Fixes: List all errors encountered and how they were fixed, including any user feedback on fixes.
5. Problem Solving: Document problems solved and any ongoing troubleshooting.
6. All User Messages: List every non-tool-result message from the user, to preserve their intent and feedback.
7. Pending Tasks: Outline any pending tasks that were explicitly requested.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary, including file names and code.
9. Optional Next Step: List the next step directly related to the most recent work, only if explicitly implied by the user's request.`;

export type SummarizeFn = (messages: AgentMessage[]) => Promise<string>;

export interface AutocompactState {
	consecutiveFailures: number;
}

export function createAutocompactState(): AutocompactState {
	return { consecutiveFailures: 0 };
}

export interface AutocompactDecision {
	shouldCompact: boolean;
	reason:
		| "below-threshold"
		| "disabled"
		| "circuit-open"
		| "too-few-messages"
		| "over-threshold";
	estimatedTokens: number;
	threshold: number;
}

export interface AutocompactEvaluateParams {
	messages: AgentMessage[];
	contextWindowTokens: number;
	maxOutputTokens: number;
	state: AutocompactState;
	keepRecentMessages?: number;
	bufferTokens?: number;
	estimateTokens?: (messages: AgentMessage[]) => number;
}

/**
 * Decide whether autocompaction should run. Pure: no model call, no mutation.
 */
export function evaluateAutocompact(params: AutocompactEvaluateParams): AutocompactDecision {
	const keepRecentMessages = params.keepRecentMessages ?? DEFAULT_AUTOCOMPACT_KEEP_RECENT_MESSAGES;
	const estimateTokens = params.estimateTokens ?? estimateContextTokens;
	const { threshold } = computeAutocompactThreshold({
		contextWindowTokens: params.contextWindowTokens,
		maxOutputTokens: params.maxOutputTokens,
		bufferTokens: params.bufferTokens,
	});
	const estimatedTokens = estimateTokens(params.messages);

	if (isAutocompactDisabled()) {
		return { shouldCompact: false, reason: "disabled", estimatedTokens, threshold };
	}
	if (params.state.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
		return { shouldCompact: false, reason: "circuit-open", estimatedTokens, threshold };
	}
	if (estimatedTokens < threshold) {
		return { shouldCompact: false, reason: "below-threshold", estimatedTokens, threshold };
	}
	// Need enough history that compaction actually frees something beyond the
	// recent tail we always keep, plus the system prompt.
	const compactableCount = params.messages.filter(
		(msg) => (msg as { role?: unknown }).role !== "system",
	).length;
	if (compactableCount <= keepRecentMessages) {
		return { shouldCompact: false, reason: "too-few-messages", estimatedTokens, threshold };
	}
	return { shouldCompact: true, reason: "over-threshold", estimatedTokens, threshold };
}

function isSystemMessage(msg: AgentMessage): boolean {
	return (msg as { role?: unknown }).role === "system";
}

/**
 * Rebuild the message history after a summary is produced:
 * [...system messages, boundary marker, summary message, ...recent kept messages].
 * The system prompt(s) are preserved at the front.
 */
export function rebuildHistoryWithSummary(params: {
	messages: AgentMessage[];
	summary: string;
	keepRecentMessages?: number;
	now?: number;
}): AgentMessage[] {
	const keepRecentMessages = params.keepRecentMessages ?? DEFAULT_AUTOCOMPACT_KEEP_RECENT_MESSAGES;
	const now = params.now ?? Date.now();

	const systemMessages = params.messages.filter(isSystemMessage);
	const nonSystem = params.messages.filter((msg) => !isSystemMessage(msg));
	let recent = keepRecentMessages > 0 ? nonSystem.slice(-keepRecentMessages) : [];
	// Never start the kept tail with an orphaned tool result whose originating
	// tool call was compacted away — several model APIs reject a tool result
	// that has no preceding tool call in the same window.
	while (recent.length > 0 && (recent[0] as { role?: unknown }).role === "toolResult") {
		recent = recent.slice(1);
	}

	const boundaryMessage = {
		role: "user" as const,
		content: AUTOCOMPACT_BOUNDARY_MARKER,
		timestamp: now,
	} as AgentMessage;
	const summaryMessage = {
		role: "user" as const,
		content:
			"Conversation summary (context was automatically compacted to fit the model window):\n\n" +
			params.summary,
		timestamp: now,
	} as AgentMessage;

	return [...systemMessages, boundaryMessage, summaryMessage, ...recent];
}

export interface AutocompactRunResult {
	compacted: boolean;
	reason: AutocompactDecision["reason"] | "summary-failed";
	messages: AgentMessage[];
	estimatedTokens: number;
	threshold: number;
}

/**
 * Full autocompact pass: evaluate, and if triggered, call the injected
 * summarizer and rebuild history. Updates the circuit-breaker state. Pure with
 * respect to I/O: all model access is via the injected `summarize` function so
 * the threshold/rebuild/circuit-breaker logic is unit-testable.
 */
export async function runAutocompact(params: {
	messages: AgentMessage[];
	contextWindowTokens: number;
	maxOutputTokens: number;
	state: AutocompactState;
	summarize: SummarizeFn;
	keepRecentMessages?: number;
	bufferTokens?: number;
	now?: number;
	estimateTokens?: (messages: AgentMessage[]) => number;
}): Promise<AutocompactRunResult> {
	const decision = evaluateAutocompact({
		messages: params.messages,
		contextWindowTokens: params.contextWindowTokens,
		maxOutputTokens: params.maxOutputTokens,
		state: params.state,
		keepRecentMessages: params.keepRecentMessages,
		bufferTokens: params.bufferTokens,
		estimateTokens: params.estimateTokens,
	});

	if (!decision.shouldCompact) {
		return {
			compacted: false,
			reason: decision.reason,
			messages: params.messages,
			estimatedTokens: decision.estimatedTokens,
			threshold: decision.threshold,
		};
	}

	let summary: string;
	try {
		summary = await params.summarize(params.messages);
	} catch {
		params.state.consecutiveFailures += 1;
		return {
			compacted: false,
			reason: "summary-failed",
			messages: params.messages,
			estimatedTokens: decision.estimatedTokens,
			threshold: decision.threshold,
		};
	}

	if (!summary || summary.trim().length === 0) {
		params.state.consecutiveFailures += 1;
		return {
			compacted: false,
			reason: "summary-failed",
			messages: params.messages,
			estimatedTokens: decision.estimatedTokens,
			threshold: decision.threshold,
		};
	}

	params.state.consecutiveFailures = 0;
	const rebuilt = rebuildHistoryWithSummary({
		messages: params.messages,
		summary,
		keepRecentMessages: params.keepRecentMessages,
		now: params.now,
	});
	return {
		compacted: true,
		reason: decision.reason,
		messages: rebuilt,
		estimatedTokens: decision.estimatedTokens,
		threshold: decision.threshold,
	};
}
