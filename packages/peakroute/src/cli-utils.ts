import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync, spawn } from "node:child_process";
import { PEAKROUTE_HEADER } from "./proxy.js";
import {
  IS_WINDOWS,
  SYSTEM_STATE_DIR,
  USER_STATE_DIR,
  PRIVILEGED_PORT_THRESHOLD,
} from "./platform.js";

// Re-export platform constants for backward compatibility
export { SYSTEM_STATE_DIR, USER_STATE_DIR, PRIVILEGED_PORT_THRESHOLD } from "./platform.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default proxy port. Uses an unprivileged port so sudo is not required. */
export const DEFAULT_PROXY_PORT = 1355;

/** Minimum app port when finding a free port. */
const MIN_APP_PORT = 4000;

/** Maximum app port when finding a free port. */
const MAX_APP_PORT = 4999;

/** Number of random port attempts before sequential scan. */
const RANDOM_PORT_ATTEMPTS = 50;

/** TCP connect timeout (ms) when checking if something is listening. */
const SOCKET_TIMEOUT_MS = 500;

/** Timeout (ms) for lsof when finding a PID on a port. */
const LSOF_TIMEOUT_MS = 5000;

/** Maximum poll attempts when waiting for the proxy to become ready. */
export const WAIT_FOR_PROXY_MAX_ATTEMPTS = 20;

/** Interval (ms) between proxy readiness polls. */
export const WAIT_FOR_PROXY_INTERVAL_MS = 250;

/** Signal name to signal number mapping for exit code calculation. */
export const SIGNAL_CODES: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGTERM: 15,
};

// ---------------------------------------------------------------------------
// Port configuration
// ---------------------------------------------------------------------------

/**
 * Return the effective default proxy port. Reads the PEAKROUTE_PORT env var
 * first, falling back to DEFAULT_PROXY_PORT (1355).
 */
export function getDefaultPort(): number {
  const envPort = process.env.PEAKROUTE_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) return port;
  }
  return DEFAULT_PROXY_PORT;
}

// ---------------------------------------------------------------------------
// State directory resolution
// ---------------------------------------------------------------------------

/**
 * Determine the state directory for a given proxy port.
 * Privileged ports (< 1024) use the system dir (/tmp/peakroute) so both
 * root and non-root processes can share state. Unprivileged ports use
 * the user's home directory (~/.peakroute).
 *
 * On Windows, always uses the user state directory since there's no
 * privileged port concept.
 */
export function resolveStateDir(port: number): string {
  if (process.env.PEAKROUTE_STATE_DIR) return process.env.PEAKROUTE_STATE_DIR;
  // No Windows, não existe conceito de ports privilegiadas
  if (IS_WINDOWS) return USER_STATE_DIR;
  return port < PRIVILEGED_PORT_THRESHOLD ? SYSTEM_STATE_DIR : USER_STATE_DIR;
}

/** Read the proxy port from a given state directory. Returns null if unreadable. */
export function readPortFromDir(dir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "proxy.port"), "utf-8").trim();
    const port = parseInt(raw, 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/** Name of the marker file that indicates the proxy is running with TLS. */
const TLS_MARKER_FILE = "proxy.tls";

/** Read the TLS marker from a state directory. */
export function readTlsMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, TLS_MARKER_FILE));
  } catch {
    return false;
  }
}

/** Write or remove the TLS marker in the state directory. */
export function writeTlsMarker(dir: string, enabled: boolean): void {
  const markerPath = path.join(dir, TLS_MARKER_FILE);
  if (enabled) {
    fs.writeFileSync(markerPath, "1", { mode: 0o644 });
  } else {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // Marker may already be absent; non-fatal
    }
  }
}

/**
 * Return whether HTTPS mode is requested via the PEAKROUTE_HTTPS env var.
 */
export function isHttpsEnvEnabled(): boolean {
  const val = process.env.PEAKROUTE_HTTPS;
  return val === "1" || val === "true";
}

/**
 * Discover the active proxy's state directory, port, and TLS mode.
 * Checks the user-level dir first, then the system-level dir.
 * Falls back to the system dir with the default port if nothing is running.
 */
