import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isToolResultMessage } from "./tool-result-char-estimator.js";

/**
 * Microcompact: a lightweight, model-free pass that mirrors Claude Code's
 * behavior of clearing the *content* of older tool results while keeping the
 * most recent N intact. This frees context proactively without an LLM round
 * trip, before the heavier budget/autocompact passes run.
 */

export const MICROCOMPACT_CLEARED_PLACEHOLDER = "[Old tool result content cleared]";

export const DEFAULT_MICROCOMPACT_KEEP_RECENT = 5;
export const DEFAULT_MICROCOMPACT_GAP_THRESHOLD_MINUTES = 60;

/**
 * Tools whose results are safe to clear once they fall out of the recent
 * window. Read-heavy/inspection tools dominate context and rarely need their
 * full historical output once newer work supersedes them. An empty set (the
 * default behavior here) treats all tool results as compactable, matching the
 * "older tool results" framing; callers can restrict via `compactableToolNames`.
 */
export interface MicrocompactOptions {
	keepRecent?: number;
	/** Current time in ms; injectable for deterministic tests. Defaults to Date.now(). */
	now?: number;
	/** Minutes since the last assistant message that also triggers a pass. */
	gapThresholdMinutes?: number;
	/**
	 * Optional allowlist of tool names whose results may be cleared. When
	 * omitted, all tool results are considered compactable.
	 */
	compactableToolNames?: ReadonlySet<string>;
}

export interface MicrocompactResult {
	messages: AgentMessage[];
	clearedCount: number;
	changed: boolean;
}

function isMicrocompactEnabled(): boolean {
	const raw = process.env.UNDERSTUDY_CONTEXT_MICROCOMPACT;
	if (raw === undefined) {
		return true;
	}
	const normalized = raw.trim().toLowerCase();
	return !(normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no");
}

function toolName(msg: AgentMessage): string | undefined {
	const name = (msg as { toolName?: unknown }).toolName;
	return typeof name === "string" ? name : undefined;
}

function isAlreadyCleared(msg: AgentMessage): boolean {
	const content = (msg as { content?: unknown }).content;
	if (typeof content === "string") {
		return content === MICROCOMPACT_CLEARED_PLACEHOLDER;
	}
	if (Array.isArray(content)) {
		return (
			content.length === 1 &&
			!!content[0] &&
			typeof content[0] === "object" &&
			(content[0] as { type?: unknown }).type === "text" &&
			(content[0] as { text?: unknown }).text === MICROCOMPACT_CLEARED_PLACEHOLDER
		);
	}
	return false;
}

function isCompactable(msg: AgentMessage, allow?: ReadonlySet<string>): boolean {
	if (!isToolResultMessage(msg)) {
		return false;
	}
	if (isAlreadyCleared(msg)) {
		return false;
	}
	if (!allow || allow.size === 0) {
		return true;
	}
	const name = toolName(msg);
	return name !== undefined && allow.has(name);
}

function clearToolResultContent(msg: AgentMessage): AgentMessage {
	const content = (msg as { content?: unknown }).content;
	const replacementContent =
		typeof content === "string" || content === undefined
			? MICROCOMPACT_CLEARED_PLACEHOLDER
			: [{ type: "text", text: MICROCOMPACT_CLEARED_PLACEHOLDER }];
	const sourceRecord = msg as unknown as Record<string, unknown>;
	const { details: _details, ...rest } = sourceRecord;
	return {
		...rest,
		content: replacementContent,
	} as AgentMessage;
}

function lastAssistantTimestamp(messages: AgentMessage[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if ((msg as { role?: unknown }).role === "assistant") {
			const ts = (msg as { timestamp?: unknown }).timestamp;
			if (typeof ts === "number" && Number.isFinite(ts)) {
				return ts;
			}
		}
	}
	return undefined;
}

/**
 * Pure microcompaction. Keeps the most recent `keepRecent` compactable tool
 * results intact and clears the content of older ones in place (returning a new
 * array of messages; cleared messages are cloned). Triggers when either there
 * are more than `keepRecent` compactable tool results, or the gap since the last
 * assistant message exceeds `gapThresholdMinutes`.
 */
export function microcompactMessages(
	messages: AgentMessage[],
	options: MicrocompactOptions = {},
): MicrocompactResult {
	const keepRecent = options.keepRecent ?? DEFAULT_MICROCOMPACT_KEEP_RECENT;
	const gapThresholdMinutes =
		options.gapThresholdMinutes ?? DEFAULT_MICROCOMPACT_GAP_THRESHOLD_MINUTES;
	const now = options.now ?? Date.now();
	const allow = options.compactableToolNames;

	const compactableIndices: number[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		if (isCompactable(messages[i], allow)) {
			compactableIndices.push(i);
		}
	}

	const countTrigger = compactableIndices.length > keepRecent;
	const lastAssistantTs = lastAssistantTimestamp(messages);
	const gapTrigger =
		lastAssistantTs !== undefined &&
		now - lastAssistantTs >= gapThresholdMinutes * 60_000 &&
		compactableIndices.length > 0;

	if (!countTrigger && !gapTrigger) {
		return { messages, clearedCount: 0, changed: false };
	}

	// Keep the most recent `keepRecent` compactable tool results intact; clear
	// everything older.
	const keepFromIndex = Math.max(0, compactableIndices.length - keepRecent);
	const indicesToClear = new Set(compactableIndices.slice(0, keepFromIndex));

	if (indicesToClear.size === 0) {
		return { messages, clearedCount: 0, changed: false };
	}

	const next = messages.map((msg, index) =>
		indicesToClear.has(index) ? clearToolResultContent(msg) : msg,
	);
	return { messages: next, clearedCount: indicesToClear.size, changed: true };
}

/**
 * Microcompact in place (mutating the supplied array) when the env flag allows.
 * Returns metadata. Used by the reactive context guard.
 */
export function microcompactMessagesInPlace(
	messages: AgentMessage[],
	options: MicrocompactOptions = {},
): MicrocompactResult {
	if (!isMicrocompactEnabled()) {
		return { messages, clearedCount: 0, changed: false };
	}
	const result = microcompactMessages(messages, options);
	if (result.changed) {
		for (let i = 0; i < result.messages.length; i += 1) {
			messages[i] = result.messages[i];
		}
	}
	return { ...result, messages };
}
