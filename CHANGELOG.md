# Changelog

## 0.6.0 (Unreleased)

### Features

- **`PEAKROUTE_URL` environment variable**: Child processes now receive `PEAKROUTE_URL` containing the public `.localhost` URL (e.g., `http://myapp.localhost:1355`). This allows apps to self-reference without hardcoding the URL.

- **Multi-distribution Linux CA trust support**: The `trust` command now supports multiple Linux distributions:
  - **Debian/Ubuntu**: `/usr/local/share/ca-certificates/` + `update-ca-certificates`
  - **Fedora/RHEL/CentOS/Rocky/Alma**: `/etc/pki/ca-trust/source/anchors/` + `update-ca-trust extract`
  - **Arch Linux**: `/etc/ca-certificates/trust-source/anchors/` + `update-ca-trust`
  - **openSUSE**: `/etc/pki/trust/anchors/` + `update-ca-certificates`

  Detection uses `/etc/os-release` with fallback to command availability.

## 0.5.8

### Features

- **Update notification**: Show a friendly update message when a new version is available. Checks npm registry once per day (cached) and displays:

  ```
  → Update available: 0.6.0 (current: 0.5.8)
    Run: npm install -g peakroute
  ```

  Disable with `PEAKROUTE_NO_UPDATE_CHECK=1` environment variable.

- **`--inject` flag for manual framework flag injection**: Add `--inject` flag to force injection of `--port` and `--host` flags even when automatic framework detection fails. Useful for custom servers or frameworks not yet supported by auto-detection.

  ```bash
  peakroute --inject myapp custom-server --watch
  ```

- **Automatic update notifications**: Show a friendly message when a new version is available. Checks npm registry once per day (cached). Can be disabled with `PEAKROUTE_NO_UPDATE_CHECK=1`.
  ```bash
  → Update available: 0.5.9 (current: 0.5.8)
    Run: npm install -g peakroute
  ```

### Bug Fixes

- **Angular framework detection via npm/yarn/pnpm/bun**: Fix `peakroute` not detecting Angular when running via package manager scripts (e.g., `npm run start`). Previously, the framework detection only worked when calling `ng serve` directly. Now it parses `package.json` to detect Angular, Vite, Astro, and React Router when invoked via `npm run`, `yarn`, `pnpm`, or `bun` commands.

## 0.5.7

### Improvements

- **CI/OpenSSL on Windows**: Configure OpenSSL path on Windows runners to ensure certificate generation tests work reliably.
- **CI/Release dependency**: Make release workflow wait for CI and E2E Git Bash workflows to pass before publishing to npm.

## 0.5.6

### Improvements

- **CI/Git Bash testing**: Add separate GitHub Actions workflow (`e2e-gitbash.yml`) to run e2e tests specifically in Git Bash on Windows. This catches path conversion issues that don't appear in CMD or PowerShell.

### Bug Fixes

- **Git Bash process termination**: Fix `peakroute proxy stop` failing on Git Bash due to path conversion issues. Git Bash converts `/F` to `F:/` when used in shell commands. Fixed by using `spawnSync` with array arguments instead of `execSync` with string, and always using `/F` flag for reliable termination of Node.js processes on Windows.

## 0.5.5

### Improvements

- **E2E test harness**: Add Python setup script for cross-platform virtual environment setup in end-to-end tests.
- **Cross-platform formatting**: Enforce LF line endings via `.prettierrc` and `.gitattributes` for consistent formatting across Windows, macOS, and Linux.

### Bug Fixes

- **CI Windows paths**: Fix path separators in GitHub Actions workflow for Windows e2e test setup.

## 0.5.4

### Bug Fixes

- **Missing README on npm**: Include README.md in package files so it appears on npm registry page.

## 0.5.3

### Bug Fixes

- **Windows process termination**: Add cross-platform `killProcess()` function that uses `taskkill` on Windows for reliable termination of detached proxy processes.
- **Windows PATH handling**: Ensure essential Windows system directories (System32, PowerShell, WMI) are included in PATH when running from Git Bash or other shells.
- **Bun detection on Windows**: Add Bun installation directories (`~/.bun/bin`, `%LOCALAPPDATA%/bun/bin`) to PATH when spawning commands on Windows. Fixes "'bun' is not recognized as a command" error when running via PowerShell.
- **Windows command execution**: Refactor spawn to use `cmd.exe /c` directly instead of PowerShell detection, providing more reliable PATH inheritance and simpler command execution.