export async function discoverState(): Promise<{ dir: string; port: number; tls: boolean }> {
  // Env var override
  if (process.env.PEAKROUTE_STATE_DIR) {
    const dir = process.env.PEAKROUTE_STATE_DIR;
    const port = readPortFromDir(dir) ?? getDefaultPort();
    const tls = readTlsMarker(dir);
    return { dir, port, tls };
  }

  // Check user-level state first (~/.peakroute)
  const userPort = readPortFromDir(USER_STATE_DIR);
  if (userPort !== null) {
    const tls = readTlsMarker(USER_STATE_DIR);
    if (await isProxyRunning(userPort, tls)) {
      return { dir: USER_STATE_DIR, port: userPort, tls };
    }
  }

  // Check system-level state (/tmp/peakroute)
  const systemPort = readPortFromDir(SYSTEM_STATE_DIR);
  if (systemPort !== null) {
    const tls = readTlsMarker(SYSTEM_STATE_DIR);
    if (await isProxyRunning(systemPort, tls)) {
      return { dir: SYSTEM_STATE_DIR, port: systemPort, tls };
    }
  }

  // Nothing running; fall back based on default port
  const defaultPort = getDefaultPort();
  return { dir: resolveStateDir(defaultPort), port: defaultPort, tls: false };
}

// ---------------------------------------------------------------------------
// Port utilities
// ---------------------------------------------------------------------------

/**
 * Find a free port in the given range (default 4000-4999).
 * Tries random ports first for speed, then falls back to sequential scan.
 *
 * Note: There is an inherent TOCTOU race between verifying a port is free
 * and the child process actually binding to it. The random-first strategy
 * minimizes the window.
 */
export async function findFreePort(
  minPort = MIN_APP_PORT,
  maxPort = MAX_APP_PORT
): Promise<number> {
  if (minPort > maxPort) {
    throw new Error(`minPort (${minPort}) must be <= maxPort (${maxPort})`);
  }

  const tryPort = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
      server.on("error", () => resolve(false));
    });
  };

  // Try random ports first
  for (let i = 0; i < RANDOM_PORT_ATTEMPTS; i++) {
    const port = minPort + Math.floor(Math.random() * (maxPort - minPort + 1));
    if (await tryPort(port)) {
      return port;
    }
  }

  // Fall back to sequential
  for (let port = minPort; port <= maxPort; port++) {
    if (await tryPort(port)) {
      return port;
    }
  }

  throw new Error(`No free port found in range ${minPort}-${maxPort}`);
}

/**
 * Check if a peakroute proxy is listening on the given port at 127.0.0.1.
 * Makes an HTTP(S) request and verifies the X-Peakroute response header to
 * distinguish the peakroute proxy from unrelated services.
 *
 * When `tls` is true, uses HTTPS with certificate verification disabled
 * (the proxy may use a self-signed or locally-trusted CA cert).
 */
