# Plano de Implementação: Suporte a Windows + Migração para Bun

## Visão Geral

Este plano implementa suporte completo ao Windows no peakroute usando como referência os PRs #6 e #50 do repositório original, seguido de uma migração gradual para o runtime Bun.

## Fase 0: Documentação e Descoberta (DONE)

**Status**: ✅ Concluído nas sessões anteriores

### Fontes Consultadas

- PR #6 (vercel-labs/peakroute): Process management para Windows
- PR #50 (vercel-labs/peakroute): Certificados e permissões para Windows
- Context7: Documentação das APIs nativas do Bun

### APIs Permitidas Identificadas

**Node.js APIs (cross-platform)**:

- `process.platform` - Detecção de plataforma
- `os.tmpdir()` - Diretório temporário
- `os.homedir()` - Diretório home do usuário
- `fs.*` - Operações de arquivo (com tratamento para Windows)
- `child_process.spawn/execFile` - Comandos do sistema

**Comandos do Sistema Necessários**:

- Windows: `netstat -ano -p tcp`, `certutil`, `taskkill`
- macOS: `lsof`, `security`
- Linux: `lsof`, `update-ca-certificates`

**Bun APIs (para Fase 2)**:

- `Bun.spawn()` - Substitui `child_process.spawn`
- `Bun.listen()`/`Bun.connect()` - TCP sockets
- `Bun.file()` - Leitura de arquivos otimizada

---

## Fase 1: Implementação do Suporte a Windows

**Status**: ✅ **CONCLUÍDO** (todos os itens implementados)

### 1.1 Constantes de Plataforma ✅

**Arquivo**: `packages/peakroute/src/platform.ts` (NOVO - CRIADO)

**Implementação**:

```typescript
export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/** Diretório de estado do sistema (temporário) */
export const SYSTEM_STATE_DIR = IS_WINDOWS ? path.join(os.tmpdir(), "peakroute") : "/tmp/peakroute";

/** Diretório de estado por usuário */
export const USER_STATE_DIR = path.join(os.homedir(), ".peakroute");
```

**Referência**: PR #6, PR #50

---

### 1.2 Wrapper de Permissões (chmodSafe) ✅

**Arquivo**: `packages/peakroute/src/utils.ts` (MODIFICADO)

**Implementação**:

```typescript
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

export async function chmodSafeAsync(path: string, mode: number): Promise<void> {
  if (IS_WINDOWS) return;
  try {
    await fs.promises.chmod(path, mode);
  } catch {
    // Non-fatal
  }
}

/**
 * Fix ownership é no-op no Windows (não tem conceito de uid/gid).
 */
export function fixOwnership(...paths: string[]): void {
  if (IS_WINDOWS) return;
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
```

**Referência**: PR #50

---

### 1.3 Gerenciamento de Processos (findPidOnPort) ✅

**Arquivo**: `packages/peakroute/src/cli-utils.ts` (MODIFICADO)

**Implementação**:

```typescript
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
 * Encontra o PID do processo escutando em uma porta.
 * Windows: usa netstat -ano
 * Unix: usa lsof -ti
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
    const pid = parseInt(output.trim().split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}
```

**Referência**: PR #6

---

### 1.4 Spawn de Comandos (spawnCommand) ✅

**Arquivo**: `packages/peakroute/src/cli-utils.ts` (MODIFICADO)

**Implementação**:

```typescript
/**
 * Spawna um comando com suporte a Windows.
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

  if (IS_WINDOWS) {
    // No Windows, executamos diretamente o comando com shell
    // Isso permite executar .cmd scripts (npm, pnpm, etc)
    const child = spawn(commandArgs[0], commandArgs.slice(1), {
      stdio: "inherit",
      env,
      shell: true,
      windowsHide: true, // Esconde janela do console
    });
    // ... resto do handling igual
  } else {
    // Unix: usa /bin/sh
    const shellCmd = commandArgs.map(shellEscape).join(" ");
    const child = spawn("/bin/sh", ["-c", shellCmd], {
      stdio: "inherit",
      env,
    });
    // ...
  }
}
```

**Referência**: PR #6

---

