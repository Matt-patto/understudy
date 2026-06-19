import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	createMessageCharEstimateCache,
	estimateMessageCharsCached,
	getToolResultText,
	isToolResultMessage,
} from "./tool-result-char-estimator.js";

/**
 * Tool-result budget enforcement with overflow persistence, mirroring Claude
 * Code: when a single tool result is too large it is written to disk and the
 * in-context content is replaced with a small preview pointing at the saved
 * file. After per-tool capping, results are reduced largest-first until the
 * per-message aggregate cap is satisfied.
 */

function readNumericEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per single tool result, in chars (~25k tokens at 2 chars/token for tool output). */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = readNumericEnv(
	"UNDERSTUDY_MAX_RESULT_SIZE_CHARS",
	50_000,
);

/** Aggregate cap for all tool results within a single message batch, in chars. */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = readNumericEnv(
	"UNDERSTUDY_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS",
	200_000,
);

/** Preview size kept inline when a tool result is persisted to disk, in chars. */
export const PERSISTED_OUTPUT_PREVIEW_CHARS = readNumericEnv(
	"UNDERSTUDY_PERSISTED_OUTPUT_PREVIEW_CHARS",
	2_048,
);

const PERSISTED_OUTPUT_HEADER = "[persisted-output]";
const PERSISTED_OUTPUT_FOOTER = "[/persisted-output]";

export type PersistedToolResultWriter = (id: string, fullOutput: string) => string;

export interface PersistedToolResultInfo {
	/** Identifier used for the persisted file (tool call id when available). */
	id: string;
	/** Absolute path the full output was written to. */
	path: string;
	/** Original size in chars before persistence. */
	originalChars: number;
}

export interface ApplyToolBudgetOptions {
	maxSingleResultChars?: number;
	maxResultsPerMessageChars?: number;
	previewChars?: number;
	/**
	 * Directory under which oversized outputs are written when using the default
	 * disk writer. Ignored when a custom `writer` is supplied.
	 */
	persistDir?: string;
	/**
	 * Injectable writer (for tests) that persists the full output somewhere and
	 * returns a path/locator string. Defaults to a disk writer using `persistDir`.
	 */
	writer?: PersistedToolResultWriter;
}

export interface ApplyToolBudgetResult {
	message: AgentMessage;
	persisted: PersistedToolResultInfo[];
	changed: boolean;
}

function resolveToolCallId(msg: AgentMessage, index: number): string {
	const direct = (msg as { toolCallId?: unknown }).toolCallId;
	if (typeof direct === "string" && direct.length > 0) {
		return direct;
	}
	const alt = (msg as { id?: unknown }).id;
	if (typeof alt === "string" && alt.length > 0) {
		return alt;
	}
	return `tool-result-${index}-${Date.now()}`;
}

function createDiskWriter(persistDir: string): PersistedToolResultWriter {
	return (id, fullOutput) => {
		const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
		const path = join(persistDir, "tool-results", `${safeId}.json`);
		mkdirSync(dirname(path), { recursive: true });
		const payload = JSON.stringify(
			{ id, savedAt: new Date().toISOString(), chars: fullOutput.length, output: fullOutput },
			null,
			2,
		);
		writeFileSync(path, payload, "utf-8");
		return path;
	};
}

function buildPreviewText(params: {
	fullOutput: string;
	originalChars: number;
	path: string;
	previewChars: number;
}): string {
	const { fullOutput, originalChars, path, previewChars } = params;
	const preview = fullOutput.slice(0, Math.max(0, previewChars));
	return [
		`${PERSISTED_OUTPUT_HEADER} Output too large (${originalChars} chars). Full output saved to: ${path}`,
		preview,
		PERSISTED_OUTPUT_FOOTER,
	].join("\n");
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
	const content = (msg as { content?: unknown }).content;
	const replacementContent =
		typeof content === "string" || content === undefined ? text : [{ type: "text", text }];
	const sourceRecord = msg as unknown as Record<string, unknown>;
	const { details: _details, ...rest } = sourceRecord;
	return {
		...rest,
		content: replacementContent,
	} as AgentMessage;
}

/**
 * Pure, testable budget application for a single tool-result message. Returns a
 * (possibly) trimmed clone plus metadata about what was persisted. Non
 * tool-result messages are returned unchanged.
 */
