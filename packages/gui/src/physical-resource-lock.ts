import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Cross-session GUI physical-resource lock. GUI automation drives the shared
 * screen/keyboard/mouse, so two concurrent sessions must not act at once. This
 * serializes GUI actions within a process (cheap async mutex) and across
 * processes (a lock file with holder info, stale detection, and backoff retry).
 *
 * Opt-in via UNDERSTUDY_GUI_LOCK — single-session usage does not need it, and
 * leaving it off keeps unrelated GUI calls from serializing unnecessarily.
 */

const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400];

export interface GuiLockHolder {
	pid: number;
	tool?: string;
	acquiredAt: number;
}

export function guiPhysicalLockEnabled(): boolean {
	const raw = process.env.UNDERSTUDY_GUI_LOCK;
	if (raw === undefined) {
		return false;
	}
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

function resolveLockPath(): string {
	const explicit = process.env.UNDERSTUDY_GUI_LOCK_PATH?.trim();
	if (explicit) {
		return explicit;
	}
	return join(tmpdir(), "understudy-gui-lock", "physical-resource.lock");
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is owned by another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function describeHolder(holder: GuiLockHolder | undefined): string {
	if (!holder) {
		return "another GUI session";
	}
	const tool = holder.tool ? ` running ${holder.tool}` : "";
	return `pid ${holder.pid}${tool}`;
}

let inProcessChain: Promise<void> = Promise.resolve();

/**
 * Acquire the GUI physical-resource lock. Returns a release function. When the
 * lock is disabled the release is a no-op. Throws with holder info if a live
 * holder keeps the cross-process lock through all retries.
 */
export async function acquireGuiPhysicalLock(
	options: { tool?: string } = {},
): Promise<() => Promise<void>> {
	if (!guiPhysicalLockEnabled()) {
		return async () => {};
	}

	// Serialize within this process first so same-process calls queue instead of
	// fighting over the lock file.
	let releaseInProcess!: () => void;
	const previous = inProcessChain;
	inProcessChain = new Promise<void>((resolve) => {
		releaseInProcess = resolve;
	});
	await previous;

	const path = resolveLockPath();
	await mkdir(dirname(path), { recursive: true }).catch(() => {});
	const holder: GuiLockHolder = { pid: process.pid, tool: options.tool, acquiredAt: Date.now() };

	let lastHolder: GuiLockHolder | undefined;
	for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			await writeFile(path, JSON.stringify(holder), { flag: "wx" });
			let released = false;
			return async () => {
				if (released) {
					return;
				}
				released = true;
				await rm(path, { force: true }).catch(() => {});
				releaseInProcess();
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				// Unexpected filesystem error: keep in-process serialization but do
				// not block on a cross-process lock we cannot manage.
				return async () => {
					releaseInProcess();
				};
			}
			let existing: GuiLockHolder | undefined;
			try {
				existing = JSON.parse(await readFile(path, "utf-8")) as GuiLockHolder;
			} catch {
				existing = undefined;
			}
			lastHolder = existing;
			const stale = !existing
				|| Date.now() - existing.acquiredAt > LOCK_STALE_MS
				|| !isProcessAlive(existing.pid);
			if (stale) {
				await rm(path, { force: true }).catch(() => {});
				continue;
			}
			if (attempt < LOCK_RETRY_DELAYS_MS.length) {
				await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[attempt]));
			}
		}
	}

	releaseInProcess();
	throw new Error(
		`GUI is busy: the physical resource is held by ${describeHolder(lastHolder)}. Retry shortly.`,
	);
}