export function isProxyRunning(port: number, tls = false): Promise<boolean> {
  return new Promise((resolve) => {
    const requestFn = tls ? https.request : http.request;
    const req = requestFn(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "HEAD",
        timeout: SOCKET_TIMEOUT_MS,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.resume();
        resolve(res.headers[PEAKROUTE_HEADER.toLowerCase()] === "1");
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Process utilities
// ---------------------------------------------------------------------------

/**
 * Parseia o output do netstat no Windows para extrair o PID.
 * Evita o bug de substring matching (ex: porta 80 encontrando 8080).
 * PR #6: Parsing correto do formato "TCP    127.0.0.1:80    0.0.0.0:0    LISTENING    1234"
 */
function parsePidFromNetstat(output: string, port: number): number | null {
  const lines = output.split("\n");
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    // parts[1] = local address (ex: "127.0.0.1:80" ou "[::]:80")
    const localAddr = parts[1];
    const addrMatch = localAddr.match(/:(\d+)$/);
    if (!addrMatch) continue;
    const foundPort = parseInt(addrMatch[1], 10);
    if (foundPort === port && parts[3] === "LISTENING") {
      const pid = parseInt(parts[4], 10);
      if (!isNaN(pid)) return pid;
    }
  }
  return null;
}

/**
 * Try to find the PID of a process listening on the given TCP port.
 * Uses lsof on Unix (macOS/Linux) and netstat on Windows.
 * Returns null if the PID cannot be determined.
 */
export function findPidOnPort(port: number): number | null {
  if (IS_WINDOWS) {
    try {
      const output = execSync(`netstat -ano -p tcp`, {
        encoding: "utf-8",
        timeout: LSOF_TIMEOUT_MS,
      });
      return parsePidFromNetstat(output, port);
    } catch {
      return null;
    }
  }

  // Unix (macOS/Linux)
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: LSOF_TIMEOUT_MS,
    });
    // lsof may return multiple PIDs (one per line); take the first
    const pid = parseInt(output.trim().split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Poll until the proxy is listening or the timeout is reached.
 * Returns true if the proxy became ready, false on timeout.
 */
export async function waitForProxy(
  port: number,
  maxAttempts = WAIT_FOR_PROXY_MAX_ATTEMPTS,
  intervalMs = WAIT_FOR_PROXY_INTERVAL_MS,
  tls = false
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (await isProxyRunning(port, tls)) {
      return true;
    }
  }
  return false;
}

/** Escape a string for safe inclusion in a single-quoted shell argument. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Walk up from `cwd` to the filesystem root, collecting all
 * `node_modules/.bin` directories that exist. Returns them in
 * nearest-first order so the closest binaries take priority.
 */
function collectBinPaths(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = cwd;
  for (;;) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (fs.existsSync(bin)) {
      dirs.push(bin);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Build a PATH string with `node_modules/.bin` directories prepended.
 * On Windows, ensures essential system directories are included for PowerShell
 * and other system tools to be found.
 */
function augmentedPath(env: NodeJS.ProcessEnv | undefined): string {
  const base = (env ?? process.env).PATH ?? "";
  const bins = collectBinPaths(process.cwd());

  if (IS_WINDOWS) {
    // Ensure essential Windows directories are in PATH
    // This fixes issues when running from Git Bash, MSYS2, or other shells
    // that may not include System32 in the PATH
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const essentialPaths = [
      path.join(systemRoot, "System32"),
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
      path.join(systemRoot, "System32", "wbem"), // for WMI tools
    ];

    // Ensure Bun is in PATH - common installation locations
    const bunPaths = [
      path.join(process.env.USERPROFILE ?? "C:\\Users\\" + process.env.USERNAME, ".bun", "bin"),
      path.join(process.env.LOCALAPPDATA ?? "", "bun", "bin"),
    ];

    const pathEntries = base.split(path.delimiter).filter(Boolean);

    // Add missing system paths
    const missingSystemPaths = essentialPaths.filter((p) =>
      pathEntries.every((entry) => entry.toLowerCase() !== p.toLowerCase())
    );

    // Add missing Bun paths
    const missingBunPaths = bunPaths.filter((p) =>
      pathEntries.every((entry) => entry.toLowerCase() !== p.toLowerCase())
    );

    const allMissing = [...missingSystemPaths, ...missingBunPaths];
    if (allMissing.length > 0) {
      const newPath = allMissing.join(path.delimiter) + path.delimiter + base;
      if (bins.length > 0) {
        return bins.join(path.delimiter) + path.delimiter + newPath;
      }
      return newPath;
    }
  }

  return bins.length > 0 ? bins.join(path.delimiter) + path.delimiter + base : base;
}

/**
 * Spawn a command with proper signal forwarding, error handling, and exit
 * code propagation. Uses /bin/sh on Unix so that shell scripts and version manager
 * shims are resolved. On Windows, uses shell mode to support .cmd files.
 * Prepends node_modules/.bin to PATH so local project binaries (e.g. next, vite) are found.
 *
 * PR #6: shell: true no Windows para executar .cmd scripts (npm/pnpm).
 */
export function spawnCommand(
  commandArgs: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    onCleanup?: () => void;
  }
): void {
  const env = { ...(options?.env ?? process.env), PATH: augmentedPath(options?.env) };

  let child: ReturnType<typeof spawn>;

  if (IS_WINDOWS) {
    // Windows: use cmd.exe /c para executar comandos.
    // Usamos cmd.exe diretamente em vez de shell: true para ter mais controle
    // e garantir que o PATH seja herdado corretamente do processo pai.
    // Isso resolve problemas com ferramentas como bun que podem estar no PATH
    // do usuário mas não no PATH padrão do sistema.
    const shellCmd = commandArgs
      .map((a) => {
        // Escape para cmd.exe: envolve em aspas se tiver espaços ou caracteres especiais
        if (/[\s"&<>|^]/.test(a)) {
          return `"${a.replace(/"/g, '""')}"`;
        }
        return a;
      })
      .join(" ");
    child = spawn("cmd.exe", ["/c", shellCmd], {
      stdio: "inherit",
      env,
      windowsHide: true,
    });
  } else {
    // Unix: usa /bin/sh
    const shellCmd = commandArgs.map(shellEscape).join(" ");
    child = spawn("/bin/sh", ["-c", shellCmd], {
      stdio: "inherit",
      env,
    });
  }

  let exiting = false;

  const cleanup = () => {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    options?.onCleanup?.();
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    child.kill(signal);
    cleanup();
    process.exit(128 + (SIGNAL_CODES[signal] || 15));
  };

  const onSigInt = () => handleSignal("SIGINT");
  const onSigTerm = () => handleSignal("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  child.on("error", (err) => {
    if (exiting) return;
    exiting = true;
    console.error(`Failed to run command: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Is "${commandArgs[0]}" installed and in your PATH?`);
    }
    cleanup();
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    cleanup();
    if (signal) {
      process.exit(128 + (SIGNAL_CODES[signal] || 15));
    }
    process.exit(code ?? 1);
  });
}

// ---------------------------------------------------------------------------
// Framework-aware flag injection
// ---------------------------------------------------------------------------

/**
 * Frameworks that ignore the `PORT` env var. Maps command basename to the
 * flags needed. `strictPort` indicates whether `--strictPort` is supported
 * (prevents the framework from silently picking a different port).
 *
 * SvelteKit is not listed because its dev server is Vite under the hood,
 * so the `vite` entry already covers it.
 */
const FRAMEWORKS_NEEDING_PORT: Record<string, { strictPort: boolean }> = {
  vite: { strictPort: true },
  "react-router": { strictPort: true },
  astro: { strictPort: false },
  ng: { strictPort: false },
};

/**
 * Package managers that wrap framework commands.
 * Used to detect frameworks when running via npm/yarn/pnpm/bun scripts.
 */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);

/**
 * Detect which framework command will actually run based on package.json scripts.
 * Returns the base command name (e.g., "ng", "vite") or null if not detected.
 */
function detectFrameworkFromPackageJson(scriptName: string): string | null {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (!fs.existsSync(pkgPath)) return null;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const script = pkg.scripts?.[scriptName];
    if (!script) return null;

    // Check for framework commands in the script
    for (const [framework] of Object.entries(FRAMEWORKS_NEEDING_PORT)) {
      // Match framework command as a word boundary:
      // - At start of string
      // - After whitespace, semicolon, ampersand, pipe (command separators)
      // - After a path separator (for paths like ./node_modules/.bin/ng)
      // - After cross-env with any env vars
      // Must be followed by whitespace or end of string
      const regex = new RegExp(
        `(?:^|[\\s;&|/]|cross-env(?:\\s+[^\\s]+)*\\s+)${framework}(?=\\s|$)`,
        "i"
      );
      if (regex.test(script)) {
        return framework;
      }
    }
  } catch {
    // Ignore parse errors or file issues
  }
  return null;
}

