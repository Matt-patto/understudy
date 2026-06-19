import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync } from "./exec-utils.js";

const HELPER_BINARY_NAME = "understudy-gui-native-helper";
const HELPER_COMPILE_TIMEOUT_MS = 120_000;
const SERVE_SENTINEL = "__UNDERSTUDY_SERVE_DONE__";

/**
 * Whether to route native helper calls through a persistent serve-mode process
 * instead of spawning one process per action. Default on; any error or timeout
 * falls back to the one-shot path so this can only speed things up, never break
 * them. Disable with UNDERSTUDY_GUI_HELPER_SERVE=0.
 */
export function nativeHelperServeEnabled(): boolean {
	const raw = process.env.UNDERSTUDY_GUI_HELPER_SERVE;
	if (raw === undefined) {
		return true;
	}
	const normalized = raw.trim().toLowerCase();
	return !(
		normalized === "0"
		|| normalized === "false"
		|| normalized === "off"
		|| normalized === "no"
	);
}

/**
 * Persistent native-helper process speaking a newline-delimited JSON request /
 * sentinel-framed response protocol. Requests are serialized through a mutex.
 * Any failure kills the child (a fresh one spawns on the next request) and the
 * error propagates so the caller can fall back to a one-shot invocation.
 */
class NativeHelperServeProcess {
	private child: ChildProcess | undefined;
	private alive = false;
	private stdoutBuffer = "";
	private pendingLines: string[] = [];
	private lineWaiters: Array<(line: string) => void> = [];
	private mutex: Promise<void> = Promise.resolve();

	private ensureChild(binaryPath: string): ChildProcess {
		if (this.child && this.alive) {
			return this.child;
		}
		const child = spawn(binaryPath, ["serve"], {
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.alive = true;
		this.stdoutBuffer = "";
		this.pendingLines = [];
		this.lineWaiters = [];
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		const markDead = () => {
			this.alive = false;
		};
		child.on("exit", markDead);
		child.on("error", markDead);
		child.stdin?.on("error", markDead);
		return child;
	}

	private onStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = this.stdoutBuffer.slice(0, newlineIndex);
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			const waiter = this.lineWaiters.shift();
			if (waiter) {
				waiter(line);
			} else {
				this.pendingLines.push(line);
			}
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
	}

	private nextLine(): Promise<string> {
		const pending = this.pendingLines.shift();
		if (pending !== undefined) {
			return Promise.resolve(pending);
		}
		return new Promise<string>((resolve) => this.lineWaiters.push(resolve));
	}

	private kill(): void {
		this.alive = false;
		try {
			this.child?.kill("SIGKILL");
		} catch {
			// ignore
		}
		this.child = undefined;
		this.pendingLines = [];
		this.lineWaiters = [];
		this.stdoutBuffer = "";
	}

	async request(
		binaryPath: string,
		command: string,
		env: Record<string, string | undefined>,
		timeoutMs: number,
	): Promise<string> {
		let release!: () => void;
		const previous = this.mutex;
		this.mutex = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this.requestLocked(binaryPath, command, env, timeoutMs);
		} catch (error) {
			// Any failure poisons the framing; drop the child so the next request
			// starts clean, and let the caller fall back to a one-shot invocation.
			this.kill();
			throw error;
		} finally {
			release();
		}
	}

	private async requestLocked(
		binaryPath: string,
		command: string,
		env: Record<string, string | undefined>,
		timeoutMs: number,
	): Promise<string> {
		const child = this.ensureChild(binaryPath);
		this.pendingLines = [];
		const cleanEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			if (typeof value === "string") {
				cleanEnv[key] = value;
			}
		}
		if (!child.stdin?.writable) {
			throw new Error("native helper serve stdin is not writable");
		}
		child.stdin.write(`${JSON.stringify({ command, env: cleanEnv })}\n`);
		const lines: string[] = [];
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error("native helper serve request timed out");
			}
			const line = await this.withTimeout(this.nextLine(), remaining);
			if (line.startsWith(SERVE_SENTINEL)) {
				const status = line.slice(SERVE_SENTINEL.length).trim();
				if (status.startsWith("ok")) {
					return lines.join("\n").trim();
				}
				throw new Error(`native helper serve command failed: ${status.replace(/^err\s*/, "")}`);
			}
			lines.push(line);
		}
	}

	private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("native helper serve read timed out")), ms);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
}

const serveProcess = new NativeHelperServeProcess();

/** Run a native helper command via the persistent serve-mode process. */
export async function runNativeHelperViaServe(
	binaryPath: string,
	command: string,
	env: Record<string, string | undefined>,
	timeoutMs: number,
): Promise<string> {
	return serveProcess.request(binaryPath, command, env, timeoutMs);
}

/**
 * Whether the user-driven emergency stop (press Escape to abort in-flight GUI
 * actions) is enabled. Opt-in: it relies on a global key event tap that cannot
 * be verified headlessly, so it stays off unless explicitly enabled to avoid
 * spuriously aborting verified default flows.
 */
