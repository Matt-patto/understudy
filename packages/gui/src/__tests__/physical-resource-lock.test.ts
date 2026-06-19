import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGuiPhysicalLock, guiPhysicalLockEnabled } from "../physical-resource-lock.js";

describe("acquireGuiPhysicalLock", () => {
	let dir: string;
	let lockPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "understudy-gui-lock-test-"));
		lockPath = join(dir, "physical-resource.lock");
		process.env.UNDERSTUDY_GUI_LOCK_PATH = lockPath;
		delete process.env.UNDERSTUDY_GUI_LOCK;
	});

	afterEach(async () => {
		delete process.env.UNDERSTUDY_GUI_LOCK;
		delete process.env.UNDERSTUDY_GUI_LOCK_PATH;
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it("is a no-op release when disabled and writes no lock file", async () => {
		expect(guiPhysicalLockEnabled()).toBe(false);
		const release = await acquireGuiPhysicalLock({ tool: "gui_click" });
		expect(existsSync(lockPath)).toBe(false);
		await release();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("creates the lock file while held and removes it on release", async () => {
		process.env.UNDERSTUDY_GUI_LOCK = "1";
		const release = await acquireGuiPhysicalLock({ tool: "gui_click" });
		expect(existsSync(lockPath)).toBe(true);
		const holder = JSON.parse(await readFile(lockPath, "utf-8"));
		expect(holder.pid).toBe(process.pid);
		expect(holder.tool).toBe("gui_click");
		await release();
		expect(existsSync(lockPath)).toBe(false);
		// re-acquire after release succeeds
		const release2 = await acquireGuiPhysicalLock();
		expect(existsSync(lockPath)).toBe(true);
		await release2();
	});

	it("steals a lock held by a dead process", async () => {
		process.env.UNDERSTUDY_GUI_LOCK = "1";
		await writeFile(lockPath, JSON.stringify({ pid: 999_999, acquiredAt: Date.now() }));
		const release = await acquireGuiPhysicalLock({ tool: "gui_type" });
		const holder = JSON.parse(await readFile(lockPath, "utf-8"));
		expect(holder.pid).toBe(process.pid);
		await release();
	});

	it("steals a stale lock past the freshness window", async () => {
		process.env.UNDERSTUDY_GUI_LOCK = "1";
		// Live pid (ours) but an ancient timestamp → treated as stale.
		await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: 0 }));
		const release = await acquireGuiPhysicalLock();
		const holder = JSON.parse(await readFile(lockPath, "utf-8"));
		expect(holder.acquiredAt).toBeGreaterThan(0);
		await release();
	});

	it("throws with holder info when a live holder keeps the lock", async () => {
		process.env.UNDERSTUDY_GUI_LOCK = "1";
		// Live pid (ours) with a fresh timestamp → not stealable.
		await writeFile(lockPath, JSON.stringify({ pid: process.pid, tool: "gui_drag", acquiredAt: Date.now() }));
		await expect(acquireGuiPhysicalLock({ tool: "gui_click" })).rejects.toThrow(/GUI is busy/);
		// The lock file from the live holder is left intact.
		expect(existsSync(lockPath)).toBe(true);
		// And the in-process mutex is freed, so a later acquire (after the holder
		// file is gone) still works.
		await rm(lockPath, { force: true });
		const release = await acquireGuiPhysicalLock();
		await release();
	});
});
