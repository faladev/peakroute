import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { IS_WINDOWS } from "./platform.js";

/**
 * Wrapper seguro para chmod que é no-op no Windows.
 * PR #50 pattern: evita condicionais espalhadas pelo código.
 */
export function chmodSafe(path: string, mode: number): void {
  if (IS_WINDOWS) return; // No-op no Windows
  try {
    fs.chmodSync(path, mode);
  } catch {
    // Non-fatal
  }
}

/**
 * Async version of chmodSafe.
 */
export async function chmodSafeAsync(path: string, mode: number): Promise<void> {
  if (IS_WINDOWS) return;
  try {
    await fs.promises.chmod(path, mode);
  } catch {
    // Non-fatal
  }
}

/**
 * When running under sudo, fix file ownership so the real user can
 * read/write the file later without sudo. No-op when not running as root.
 * On Windows, this is a no-op since there's no concept of uid/gid.
 */
export function fixOwnership(...paths: string[]): void {
  if (IS_WINDOWS) return; // No-op no Windows - sem conceito de uid/gid
  const uid = process.env.SUDO_UID;
  const gid = process.env.SUDO_GID;
  if (!uid || process.getuid?.() !== 0) return;
  for (const p of paths) {
    try {
      fs.chownSync(p, parseInt(uid, 10), parseInt(gid || uid, 10));
    } catch {
      // Best-effort
    }
  }
}

/** Type guard for Node.js system errors with an error code. */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format a .localhost URL. Omits the port when it matches the protocol default
 * (80 for HTTP, 443 for HTTPS).
 */
export function formatUrl(hostname: string, proxyPort: number, tls = false): string {
  const proto = tls ? "https" : "http";
  const defaultPort = tls ? 443 : 80;
  return proxyPort === defaultPort
    ? `${proto}://${hostname}`
    : `${proto}://${hostname}:${proxyPort}`;
}

/**
 * Detect if we're in a git worktree and return the branch name.
 * Returns null if not in a worktree or if git is not available.
 */
export function detectGitWorktree(): string | null {
  try {
    // Check if we're in a git repo
    const gitDir = execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    // Check if this is a worktree (not the main repo)
    // Worktrees have .git pointing to <main-repo>/.git/worktrees/<name>
    const isWorktree = gitDir.includes("/worktrees/") || gitDir.includes("\\worktrees\\");
    if (!isWorktree) return null;

    // Get branch name
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Sanitize branch name for use in hostname.
 * Replaces / with - and removes invalid characters.
 */
export function sanitizeBranchName(branch: string): string {
  return branch
    .replace(/\//g, "-") // feat/login -> feat-login
    .replace(/[^a-zA-Z0-9-]/g, ""); // remove invalid characters
}

/**
 * Parse and normalize a hostname input for use as a .localhost subdomain.
 * Strips protocol prefixes, validates characters, and appends .localhost if needed.
 * When in a git worktree, prepends the branch name as a subdomain prefix.
 */
export function parseHostname(input: string): string {
  // Remove any protocol prefix
  let hostname = input
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .toLowerCase();

  // Validate non-empty
  if (!hostname || hostname === ".localhost") {
    throw new Error("Hostname cannot be empty");
  }

  // Check if already has .localhost - if so, don't modify further
  if (hostname.endsWith(".localhost")) {
    return hostname;
  }

  // Detect git worktree and prepend branch name
  const branch = detectGitWorktree();
  if (branch) {
    const sanitized = sanitizeBranchName(branch);
    hostname = `${sanitized}.${hostname}.localhost`;
  } else {
    hostname = `${hostname}.localhost`;
  }

  // Validate hostname characters (letters, digits, hyphens, dots)
  const name = hostname.replace(/\.localhost$/, "");
  if (name.includes("..")) {
    throw new Error(`Invalid hostname "${name}": consecutive dots are not allowed`);
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid hostname "${name}": must contain only lowercase letters, digits, hyphens, and dots`
    );
  }

  return hostname;
}