/**
 * Extract the script name from command args when using a package manager.
 * Returns null if no script name can be determined.
 */
function extractScriptName(commandArgs: string[], basename: string): string | null {
  // Look for "run <script>" pattern: npm run start, pnpm run dev, etc.
  const runIndex = commandArgs.indexOf("run");
  if (runIndex !== -1 && runIndex + 1 < commandArgs.length) {
    return commandArgs[runIndex + 1];
  }

  // yarn, pnpm and bun can run scripts directly without "run": yarn start, pnpm dev
  if (basename === "yarn" || basename === "bun" || basename === "pnpm") {
    const scriptName = commandArgs[1];
    if (scriptName && !scriptName.startsWith("-")) {
      return scriptName;
    }
  }

  return null;
}

/**
 * Resolve the framework config from command arguments.
 * Returns null if no framework is detected.
 */
function resolveFramework(commandArgs: string[]): { name: string; strictPort: boolean } | null {
  const cmd = commandArgs[0];
  if (!cmd) return null;

  const basename = path.basename(cmd);

  // Direct framework invocation (e.g., "ng serve", "vite dev")
  const directFramework = FRAMEWORKS_NEEDING_PORT[basename];
  if (directFramework) {
    return { name: basename, ...directFramework };
  }

  // Package manager invocation (e.g., "npm run start")
  if (!PACKAGE_MANAGERS.has(basename)) return null;

  const scriptName = extractScriptName(commandArgs, basename);
  if (!scriptName) return null;

  const detectedFramework = detectFrameworkFromPackageJson(scriptName);
  if (!detectedFramework) return null;

  return { name: detectedFramework, ...FRAMEWORKS_NEEDING_PORT[detectedFramework] };
}

