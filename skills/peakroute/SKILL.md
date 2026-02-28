---
name: peakroute
description: Set up and use peakroute for named local dev server URLs (e.g. http://myapp.localhost instead of http://localhost:3000). Use when integrating peakroute into a project, configuring dev server names, setting up the local proxy, working with .localhost domains, or troubleshooting port/proxy issues.
---

# Portless

Replace port numbers with stable, named .localhost URLs. For humans and agents.

## Why peakroute

- **Port conflicts** -- `EADDRINUSE` when two projects default to the same port
- **Memorizing ports** -- which app is on 3001 vs 8080?
- **Refreshing shows the wrong app** -- stop one server, start another on the same port, stale tab shows wrong content
- **Monorepo multiplier** -- every problem scales with each service in the repo
- **Agents test the wrong port** -- AI agents guess or hardcode the wrong port
- **Cookie/storage clashes** -- cookies on `localhost` bleed across apps; localStorage lost when ports shift
- **Hardcoded ports in config** -- CORS allowlists, OAuth redirects, `.env` files break when ports change
- **Sharing URLs with teammates** -- "what port is that on?" becomes a Slack question
- **Browser history is useless** -- `localhost:3000` history is a mix of unrelated projects

## Installation

peakroute is a global CLI tool. Do NOT add it as a project dependency (no `npm install peakroute` or `pnpm add peakroute` in a project). Do NOT use `npx`.

Install globally:

```bash
npm install -g peakroute
```

## Quick Start

```bash
# Install globally
npm install -g peakroute

# Start the proxy (once, no sudo needed)
peakroute proxy start

# Run your app (auto-starts the proxy if needed)
peakroute myapp next dev
# -> http://myapp.localhost:1355
```

The proxy auto-starts when you run an app. You can also start it explicitly with `peakroute proxy start`.

## Integration Patterns

### package.json scripts

```json
{
  "scripts": {
    "dev": "peakroute myapp next dev"
  }
}
```

The proxy auto-starts when you run an app. Or start it explicitly: `peakroute proxy start`.

### Multi-app setups with subdomains

```bash
peakroute myapp next dev          # http://myapp.localhost:1355
peakroute api.myapp pnpm start    # http://api.myapp.localhost:1355
peakroute docs.myapp next dev     # http://docs.myapp.localhost:1355
```

### Bypassing peakroute

Set `PEAKROUTE=0` or `PEAKROUTE=skip` to run the command directly without the proxy:

```bash
PEAKROUTE=0 pnpm dev   # Bypasses proxy, uses default port
```

## How It Works

1. `peakroute proxy start` starts an HTTP reverse proxy on port 1355 as a background daemon (configurable with `-p` / `--port` or the `PEAKROUTE_PORT` env var). The proxy also auto-starts when you run an app.
2. `peakroute <name> <cmd>` assigns a random free port (4000-4999) via the `PORT` env var and registers the app with the proxy
3. The browser hits `http://<name>.localhost:1355` on the proxy port; the proxy forwards to the app's assigned port

`.localhost` domains resolve to `127.0.0.1` natively on macOS and Linux -- no `/etc/hosts` editing needed.

Most frameworks (Next.js, Express, Nuxt, etc.) respect the `PORT` env var automatically. For frameworks that ignore `PORT` (Vite, Astro, React Router, Angular), peakroute auto-injects the correct `--port` and `--host` CLI flags.

### State directory

Portless stores its state (routes, PID file, port file) in a directory that depends on the proxy port:

- **Port < 1024** (sudo required): `/tmp/peakroute`
- **Port >= 1024** (no sudo): `~/.peakroute`

Override with the `PEAKROUTE_STATE_DIR` environment variable.

### Environment variables

| Variable              | Description                                     |
| --------------------- | ----------------------------------------------- |
| `PEAKROUTE_PORT`      | Override the default proxy port (default: 1355) |
| `PEAKROUTE_HTTPS`     | Set to `1` to always enable HTTPS/HTTP/2        |
| `PEAKROUTE_STATE_DIR` | Override the state directory                    |
| `PEAKROUTE=0\|skip`   | Bypass the proxy, run the command directly      |

### HTTP/2 + HTTPS

Use `--https` for HTTP/2 multiplexing (faster page loads for dev servers with many files):

```bash
peakroute proxy start --https                  # Auto-generate certs and trust CA
peakroute proxy start --cert ./c.pem --key ./k.pem  # Use custom certs
sudo peakroute trust                           # Add CA to trust store later
```

First run generates a local CA and prompts for sudo to add it to the system trust store. After that, no prompts and no browser warnings. Set `PEAKROUTE_HTTPS=1` in `.bashrc`/`.zshrc` to make it permanent.

## CLI Reference

| Command                              | Description                                                   |
| ------------------------------------ | ------------------------------------------------------------- |
| `peakroute <name> <cmd> [args...]`   | Run app at `http://<name>.localhost:1355` (auto-starts proxy) |
| `peakroute list`                     | Show active routes                                            |
| `peakroute trust`                    | Add local CA to system trust store (for HTTPS)                |
| `peakroute proxy start`              | Start the proxy as a daemon (port 1355, no sudo)              |
| `peakroute proxy start --https`      | Start with HTTP/2 + TLS (auto-generates certs)                |
| `peakroute proxy start -p <number>`  | Start the proxy on a custom port                              |
| `peakroute proxy start --foreground` | Start the proxy in foreground (for debugging)                 |
| `peakroute proxy stop`               | Stop the proxy                                                |
| `peakroute <name> --force <cmd>`     | Override an existing route registered by another process      |
| `peakroute --help` / `-h`            | Show help                                                     |
| `peakroute --version` / `-v`         | Show version                                                  |

## Troubleshooting

### Proxy not running

The proxy auto-starts when you run an app with `peakroute <name> <cmd>`. If it doesn't start (e.g. port conflict), start it manually:

```bash
peakroute proxy start
```

### Port already in use

Another process is bound to the proxy port. Either stop it first, or use a different port:

```bash
peakroute proxy start -p 8080
```

### Framework not respecting PORT

Portless auto-injects `--port` and `--host` flags for frameworks that ignore the `PORT` env var: **Vite**, **Astro**, **React Router**, and **Angular**. SvelteKit uses Vite internally and is handled automatically.

For other frameworks that don't read `PORT`, pass the port manually:

- **Webpack Dev Server**: use `--port $PORT`
- **Custom servers**: read `process.env.PORT` and listen on it

### Permission errors

Ports below 1024 require `sudo`. The default port (1355) does not need sudo. If you want to use port 80:

```bash
sudo peakroute proxy start -p 80       # Port 80, requires sudo
peakroute proxy start                   # Port 1355, no sudo needed
peakroute proxy stop                    # Stop (use sudo if started with sudo)
```

### Browser shows certificate warning with --https

The local CA may not be trusted yet. Run:

```bash
sudo peakroute trust
```

This adds the peakroute local CA to your system trust store. After that, restart the browser.

### Proxy loop (508 Loop Detected)

If your dev server proxies requests to another peakroute app (e.g. Vite proxying `/api` to `api.myapp.localhost:1355`), the proxy must rewrite the `Host` header. Without this, peakroute routes the request back to the original app, creating an infinite loop.

Fix: set `changeOrigin: true` in the proxy config (Vite, webpack-dev-server, etc.):

```ts
// vite.config.ts
proxy: {
  "/api": {
    target: "http://api.myapp.localhost:1355",
    changeOrigin: true,
    ws: true,
  },
}
```

### Requirements

- Node.js 20+
- macOS or Linux
- `openssl` (for `--https` cert generation; ships with macOS and most Linux distributions)