### 1.5 Trust Store de Certificados (certs.ts) ✅

**Arquivo**: `packages/peakroute/src/certs.ts` (MODIFICADO)

**Implementação**:

```typescript
/**
 * Verifica se o CA está confiado no Windows.
 * PR #50: Usa certutil para verificar o store do usuário.
 */
function isCATrustedWindows(caCertPath: string): boolean {
  try {
    // Extrai fingerprint SHA1 do certificado
    const fingerprint = openssl(["x509", "-in", caCertPath, "-noout", "-fingerprint", "-sha1"])
      .trim()
      .replace(/^.*=/, "")
      .replace(/:/g, "")
      .toLowerCase();

    // Query no store Root do usuário
    const result = execFileSync("certutil", ["-store", "-user", "Root"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return result.toLowerCase().includes(fingerprint);
  } catch {
    return false;
  }
}

/**
 * Adiciona CA ao trust store do Windows.
 * PR #50: Usa certutil -addstore.
 */
function trustCAWindows(caCertPath: string): void {
  execFileSync("certutil", ["-addstore", "-user", "Root", caCertPath], {
    stdio: "pipe",
    timeout: 30_000,
  });
}

// Atualizar isCATrusted() para incluir Windows:
export function isCATrusted(stateDir: string): boolean {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) return false;

  if (process.platform === "darwin") {
    return isCATrustedMacOS(caCertPath);
  } else if (process.platform === "linux") {
    return isCATrustedLinux(stateDir);
  } else if (IS_WINDOWS) {
    return isCATrustedWindows(caCertPath);
  }
  return false;
}

// Atualizar trustCA() para incluir Windows:
export function trustCA(stateDir: string): { trusted: boolean; error?: string } {
  // ... código existente ...
  try {
    if (process.platform === "darwin") {
      // ... macOS
    } else if (process.platform === "linux") {
      // ... Linux
    } else if (IS_WINDOWS) {
      trustCAWindows(caCertPath);
      return { trusted: true };
    }
    return { trusted: false, error: `Unsupported platform: ${process.platform}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // PR #50: Mensagem específica para Windows
    if (
      message.includes("authorization") ||
      message.includes("permission") ||
      message.includes("EACCES") ||
      message.includes("Access is denied") // Windows
    ) {
      return {
        trusted: false,
        error: IS_WINDOWS
          ? "Permission denied. Try running as Administrator."
          : "Permission denied. Try: sudo peakroute trust",
      };
    }
    return { trusted: false, error: message };
  }
}
```

**Referência**: PR #50

---

### 1.6 Daemon Spawn (windowsHide) ✅

**Arquivo**: `packages/peakroute/src/cli.ts` (MODIFICADO)

**Implementação**:

```typescript
const child = spawn(process.execPath, daemonArgs, {
  detached: true,
  stdio: ["ignore", logFd, logFd],
  env: process.env,
  windowsHide: true, // PR #6: Evita popup de console no Windows
});
```

---

### 1.7 Resolução de Diretório de Estado ✅

**Arquivo**: `packages/peakroute/src/cli-utils.ts` (MODIFICADO)

**Implementação**:

```typescript
/**
 * Resolve o diretório de estado.
 * PR #6/PR #50: No Windows, sempre usa USER_STATE_DIR (não tem ports privilegiados).
 */
export function resolveStateDir(port: number): string {
  if (process.env.PORTLESS_STATE_DIR) return process.env.PORTLESS_STATE_DIR;
  // No Windows, não existe conceito de ports privilegiadas
  if (IS_WINDOWS) return USER_STATE_DIR;
  return port < PRIVILEGED_PORT_THRESHOLD ? SYSTEM_STATE_DIR : USER_STATE_DIR;
}
```

---

### 1.8 Detecção de Sudo/Permissões ✅

**Arquivo**: `packages/peakroute/src/cli.ts` (MODIFICADO)

**Implementação**:

```typescript
// PR #6: No Windows, ports < 1024 não precisam de elevação especial
const needsSudo = !IS_WINDOWS && proxyPort < PRIVILEGED_PORT_THRESHOLD;