/**
 * Inject port and host flags if not already present.
 * Mutates commandArgs in-place.
 */
function injectPortAndHostFlags(commandArgs: string[], port: number, strictPort: boolean): void {
  if (!commandArgs.includes("--port")) {
    commandArgs.push("--port", port.toString());
    if (strictPort) {
      commandArgs.push("--strictPort");
    }
  }

  if (!commandArgs.includes("--host")) {
    commandArgs.push("--host", "127.0.0.1");
  }
}

/**
 * Check if `commandArgs` invokes a framework that ignores `PORT` and, if so,
 * mutate the array in-place to append the correct CLI flags so the app
 * listens on the expected port and address.
 *
 * The peakroute proxy connects to 127.0.0.1 (IPv4), so we also inject
 * `--host 127.0.0.1` to prevent frameworks from binding to IPv6 `::1`.
 *
 * @param manualFramework - Optional framework name to force injection (e.g., "ng", "vite").
 *                        Overrides automatic detection when provided.
 */
export function injectFrameworkFlags(
  commandArgs: string[],
  port: number,
  manualFramework?: string
): void {
  // If "force" is provided, inject flags without strictPort (generic fallback)
  if (manualFramework === "force") {
    injectPortAndHostFlags(commandArgs, port, false);
    return;
  }

  // Use manual framework if provided and valid
  if (manualFramework && FRAMEWORKS_NEEDING_PORT[manualFramework]) {
    injectPortAndHostFlags(commandArgs, port, FRAMEWORKS_NEEDING_PORT[manualFramework].strictPort);
    return;
  }

  const framework = resolveFramework(commandArgs);
  if (framework) {
    injectPortAndHostFlags(commandArgs, port, framework.strictPort);
  }
}

/**
 * Prompt the user for input via readline. Returns empty string if stdin closes.
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.on("close", () => resolve(""));
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ---------------------------------------------------------------------------
// Update checker
// ---------------------------------------------------------------------------

/** Cache duration for update checks (24 hours in milliseconds) */
const UPDATE_CHECK_CACHE_MS = 24 * 60 * 60 * 1000;

interface UpdateCheckCache {
  version: string;
  lastCheck: number;
}

/**
 * Get the path to the update check cache file.
 */
function getUpdateCachePath(): string {
  return path.join(USER_STATE_DIR, ".update-check.json");
}

/**
 * Compare two semantic version strings.
 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/**
 * Check if an update is available, respecting cache.
 * Returns the newer version string if available, null otherwise.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  // Skip if PEAKROUTE_NO_UPDATE_CHECK is set
  if (process.env.PEAKROUTE_NO_UPDATE_CHECK) {
    return null;
  }

  const cachePath = getUpdateCachePath();

  // Check cache first
  try {
    const cache: UpdateCheckCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (Date.now() - cache.lastCheck < UPDATE_CHECK_CACHE_MS) {
      // Use cached result
      if (compareVersions(cache.version, currentVersion) > 0) {
        return cache.version;
      }
      return null;
    }
  } catch {
    // Cache doesn't exist or is invalid
  }

  // Fetch latest version from npm registry
  return new Promise((resolve) => {
    const req = https.get(
      "https://registry.npmjs.org/peakroute/latest",
      {
        timeout: 3000,
        headers: {
          Accept: "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const response = JSON.parse(data);
            const latestVersion = response.version as string;

            // Save to cache
            const cache: UpdateCheckCache = {
              version: latestVersion,
              lastCheck: Date.now(),
            };
            try {
              fs.mkdirSync(USER_STATE_DIR, { recursive: true });
              fs.writeFileSync(cachePath, JSON.stringify(cache), { mode: 0o644 });
            } catch {
              // Ignore cache write errors
            }

            if (compareVersions(latestVersion, currentVersion) > 0) {
              resolve(latestVersion);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.setTimeout(3000);
  });
}
