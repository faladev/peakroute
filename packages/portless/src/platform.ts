import * as path from "node:path";
import * as os from "node:os";

/**
 * Platform detection constants
 */
export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/**
 * System-wide state directory (used when proxy needs elevated permissions).
 * On Windows, uses the temp directory since there's no privileged port concept.
 */
export const SYSTEM_STATE_DIR = IS_WINDOWS ? path.join(os.tmpdir(), "portless") : "/tmp/portless";

/**
 * Per-user state directory (used when proxy runs without sudo).
 */
export const USER_STATE_DIR = path.join(os.homedir(), ".portless");

/**
 * Threshold for privileged ports. On Unix, ports < 1024 require root.
 * On Windows, there's no such restriction.
 */
export const PRIVILEGED_PORT_THRESHOLD = 1024;