## 0.5.2

### Bug Fixes

- **PowerShell command execution**: Fix Bun and other tools not found when running in PowerShell. The CLI now detects PowerShell via `PSModulePath` and executes commands through `powershell.exe` instead of `cmd.exe`, ensuring tools installed via PowerShell (like Bun) are correctly resolved.
- **Exit code propagation on Windows**: Fix exit codes not being propagated when running commands in PowerShell mode. Added `exit $LASTEXITCODE` to ensure child process exit codes are correctly returned to the parent.

## 0.5.1

### Features

- **Automated CI/CD pipeline**: Add GitHub Actions workflow for automated releases:
  - Automatic version detection on push to main
  - Automated npm publishing with OIDC trusted publishing
  - Automatic GitHub Release creation with source artifacts
  - Automatic git tag creation
  - Release scripts for Unix (`release.sh`) and Windows (`release.ps1`)

## 0.5.0

### Features

- **Windows support**: Full Windows platform support including:
  - Process management using `netstat` instead of `lsof`
  - Certificate trust store integration via `certutil`
  - Platform-specific error messages (Administrator vs sudo)
  - Command spawning with Windows shell support
  - Daemon process spawning with `windowsHide: true`
  - Updated package.json OS field to include `win32`
  - New `platform.ts` module for platform detection and constants

### Changes

- **Repository**: Changed repository URL from `vercel-labs/portless` to `faladev/peakroute`
- **Author**: Updated author to `FalaDev`

## 0.4.2

### Bug Fixes

- **spawn ENOENT**: Use `/bin/sh -c` for command execution so shell scripts and version-manager shims (nvm, fnm, mise) are resolved correctly. Prepend `node_modules/.bin` to `PATH` so local project binaries (e.g. `next`, `vite`) are found without a global install. (#21, #29)
- **sudo state directory permissions**: System state directory (`/tmp/portless`) now uses world-writable + sticky-bit permissions (`1777`) so non-root processes can register routes after a sudo proxy start. Route and state files created under sudo are chowned back to the real user. (#16)
- **duplicate route names**: `addRoute` now checks for an existing live route and throws `RouteConflictError` if the hostname is already registered by a running process. Use `--force` to override. (#38)
- **TLS SHA-1 rejection**: Force SHA-256 for all CA and server certificate generation. Detect and regenerate existing SHA-1 certificates automatically. Uses the `openssl` CLI for signature algorithm checks to maintain compatibility with Node.js < 24.9. (#36)
- **per-hostname certs for `.localhost` subdomains**: Issue a per-hostname certificate with an exact SAN for every `.localhost` subdomain (including single-level like `myapp.localhost`). `*.localhost` wildcard certs are invalid because `.localhost` is a reserved TLD per RFC 2606 section 2. (#18)
- **terminal left in raw mode**: Reset `stdin.setRawMode(false)` on process exit so the terminal is not left in raw mode after SIGINT. (#51)

### Features

- **proxy loop detection**: Detect forwarding loops (e.g. a Vite dev server proxying back through portless without `changeOrigin: true`) using the `X-Portless-Hops` header. Respond with `508 Loop Detected` and a message explaining the fix. Also detects loops on WebSocket upgrades. (#48, #52)
- **`--force` flag**: Override a route registered by another process with `portless <name> --force <cmd>`.

## 0.4.1

### Bug Fixes

- Fix Vite support and add e2e tests for 11 frameworks. (#32)

## 0.4.0

### Features

- HTTP/2 + HTTPS support with auto-generated local CA and per-hostname TLS certificates. (#10)

## 0.3.0

### Bug Fixes

- Fix proxy routing issues. (#4)

## 0.2.2

### Improvements

- Block `npx` / `pnpm dlx` usage and improve agent skill. (#1, #2)

## 0.2.1

### Bug Fixes

- Fix proxy routing issue.

## 0.2.0

### Features

- Add `--port` / `-p` flag to the proxy command.

## 0.1.0

Initial release.