// Mensagens de erro específicas por plataforma
if (err.code === "EACCES") {
  if (IS_WINDOWS) {
    console.error(chalk.red(`Permission denied for port ${proxyPort}.`));
    console.error(chalk.blue("Try running as Administrator."));
  } else {
    console.error(chalk.red(`Permission denied for port ${proxyPort}.`));
    console.error(chalk.blue("Either run with sudo:"));
    console.error(chalk.cyan("  sudo peakroute proxy start -p 80"));
  }
}
```

---

### 1.9 Atualizar package.json ✅

**Arquivo**: `packages/peakroute/package.json` (MODIFICADO)

**Mudanças**:

```json
{
  "os": ["darwin", "linux", "win32"]
}
```

---

### 1.10 Atualizar Mensagens de Ajuda ✅

**Arquivo**: `packages/peakroute/src/cli.ts` (MODIFICADO)

**Mudanças**:

- Substituir comandos Unix (`lsof`, `kill`) por equivalentes Windows quando aplicável
- Adicionar `taskkill /F /PID <pid>` como alternativa no Windows
- Adicionar `netstat -ano | findstr` como alternativa ao `lsof`

---

## Fase 2: Migração para Bun (Pós-Windows)

### 2.1 Pré-requisitos

**Verificação**:

- Bun instalado (`bun --version`)
- Testes passando após Fase 1

### 2.2 Substituir Spawn por Bun.spawn

**Arquivo**: `packages/peakroute/src/cli-utils.ts` (MODIFICAR)

**Implementação**:

```typescript
// De:
import { spawn } from "node:child_process";
const child = spawn(command, args, { detached: true, windowsHide: true });

// Para:
const proc = Bun.spawn([command, ...args], {
  detached: true,
  windowsHide: true,
  stdout: logFd,
  stderr: logFd,
});
// Bun.spawn já retorna promessa exited
await proc.exited;
```

### 2.3 Substituir Leitura de Arquivos

**Arquivo**: `packages/peakroute/src/certs.ts` (MODIFICAR)

**Implementação**:

```typescript
// De:
const cert = fs.readFileSync(certPath);

// Para:
const cert = await Bun.file(certPath).arrayBuffer();
// ou
const cert = await Bun.file(certPath).text();
```

### 2.4 Atualizar Scripts do package.json

**Arquivo**: `packages/peakroute/package.json` (MODIFICAR)

**Mudanças**:

```json
{
  "scripts": {
    "build": "bun build ./src/cli.ts --outdir ./dist",
    "dev": "bun --watch ./src/cli.ts",
    "test": "bun test"
  }
}
```

### 2.5 Configuração do Bun no Workspace

**Arquivo**: `bunfig.toml` (NOVO - root)

**Conteúdo**:

```toml
[install]
exact = true

[test]
coverage = true
```

---

## Lista de Verificação (Checklist)

### Fase 1: Windows ✅ CONCLUÍDA

- [x] Criar `packages/peakroute/src/platform.ts`
- [x] Atualizar `utils.ts` com chmodSafe e fixOwnership
- [x] Atualizar `cli-utils.ts` com findPidOnPort Windows
- [x] Atualizar `cli-utils.ts` com spawnCommand Windows
- [x] Atualizar `certs.ts` com trust store Windows
- [x] Atualizar `cli.ts` com daemon windowsHide
- [x] Atualizar `cli.ts` com resolveStateDir Windows
- [x] Atualizar `cli.ts` mensagens de erro Windows
- [x] Atualizar `package.json` campo "os"
- [ ] Executar testes em Windows (pendente - requer ambiente Windows)

### Fase 2: Bun

- [ ] Instalar Bun
- [ ] Substituir spawn por Bun.spawn
- [ ] Substituir fs.readFileSync por Bun.file
- [ ] Atualizar scripts do package.json
- [ ] Criar bunfig.toml
- [ ] Executar testes com Bun

---

## Referências

1. PR #6: https://github.com/vercel-labs/peakroute/pull/6/files
2. PR #50: https://github.com/vercel-labs/peakroute/pull/50/files
3. Bun Docs: https://bun.sh/docs
4. Node.js process.platform: https://nodejs.org/api/process.html#processplatform