export function applyToolBudget(
	message: AgentMessage,
	opts: ApplyToolBudgetOptions = {},
): ApplyToolBudgetResult {
	if (!isToolResultMessage(message)) {
		return { message, persisted: [], changed: false };
	}

	const maxSingleResultChars = opts.maxSingleResultChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
	const previewChars = opts.previewChars ?? PERSISTED_OUTPUT_PREVIEW_CHARS;
	const text = getToolResultText(message);
	if (text.length <= maxSingleResultChars) {
		return { message, persisted: [], changed: false };
	}

	const writer = opts.writer ?? createDiskWriter(opts.persistDir ?? process.cwd());
	const id = resolveToolCallId(message, 0);
	let path: string;
	try {
		path = writer(id, text);
	} catch {
		// If persistence fails, fall back to an inline preview without a path so
		// we still respect the budget rather than letting the full output through.
		path = "(persistence failed; output dropped)";
	}

	const previewText = buildPreviewText({
		fullOutput: text,
		originalChars: text.length,
		path,
		previewChars,
	});
	const trimmed = replaceToolResultText(message, previewText);
	return {
		message: trimmed,
		persisted: [{ id, path, originalChars: text.length }],
		changed: true,
	};
}

/**
 * Apply the tool budget across an entire message list in place. First caps each
 * oversized single tool result (persisting overflow), then reduces remaining
 * tool results largest-first until the per-message aggregate cap is satisfied.
 *
 * Mutates `messages` and returns metadata about what was persisted.
 */
export function applyToolBudgetToMessagesInPlace(params: {
	messages: AgentMessage[];
	maxSingleResultChars?: number;
	maxResultsPerMessageChars?: number;
	previewChars?: number;
	persistDir?: string;
	writer?: PersistedToolResultWriter;
}): { persisted: PersistedToolResultInfo[]; changed: boolean } {
	const {
		messages,
		maxSingleResultChars = DEFAULT_MAX_RESULT_SIZE_CHARS,
		maxResultsPerMessageChars = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
		previewChars = PERSISTED_OUTPUT_PREVIEW_CHARS,
		persistDir,
		writer,
	} = params;

	const persisted: PersistedToolResultInfo[] = [];
	let changed = false;
	// Resolve the writer once so the per-tool and aggregate phases agree, and so
	// disk paths are created lazily only when something needs persisting.
	const effectiveWriter = writer ?? createDiskWriter(persistDir ?? process.cwd());

	const persistMessageInPlace = (index: number): void => {
		const msg = messages[index];
		const text = getToolResultText(msg);
		const id = resolveToolCallId(msg, index);
		let path: string;
		try {
			path = effectiveWriter(id, text);
		} catch {
			path = "(persistence failed; output dropped)";
		}
		const previewText = buildPreviewText({
			fullOutput: text,
			originalChars: text.length,
			path,
			previewChars,
		});
		messages[index] = replaceToolResultText(msg, previewText);
		persisted.push({ id, path, originalChars: text.length });
		changed = true;
	};

	// Phase 1: per-tool cap with overflow persistence.
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (!isToolResultMessage(msg)) {
			continue;
		}
		if (getToolResultText(msg).length > maxSingleResultChars) {
			persistMessageInPlace(i);
		}
	}

	// Phase 2: reduce largest-first until the aggregate per-message cap holds.
	const cache = createMessageCharEstimateCache();
	const toolIndices = messages
		.map((msg, index) => ({ index, isTool: isToolResultMessage(msg) }))
		.filter((entry) => entry.isTool)
		.map((entry) => entry.index);

	const totalToolChars = () =>
		toolIndices.reduce((sum, index) => sum + estimateMessageCharsCached(messages[index], cache), 0);

	if (totalToolChars() > maxResultsPerMessageChars) {
		const ordered = [...toolIndices].sort(
			(a, b) =>
				estimateMessageCharsCached(messages[b], cache) -
				estimateMessageCharsCached(messages[a], cache),
		);
		for (const index of ordered) {
			if (totalToolChars() <= maxResultsPerMessageChars) {
				break;
			}
			persistMessageInPlace(index);
			cache.delete(messages[index]);
		}
	}

	return { persisted, changed };
}