export function emergencyStopEnabled(): boolean {
	const raw = process.env.UNDERSTUDY_GUI_EMERGENCY_STOP;
	if (raw === undefined) {
		return false;
	}
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

/**
 * Spawns the native `watch-escape` helper once and exposes an AbortSignal that
 * fires when the user presses Escape, so GUI actions can be interrupted.
 */
class EmergencyStopMonitor {
	private child: ChildProcess | undefined;
	private controller: AbortController | undefined;
	private starting: Promise<void> | undefined;

	get signal(): AbortSignal | undefined {
		return this.controller?.signal;
	}

	async ensureStarted(binaryPath: string): Promise<void> {
		if (this.controller) {
			return;
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = (async () => {
			const controller = new AbortController();
			this.controller = controller;
			try {
				const child = spawn(binaryPath, ["watch-escape"], {
					env: process.env,
					stdio: ["ignore", "pipe", "ignore"],
				});
				this.child = child;
				child.stdout?.setEncoding("utf-8");
				child.stdout?.on("data", (chunk: string) => {
					if (chunk.includes("escape")) {
						this.trigger();
					}
				});
				child.on("error", () => {});
			} catch {
				// Monitor unavailable; the signal simply never fires.
			}
		})();
		return this.starting;
	}

	private trigger(): void {
		try {
			this.controller?.abort(new Error("Emergency stop: Escape pressed."));
		} catch {
			// ignore
		}
	}
}

const emergencyStopMonitor = new EmergencyStopMonitor();

/**
 * Returns an AbortSignal that aborts when the user presses Escape, or undefined
 * when the emergency stop is disabled or unavailable.
 */
export async function getEmergencyStopSignal(): Promise<AbortSignal | undefined> {
	if (!emergencyStopEnabled()) {
		return undefined;
	}
	try {
		const binaryPath = await resolveNativeGuiHelperBinary();
		await emergencyStopMonitor.ensureStarted(binaryPath);
		return emergencyStopMonitor.signal;
	} catch {
		return undefined;
	}
}

const NATIVE_GUI_HELPER_SOURCE = String.raw`
import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import Carbon.HIToolbox

enum HelperError: Error, CustomStringConvertible {
	case invalidCommand(String)
	case invalidEnv(String)
	case missingEnv(String)
	case applicationNotFound(String)
	case activationFailed(String)
	case eventCreationFailed(String)

	var description: String {
		switch self {
		case .invalidCommand(let value):
			return "invalidCommand(\(value))"
		case .invalidEnv(let key):
			return "invalidEnv(\(key))"
		case .missingEnv(let key):
			return "missingEnv(\(key))"
		case .applicationNotFound(let name):
			return "applicationNotFound(\(name))"
		case .activationFailed(let name):
			return "activationFailed(\(name))"
		case .eventCreationFailed(let detail):
			return "eventCreationFailed(\(detail))"
		}
	}
}

struct Rect: Codable {
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

struct Point: Codable {
	let x: Double
	let y: Double
}

struct DisplayDescriptor: Codable {
	let index: Int
	let bounds: Rect
}

struct CaptureContext: Codable {
	let appName: String?
	let display: DisplayDescriptor
	let cursor: Point
	let windowId: Int?
	let windowTitle: String?
	let windowBounds: Rect?
	let windowCount: Int?
	let windowCaptureStrategy: String?
}

struct WindowMatch {
	let id: Int
	let title: String?
	let bounds: CGRect
	let layer: Int
}

struct WindowSelection {
	let primary: WindowMatch
	let captureBounds: CGRect
	let windowCount: Int
	let captureStrategy: String
}

struct ServeRequest: Codable {
	let command: String
	let env: [String: String]?
}

var requestEnvOverride: [String: String]? = nil

func env(_ key: String) -> String {
	if let override = requestEnvOverride, let value = override[key] {
		return value
	}
	return ProcessInfo.processInfo.environment[key] ?? ""
}

func trimmedEnv(_ key: String) -> String? {
	let value = env(key).trimmingCharacters(in: .whitespacesAndNewlines)
	return value.isEmpty ? nil : value
}

func normalizedText(_ value: String?) -> String? {
	guard let value else { return nil }
	let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	return normalized.isEmpty ? nil : normalized
}

func requiredDouble(_ key: String) throws -> Double {
	let raw = env(key)
	guard let value = Double(raw) else { throw HelperError.invalidEnv(key) }
	return value
}

func requiredInt32(_ key: String) throws -> Int32 {
	let raw = env(key)
	guard let value = Int32(raw) else { throw HelperError.invalidEnv(key) }
	return value
}

func requiredInt(_ key: String) throws -> Int {
	let raw = env(key)
	guard let value = Int(raw) else { throw HelperError.invalidEnv(key) }
	return value
}

func optionalInt(_ key: String) -> Int? {
	let raw = env(key)
	guard !raw.isEmpty else { return nil }
	return Int(raw)
}

func optionalDouble(_ key: String) -> Double? {
	Double(env(key))
}

func shouldActivateApp() -> Bool {
	env("UNDERSTUDY_GUI_ACTIVATE_APP") != "0"
}

func matchesAppName(_ app: NSRunningApplication, requestedName: String) -> Bool {
	let normalized = requestedName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	if normalized.isEmpty {
		return false
	}
	if app.localizedName?.lowercased() == normalized {
		return true
	}
	if app.bundleIdentifier?.lowercased() == normalized {
		return true
	}
	if app.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == normalized {
		return true
	}
	return false
}

func findRunningApplication(named name: String) -> NSRunningApplication? {
	let candidates = NSWorkspace.shared.runningApplications.filter { app in
		matchesAppName(app, requestedName: name) && !app.isTerminated
	}
	if let active = candidates.first(where: { $0.isActive }) {
		return active
	}
	return candidates.first
}

func resolveRequestedApplication(named name: String?) -> NSRunningApplication? {
	guard let name else {
		return NSWorkspace.shared.frontmostApplication
	}
	return findRunningApplication(named: name) ?? NSWorkspace.shared.frontmostApplication
}

func activateApplication(named name: String?) throws {
	guard let name else {
		return
	}
	if let frontmost = NSWorkspace.shared.frontmostApplication, matchesAppName(frontmost, requestedName: name) {
		return
	}
	guard let app = findRunningApplication(named: name) else {
		throw HelperError.applicationNotFound(name)
	}
	if !app.activate(options: [.activateIgnoringOtherApps]) {
		throw HelperError.activationFailed(name)
	}
	usleep(100_000)
}

func rect(_ value: CGRect) -> Rect {
	Rect(
		x: value.origin.x.rounded(),
		y: value.origin.y.rounded(),
		width: value.size.width.rounded(),
		height: value.size.height.rounded()
	)
}

func point(_ value: CGPoint) -> Point {
	Point(x: value.x.rounded(), y: value.y.rounded())
}

func activeDisplays() -> [(index: Int, bounds: CGRect)] {
	var count: UInt32 = 0
	CGGetActiveDisplayList(0, nil, &count)
	var displayIDs = Array(repeating: CGDirectDisplayID(0), count: Int(count))
	CGGetActiveDisplayList(count, &displayIDs, &count)
	return Array(displayIDs.prefix(Int(count))).enumerated().map { item in
		(index: item.offset + 1, bounds: CGDisplayBounds(item.element))
	}
}

func displayForPoint(_ point: CGPoint, displays: [(index: Int, bounds: CGRect)]) -> (index: Int, bounds: CGRect) {
	for display in displays where display.bounds.contains(point) {
		return display
	}
	return displays.first ?? (index: 1, bounds: CGDisplayBounds(CGMainDisplayID()))
}

func matchingWindows(
	ownerName: String?,
	exactTitle: String?,
	titleContains: String?,
) -> [WindowMatch] {
	guard let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
		return []
	}
	let normalizedExactTitle = normalizedText(exactTitle)
	let normalizedContainsTitle = normalizedText(titleContains)
	var matches: [WindowMatch] = []
	for info in windowInfo {
		let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
		let layer = info[kCGWindowLayer as String] as? Int ?? 0
		let owner = info[kCGWindowOwnerName as String] as? String ?? ""
		if alpha <= 0.01 {
			continue
		}
		if let ownerName, owner != ownerName {
			continue
		}
		guard let rawBounds = info[kCGWindowBounds as String] else {
			continue
		}
		let boundsDict = rawBounds as! CFDictionary
		guard
			let bounds = CGRect(dictionaryRepresentation: boundsDict),
			bounds.width >= 80,
			bounds.height >= 80
		else {
			continue
		}
		let windowId = (info[kCGWindowNumber as String] as? NSNumber)?.intValue
		let title = info[kCGWindowName as String] as? String
		let normalizedTitle = normalizedText(title) ?? ""
		if let normalizedExactTitle, normalizedTitle != normalizedExactTitle {
			continue
		}
		if let normalizedContainsTitle, !normalizedTitle.contains(normalizedContainsTitle) {
			continue
		}
		matches.append(WindowMatch(
			id: windowId ?? 0,
			title: title,
			bounds: bounds.integral,
			layer: layer
		))
	}
	return matches
}

func rankWindows(_ matches: [WindowMatch]) -> [WindowMatch] {
	return matches.sorted { lhs, rhs in
		let lhsPrimaryLayer = lhs.layer == 0 ? 0 : 1
		let rhsPrimaryLayer = rhs.layer == 0 ? 0 : 1
		if lhsPrimaryLayer != rhsPrimaryLayer {
			return lhsPrimaryLayer < rhsPrimaryLayer
		}
		if lhs.layer != rhs.layer {
			return lhs.layer < rhs.layer
		}
		let lhsArea = lhs.bounds.width * lhs.bounds.height
		let rhsArea = rhs.bounds.width * rhs.bounds.height
		if lhsArea != rhsArea {
			return lhsArea > rhsArea
		}
		let lhsHasTitle = normalizedText(lhs.title) != nil
		let rhsHasTitle = normalizedText(rhs.title) != nil
		if lhsHasTitle != rhsHasTitle {
			return lhsHasTitle && !rhsHasTitle
		}
		return lhs.id < rhs.id
	}
}

func unionBounds(for matches: [WindowMatch]) -> CGRect? {
	guard let first = matches.first else {
		return nil
	}
	return matches.dropFirst().reduce(first.bounds) { partial, match in
		partial.union(match.bounds)
	}.integral
}

func selectedWindow(
	ownerName: String?,
	exactTitle: String?,
	titleContains: String?,
	index: Int?
) -> WindowSelection? {
	let matches = matchingWindows(
		ownerName: ownerName,
		exactTitle: exactTitle,
		titleContains: titleContains
	)
	guard !matches.isEmpty else {
		return nil
	}
	let hasExplicitSelection = normalizedText(exactTitle) != nil || normalizedText(titleContains) != nil || index != nil
	let ranked = rankWindows(matches)
	if let index, index > 0, index <= ranked.count {
		let window = ranked[index - 1]
		return WindowSelection(
			primary: window,
			captureBounds: window.bounds.integral,
			windowCount: 1,
			captureStrategy: "selected_window"
		)
	}
	guard let primary = ranked.first else {
		return nil
	}
	if hasExplicitSelection {
		return WindowSelection(
			primary: primary,
			captureBounds: primary.bounds.integral,
			windowCount: 1,
			captureStrategy: "selected_window"
		)
	}
	if matches.count == 1 {
		return WindowSelection(
			primary: primary,
			captureBounds: primary.bounds.integral,
			windowCount: 1,
			captureStrategy: "main_window"
		)
	}
	guard let combinedBounds = unionBounds(for: matches) else {
		return nil
	}
	return WindowSelection(
		primary: primary,
		captureBounds: combinedBounds,
		windowCount: matches.count,
		captureStrategy: "app_union"
	)
}

func handleCaptureContext() throws {
	let requestedApp = trimmedEnv("UNDERSTUDY_GUI_APP")
	let requestedWindowTitle = trimmedEnv("UNDERSTUDY_GUI_WINDOW_TITLE")
	let requestedWindowTitleContains = trimmedEnv("UNDERSTUDY_GUI_WINDOW_TITLE_CONTAINS")
	let requestedWindowIndex = optionalInt("UNDERSTUDY_GUI_WINDOW_INDEX")
	if shouldActivateApp() {
		try activateApplication(named: requestedApp)
	}
	let resolvedApp = resolveRequestedApplication(named: requestedApp)
	let targetApp = resolvedApp?.localizedName ?? requestedApp ?? NSWorkspace.shared.frontmostApplication?.localizedName
	let cursorLocation = CGEvent(source: nil)?.location ?? .zero
	let displays = activeDisplays()
	let window = selectedWindow(
		ownerName: targetApp,
		exactTitle: requestedWindowTitle,
		titleContains: requestedWindowTitleContains,
		index: requestedWindowIndex
	)
	let anchorPoint = window.map { CGPoint(x: $0.primary.bounds.midX, y: $0.primary.bounds.midY) } ?? cursorLocation
	let display = displayForPoint(anchorPoint, displays: displays)

	let payload = CaptureContext(
		appName: targetApp,
		display: DisplayDescriptor(index: display.index, bounds: rect(display.bounds)),
		cursor: point(cursorLocation),
		windowId: window?.primary.id,
		windowTitle: window?.primary.title,
		windowBounds: window.map { rect($0.captureBounds) },
		windowCount: window?.windowCount,
		windowCaptureStrategy: window?.captureStrategy
	)

	let encoder = JSONEncoder()
	encoder.outputFormatting = [.sortedKeys]
	let data = try encoder.encode(payload)
	FileHandle.standardOutput.write(data)
}

func makeMouseEvent(_ type: CGEventType, point: CGPoint, button: CGMouseButton = .left) throws -> CGEvent {
	guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
		throw HelperError.eventCreationFailed("mouse_\(type.rawValue)")
	}
	return event
}

func post(_ event: CGEvent) {
	event.post(tap: .cghidEventTap)
}

func moveCursor(to point: CGPoint) throws {
	post(try makeMouseEvent(.mouseMoved, point: point))
	usleep(30_000)
}

func leftDown(at point: CGPoint, clickState: Int64 = 1) throws {
	let event = try makeMouseEvent(.leftMouseDown, point: point)
	event.setIntegerValueField(.mouseEventClickState, value: clickState)
	post(event)
}

func leftUp(at point: CGPoint, clickState: Int64 = 1) throws {
	let event = try makeMouseEvent(.leftMouseUp, point: point)
	event.setIntegerValueField(.mouseEventClickState, value: clickState)
	post(event)
}

func postKeyboardEvent(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags = []) throws {
	guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else {
		throw HelperError.eventCreationFailed("keyboard_\(keyCode)_\(keyDown ? "down" : "up")")
	}
	event.flags = flags
	post(event)
}

let shiftKeyCode: CGKeyCode = 56
let controlKeyCode: CGKeyCode = 59
let optionKeyCode: CGKeyCode = 58
let commandKeyCode: CGKeyCode = 55

func modifierKeySequence(for flags: CGEventFlags) -> [(keyCode: CGKeyCode, mask: CGEventFlags)] {
	var sequence: [(keyCode: CGKeyCode, mask: CGEventFlags)] = []
	if flags.contains(.maskControl) {
		sequence.append((controlKeyCode, .maskControl))
	}
	if flags.contains(.maskAlternate) {
		sequence.append((optionKeyCode, .maskAlternate))
	}
	if flags.contains(.maskCommand) {
		sequence.append((commandKeyCode, .maskCommand))
	}
	if flags.contains(.maskShift) {
		sequence.append((shiftKeyCode, .maskShift))
	}
	return sequence
}

func pressKeyCode(_ keyCode: CGKeyCode, flags: CGEventFlags = []) throws {
	let modifierSequence = modifierKeySequence(for: flags)
	var activeFlags: CGEventFlags = []
	for modifier in modifierSequence {
		activeFlags.formUnion(modifier.mask)
		try postKeyboardEvent(keyCode: modifier.keyCode, keyDown: true, flags: activeFlags)
		usleep(20_000)
	}
	try postKeyboardEvent(keyCode: keyCode, keyDown: true, flags: flags)
	usleep(20_000)
	try postKeyboardEvent(keyCode: keyCode, keyDown: false, flags: flags)
	for modifier in modifierSequence.reversed() {
		activeFlags.subtract(modifier.mask)
		try postKeyboardEvent(
			keyCode: modifier.keyCode,
			keyDown: false,
			flags: activeFlags.union(modifier.mask)
		)
		usleep(20_000)
	}
	usleep(20_000)
}

func pressKeyCodeRepeated(_ keyCode: CGKeyCode, count: Int, flags: CGEventFlags = []) throws {
	let repeatCount = max(0, count)
	for _ in 0..<repeatCount {
		try pressKeyCode(keyCode, flags: flags)
	}
}

let preferredPhysicalTypingInputSourceIDs = [
	"com.apple.keylayout.ABC",
	"com.apple.keylayout.US"
]

func findInputSource(by id: String) -> TISInputSource? {
	let properties = [kTISPropertyInputSourceID as String: id] as CFDictionary
	guard let listRef = TISCreateInputSourceList(properties, false)?.takeRetainedValue() else {
		return nil
	}
	let sources = listRef as NSArray
	return sources.firstObject as! TISInputSource?
}

func selectPhysicalTypingInputSource() -> TISInputSource? {
	let previous = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
	for sourceID in preferredPhysicalTypingInputSourceIDs {
		guard let source = findInputSource(by: sourceID) else {
			continue
		}
		if TISSelectInputSource(source) == noErr {
			usleep(250_000)
			break
		}
	}
	return previous
}

func restoreInputSource(_ source: TISInputSource?) {
	guard let source else { return }
	_ = TISSelectInputSource(source)
	usleep(250_000)
}

let baseKeyCodes: [Character: CGKeyCode] = [
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
	"b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
	"3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
	"0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
	"'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
	" ": 49
]

let shiftedKeyCodes: [Character: CGKeyCode] = [
	"A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
	"B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "!": 18, "@": 19,
	"#": 20, "$": 21, "^": 22, "%": 23, "+": 24, "(": 25, "&": 26, "_": 27, "*": 28,
	")": 29, "}": 30, "O": 31, "U": 32, "{": 33, "I": 34, "P": 35, "L": 37, "J": 38,
	"\"": 39, "K": 40, ":": 41, "|": 42, "<": 43, "?": 44, "N": 45, "M": 46, ">": 47
]

func keyPressForCharacter(_ character: Character) throws -> (keyCode: CGKeyCode, flags: CGEventFlags) {
	if let keyCode = baseKeyCodes[character] {
		return (keyCode, [])
	}
	if let keyCode = shiftedKeyCodes[character] {
		return (keyCode, .maskShift)
	}
	throw HelperError.eventCreationFailed("unsupported_physical_key_\(character)")
}

func typeUnicodeText(_ text: String) throws {
	let utf16 = Array(text.utf16)
	guard !utf16.isEmpty else {
		return
	}
	guard
		let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
		let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
	else {
		throw HelperError.eventCreationFailed("unicode_text")
	}
	keyDown.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
	keyUp.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
	post(keyDown)
	usleep(30_000)
	post(keyUp)
	usleep(30_000)
}

func typePhysicalKeyText(_ text: String) throws {
	let previousInputSource = selectPhysicalTypingInputSource()
	defer {
		restoreInputSource(previousInputSource)
	}
	for character in text {
		let keyPress = try keyPressForCharacter(character)
		try pressKeyCode(keyPress.keyCode, flags: keyPress.flags)
		usleep(90_000)
	}
}

func pasteText(_ text: String) throws {
	let pasteboard = NSPasteboard.general
	let previousString = pasteboard.string(forType: .string)
	pasteboard.clearContents()
	guard pasteboard.setString(text, forType: .string) else {
		throw HelperError.eventCreationFailed("pasteboard_set")
	}
	usleep(100_000)
	try pressKeyCode(9, flags: .maskCommand)
	usleep(150_000)
	pasteboard.clearContents()
	if let previousString {
		_ = pasteboard.setString(previousString, forType: .string)
	}
}

func rightDown(at point: CGPoint, clickState: Int64 = 1) throws {
	let event = try makeMouseEvent(.rightMouseDown, point: point, button: .right)
	event.setIntegerValueField(.mouseEventClickState, value: clickState)
	post(event)
}

func rightUp(at point: CGPoint, clickState: Int64 = 1) throws {
	let event = try makeMouseEvent(.rightMouseUp, point: point, button: .right)
	event.setIntegerValueField(.mouseEventClickState, value: clickState)
	post(event)
}

func drag(from start: CGPoint, to end: CGPoint, steps: Int, durationMs: Int) throws {
	let stepCount = max(1, steps)
	let sleepMicros = useconds_t(max(10_000, (durationMs * 1_000) / stepCount))
	try moveCursor(to: start)
	try leftDown(at: start)
	usleep(50_000)
	for index in 1...stepCount {
		let progress = Double(index) / Double(stepCount)
		let point = CGPoint(
			x: start.x + ((end.x - start.x) * progress),
			y: start.y + ((end.y - start.y) * progress)
		)
		post(try makeMouseEvent(.leftMouseDragged, point: point))
		usleep(sleepMicros)
	}
	try leftUp(at: end)
}

func handleEvent() throws {
	let requestedApp = trimmedEnv("UNDERSTUDY_GUI_APP")
	if shouldActivateApp() {
		try activateApplication(named: requestedApp)
	}
	switch env("UNDERSTUDY_GUI_EVENT_MODE") {
	case "click":
		let point = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: point)
		try leftDown(at: point)
		usleep(30_000)
		try leftUp(at: point)
		print("cg_click")
	case "right_click":
		let point = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: point)
		try rightDown(at: point)
		usleep(30_000)
		try rightUp(at: point)
		print("cg_right_click")
	case "double_click":
		let point = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: point)
		for state in [Int64(1), Int64(2)] {
			try leftDown(at: point, clickState: state)
			usleep(30_000)
			try leftUp(at: point, clickState: state)
			usleep(80_000)
		}
		print("cg_double_click")
	case "hover":
		let point = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		let settleMs = max(0, optionalInt("UNDERSTUDY_GUI_SETTLE_MS") ?? 200)
		try moveCursor(to: point)
		if settleMs > 0 {
			usleep(useconds_t(settleMs * 1_000))
		}
		print("cg_hover")
	case "click_and_hold":
		let point = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		let holdDurationMs = max(100, optionalInt("UNDERSTUDY_GUI_HOLD_DURATION_MS") ?? 650)
		try moveCursor(to: point)
		try leftDown(at: point)
		usleep(useconds_t(holdDurationMs * 1_000))
		try leftUp(at: point)
		print("cg_click_and_hold")
	case "drag":
		let start = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_FROM_X"), y: try requiredDouble("UNDERSTUDY_GUI_FROM_Y"))
		let end = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_TO_X"), y: try requiredDouble("UNDERSTUDY_GUI_TO_Y"))
		let durationMs = try requiredInt("UNDERSTUDY_GUI_DURATION_MS")
		let steps = try requiredInt("UNDERSTUDY_GUI_STEPS")
		try drag(from: start, to: end, steps: steps, durationMs: durationMs)
		print("cg_drag")
	case "scroll":
		if let x = optionalDouble("UNDERSTUDY_GUI_X"), let y = optionalDouble("UNDERSTUDY_GUI_Y") {
			try moveCursor(to: CGPoint(x: x, y: y))
		}
		let vertical = try requiredInt32("UNDERSTUDY_GUI_SCROLL_Y")
		let horizontal = try requiredInt32("UNDERSTUDY_GUI_SCROLL_X")
		let scrollUnit = trimmedEnv("UNDERSTUDY_GUI_SCROLL_UNIT")
		let units: CGScrollEventUnit = scrollUnit == "pixel" ? .pixel : .line
		guard let event = CGEvent(
			scrollWheelEvent2Source: nil,
			units: units,
			wheelCount: 2,
			wheel1: vertical,
			wheel2: horizontal,
			wheel3: 0
		) else {
			throw HelperError.eventCreationFailed("scroll")
		}
		post(event)
		print("cg_scroll")
	case "type_text":
		let rawText = env("UNDERSTUDY_GUI_TEXT")
		let shouldReplace = env("UNDERSTUDY_GUI_REPLACE") != "0"
		let shouldSubmit = env("UNDERSTUDY_GUI_SUBMIT") == "1"
		let typeStrategy = trimmedEnv("UNDERSTUDY_GUI_TYPE_STRATEGY") ?? "unicode"
		let clearRepeat = max(0, optionalInt("UNDERSTUDY_GUI_CLEAR_REPEAT") ?? (typeStrategy == "clipboard_paste" ? 48 : 0))
		if shouldReplace {
			if typeStrategy == "clipboard_paste" {
				try pressKeyCodeRepeated(51, count: clearRepeat)
			} else if typeStrategy == "physical_keys" {
				try pressKeyCodeRepeated(51, count: clearRepeat)
			} else {
				try pressKeyCode(0, flags: .maskCommand)
			}
		}
		if typeStrategy == "clipboard_paste" {
			try pasteText(rawText)
		} else if typeStrategy == "physical_keys" {
			try typePhysicalKeyText(rawText)
		} else {
			try typeUnicodeText(rawText)
		}
		if shouldSubmit {
			try pressKeyCode(36)
		}
		print("cg_type_text")
	default:
		throw HelperError.missingEnv("UNDERSTUDY_GUI_EVENT_MODE")
	}
}

func redactHostWindows() throws {
	guard let inputPath = trimmedEnv("UNDERSTUDY_GUI_REDACT_INPUT"),
		let outputPath = trimmedEnv("UNDERSTUDY_GUI_REDACT_OUTPUT") else {
		throw HelperError.missingEnv("UNDERSTUDY_GUI_REDACT_INPUT/UNDERSTUDY_GUI_REDACT_OUTPUT")
	}
	let owners = env("UNDERSTUDY_GUI_REDACT_OWNERS")
		.split(separator: ",")
		.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
		.filter { !$0.isEmpty }
	let originX = (try? requiredDouble("UNDERSTUDY_GUI_CAPTURE_ORIGIN_X")) ?? 0
	let originY = (try? requiredDouble("UNDERSTUDY_GUI_CAPTURE_ORIGIN_Y")) ?? 0
	let captureWidth = (try? requiredDouble("UNDERSTUDY_GUI_CAPTURE_WIDTH")) ?? 0
	let captureHeight = (try? requiredDouble("UNDERSTUDY_GUI_CAPTURE_HEIGHT")) ?? 0

	guard let image = NSImage(contentsOfFile: inputPath),
		let tiff = image.tiffRepresentation,
		let rep = NSBitmapImageRep(data: tiff) else {
		throw HelperError.invalidCommand("redact: cannot read input image")
	}
	let pixelWidth = rep.pixelsWide
	let pixelHeight = rep.pixelsHigh
	let scaleX = captureWidth > 0 ? Double(pixelWidth) / captureWidth : 1
	let scaleY = captureHeight > 0 ? Double(pixelHeight) / captureHeight : 1
	let captureRect = CGRect(x: originX, y: originY, width: captureWidth, height: captureHeight)

	var rects: [NSRect] = []
	if !owners.isEmpty, captureWidth > 0, captureHeight > 0,
		let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
		for info in windowInfo {
			let owner = (info[kCGWindowOwnerName as String] as? String ?? "").lowercased()
			guard owners.contains(owner) else { continue }
			guard let rawBounds = info[kCGWindowBounds as String],
				let bounds = CGRect(dictionaryRepresentation: rawBounds as! CFDictionary) else { continue }
			let inter = bounds.intersection(captureRect)
			if inter.isNull || inter.width <= 0 || inter.height <= 0 { continue }
			let left = (inter.minX - originX) * scaleX
			let topFromTop = (inter.minY - originY) * scaleY
			let width = inter.width * scaleX
			let height = inter.height * scaleY
			// NSBitmapImageRep drawing uses a bottom-left origin; flip Y.
			let bottom = Double(pixelHeight) - (topFromTop + height)
			rects.append(NSRect(x: left, y: bottom, width: width, height: height))
		}
	}

	if !rects.isEmpty, let ctx = NSGraphicsContext(bitmapImageRep: rep) {
		NSGraphicsContext.saveGraphicsState()
		NSGraphicsContext.current = ctx
		NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
		for rect in rects {
			NSBezierPath(rect: rect).fill()
		}
		ctx.flushGraphics()
		NSGraphicsContext.restoreGraphicsState()
	}

	guard let png = rep.representation(using: .png, properties: [:]) else {
		throw HelperError.invalidCommand("redact: cannot encode output png")
	}
	try png.write(to: URL(fileURLWithPath: outputPath))
	print("redacted \(rects.count)")
}

func watchEscape() throws {
	let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
	guard let tap = CGEvent.tapCreate(
		tap: .cgSessionEventTap,
		place: .headInsertEventTap,
		options: .listenOnly,
		eventsOfInterest: mask,
		callback: { _, _, event, _ in
			if event.getIntegerValueField(.keyboardEventKeycode) == 53 {
				FileHandle.standardOutput.write(Data("escape\n".utf8))
				exit(0)
			}
			return Unmanaged.passUnretained(event)
		},
		userInfo: nil,
	) else {
		throw HelperError.invalidCommand("watch-escape: cannot create event tap (needs Accessibility)")
	}
	let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
	CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
	CGEvent.tapEnable(tap: tap, enable: true)
	CFRunLoopRun()
}

func runHelperCommand(_ command: String) throws {
	switch command {
	case "activate":
		try activateApplication(named: trimmedEnv("UNDERSTUDY_GUI_APP"))
		print("activated")
	case "capture-context":
		try handleCaptureContext()
	case "event":
		try handleEvent()
	case "redact":
		try redactHostWindows()
	case "watch-escape":
		try watchEscape()
	default:
		throw HelperError.invalidCommand(command)
	}
}

do {
	let command = CommandLine.arguments.dropFirst().first ?? ""
	if command == "serve" {
		// Persistent serve mode: read one JSON request per line ({command, env}),
		// run it with that request's env, and terminate each response with a
		// sentinel line so the caller can frame the output without capturing fds.
		FileHandle.standardError.write(Data("understudy-gui-native-helper serve ready\n".utf8))
		while let line = readLine(strippingNewline: true) {
			if line.isEmpty { continue }
			guard let data = line.data(using: .utf8),
				let request = try? JSONDecoder().decode(ServeRequest.self, from: data) else {
				print("__UNDERSTUDY_SERVE_DONE__ err invalid serve request")
				fflush(stdout)
				continue
			}
			requestEnvOverride = request.env ?? [:]
			do {
				try runHelperCommand(request.command)
				print("__UNDERSTUDY_SERVE_DONE__ ok")
			} catch {
				print("__UNDERSTUDY_SERVE_DONE__ err \(error)")
			}
			requestEnvOverride = nil
			fflush(stdout)
		}
	} else {
		try runHelperCommand(command)
	}
} catch {
	fputs("Understudy native GUI helper failed: \(error)\n", stderr)
	exit(1)
}
`;

let helperBinaryPath: string | undefined;
let helperBinaryPromise: Promise<string> | undefined;

function formatExecFailure(error: unknown): string {
	const record = error as {
		message?: string;
		stderr?: string;
		stdout?: string;
	};
	const details = [record.stderr, record.stdout]
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter(Boolean)
		.join(" ");
	return [record.message ?? String(error), details].filter(Boolean).join(" ").trim();
}

export async function resolveNativeGuiHelperBinary(): Promise<string> {
	const overridePath = process.env.UNDERSTUDY_GUI_NATIVE_HELPER_PATH?.trim();
	if (overridePath) {
		return overridePath;
	}
	if (helperBinaryPath) {
		try {
			await access(helperBinaryPath);
			return helperBinaryPath;
		} catch {
			helperBinaryPath = undefined;
		}
	}
	if (helperBinaryPromise) {
		return await helperBinaryPromise;
	}

	helperBinaryPromise = (async () => {
		const sourceHash = createHash("sha256")
			.update(NATIVE_GUI_HELPER_SOURCE)
			.digest("hex")
			.slice(0, 16);
		const helperDir = join(tmpdir(), "understudy-gui-native-helper", sourceHash);
		const sourcePath = join(helperDir, `${HELPER_BINARY_NAME}.swift`);
		const binaryPath = join(helperDir, HELPER_BINARY_NAME);

		try {
			await access(binaryPath);
			helperBinaryPath = binaryPath;
			helperBinaryPromise = undefined;
			return binaryPath;
		} catch {
			// Fall through to compile a fresh helper binary.
		}

		await mkdir(helperDir, { recursive: true });
		await writeFile(sourcePath, NATIVE_GUI_HELPER_SOURCE, "utf-8");
		try {
			await execFileAsync("swiftc", [sourcePath, "-o", binaryPath], {
				timeout: HELPER_COMPILE_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf-8",
			});
		} catch (error) {
			const message = formatExecFailure(error);
			throw new Error(
				`Failed to compile the Understudy macOS GUI helper. Ensure Xcode Command Line Tools are installed and "swiftc" is available. ${message}`.trim(),
			);
		}

		helperBinaryPath = binaryPath;
		helperBinaryPromise = undefined;
		return binaryPath;
	})().catch((error) => {
		helperBinaryPromise = undefined;
		throw error;
	});

	return await helperBinaryPromise;
}
