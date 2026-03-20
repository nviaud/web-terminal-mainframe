import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import express from 'express';
import helmet from 'helmet';
import { Server, Socket } from 'socket.io';
import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { loadConfig, resolveConfigPath, MainframeEntry } from './config';
import logger from './logger';

interface ResolvedEntry extends Omit<MainframeEntry, 'port'> {
    port: number;
}

interface ConnectPayload {
    id: string;
    cols: number;
    rows: number;
    /** Session ID from a previous connection — used to reattach after a page refresh. */
    sessionId?: string;
}

/** How long to keep a detached c3270 session alive waiting for the browser to reconnect. */
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum bytes kept in the output buffer for session replay on reconnect. */
const OUTPUT_BUFFER_MAX = 50 * 1024; // 50 KB

interface PersistentSession {
    pty: IPty;
    entryId: string;
    entryName: string;
    /** Rolling buffer of recent terminal output, replayed on reattach. */
    outputBuffer: string;
    /** Timer that kills the session if no browser reconnects within SESSION_TTL_MS. */
    reattachTimer: NodeJS.Timeout | null;
    /** The currently attached socket, or null when the browser is disconnected. */
    attachedSocket: Socket | null;
    /** Local TCP port of c3270's -scriptport, or null if scripting is not enabled. */
    scriptPort: number | null;
}

/** Allowed characters in a hostname (covers DNS names, IPv4, and IPv6 bracket notation). */
const HOSTNAME_RE = /^[a-zA-Z0-9.\-:[\]]+$/;

/** Clamp n to [min, max]. */
function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

/**
 * Resolve the absolute path of the c3270 binary.
 *
 * Probe well-known absolute paths first so the result is independent of PATH.
 * Set C3270_PATH=/absolute/path/to/c3270 to override.
 */
function resolveC3270Binary(): string {
    const envPath = process.env.C3270_PATH;
    if (envPath) {
        const resolved = path.resolve(envPath);
        if (!fs.existsSync(resolved)) {
            logger.error(`C3270_PATH "${resolved}" does not exist`);
            process.exit(1);
        }
        return resolved;
    }

    const candidates = [
        '/usr/bin/c3270',
        '/usr/local/bin/c3270',
        '/opt/local/bin/c3270',
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    // Last-resort: resolve via the system PATH (logs a warning)
    try {
        const found = execFileSync('which', ['c3270'], { encoding: 'utf8' }).trim();
        logger.warn(
            `c3270 resolved via PATH to "${found}". ` +
            'Set C3270_PATH=/absolute/path/to/c3270 for a hardened deployment.'
        );
        return found;
    } catch {
        logger.error('c3270 not found. Install it or set C3270_PATH=/path/to/c3270');
        process.exit(1);
    }
}

/** Interpret common C escape sequences in a string (used for legacy logoffSequence values). */
function resolveEscapes(s: string): string {
    return s
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ---------------------------------------------------------------------------
// c3270 scriptport helpers
// ---------------------------------------------------------------------------

/** Find a free TCP port by briefly binding to port 0. */
function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address() as net.AddressInfo;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

/** Connect to c3270's scriptport, retrying until maxMs elapses (c3270 needs a moment to open it). */
async function connectWithRetry(port: number, maxMs = 5000): Promise<net.Socket> {
    const deadline = Date.now() + maxMs;
    let lastErr: Error | undefined;
    while (Date.now() < deadline) {
        try {
            return await new Promise<net.Socket>((resolve, reject) => {
                const s = net.createConnection({ port, host: '127.0.0.1' });
                s.once('connect', () => resolve(s));
                s.once('error', reject);
            });
        } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
            await new Promise(r => setTimeout(r, 200));
        }
    }
    throw lastErr ?? new Error(`Cannot connect to c3270 scriptport :${port}`);
}

/**
 * Send a list of c3270 script actions to a running scriptport.
 * Each action is sent only after the previous one responds with "ok".
 * Commands like Wait(Disconnect) may block for seconds — set timeoutMs accordingly.
 */
async function runScriptCommands(port: number, commands: string[], timeoutMs = 30_000): Promise<void> {
    const sock = await connectWithRetry(port);
    return new Promise<void>((resolve, reject) => {
        let buf = '';
        let idx = 0;

        const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error(`Script timed out after ${timeoutMs}ms on "${commands[idx]}"`));
        }, timeoutMs);

        const done = (err?: Error) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(); };
        const sendNext = () => {
            if (idx >= commands.length) { done(); return; }
            // TRACE includes the action text — may contain resolved credentials. Enable only in dev.
            logger.trace({ port, action: commands[idx] }, 'Script action content');
            sock.write(commands[idx] + '\n');
        };

        sock.on('data', chunk => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                const t = line.trim();
                if (t === 'ok') {
                    idx++; sendNext(); return;
                }
                if (t.startsWith('error:')) { done(new Error(`action "${commands[idx]}": ${t}`)); return; }
            }
        });
        sock.on('error', err => done(err));
        sendNext();
    });
}

/**
 * Substitute $USER and $PASSWORD placeholders in script actions with the
 * resolved entry credentials, then apply general env-var substitution.
 */
function resolveScriptActions(actions: string[], entry: ResolvedEntry): string[] {
    return actions.map(a => {
        let s = a;
        if (entry.user)     s = s.replace(/\$(?:\{USER\}|USER\b)/g, entry.user);
        if (entry.password) s = s.replace(/\$(?:\{PASSWORD\}|PASSWORD\b)/g, entry.password);
        return resolveEnv(s);
    });
}

/** Replace $VAR, ${VAR}, or ${VAR:-default} with the matching environment variable. */
function resolveEnv(value: string): string {
    return value.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced, bare) => {
        if (braced) {
            const sep = braced.indexOf(':-');
            if (sep !== -1) {
                const name = braced.slice(0, sep);
                const def  = braced.slice(sep + 2);
                return process.env[name] ?? def;
            }
            return process.env[braced] ?? '';
        }
        return process.env[bare] ?? '';
    });
}

function resolveEntry(entry: MainframeEntry): ResolvedEntry {
    const rawPort = typeof entry.port === 'string' ? resolveEnv(entry.port) : String(entry.port);
    return {
        ...entry,
        hostname: resolveEnv(entry.hostname),
        port: parseInt(rawPort, 10),
        user: entry.user ? resolveEnv(entry.user) : undefined,
        password: entry.password ? resolveEnv(entry.password) : undefined,
    };
}

/**
 * Build a minimal environment for the c3270 child process.
 * Never pass the full process.env — it may contain secrets.
 */
function buildChildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]!;
    }
    return env;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const C3270_BIN = resolveC3270Binary();
logger.info(`Using c3270 binary: ${C3270_BIN}`);

const configPath = resolveConfigPath();

if (!configPath) {
    logger.error('No configuration file found. Looked in:');
    logger.error('  ~/.web3270/mainframes.json');
    logger.error('  ~/.zowe/zowe.config.json');
    logger.error('Create one or set MAINFRAMES_CONFIG=/path/to/file');
    process.exit(1);
}

const registry = new Map<string, MainframeEntry>(
    loadConfig(configPath).map(m => [m.id, m])
);

// ---------------------------------------------------------------------------
// Express + security headers
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'"],
            styleSrc:    ["'self'", "'unsafe-inline'"],
            connectSrc:  ["'self'", 'ws:', 'wss:'],
            fontSrc:     ["'self'"],
            imgSrc:      ["'self'", 'data:'],
        },
    },
}));

// ---------------------------------------------------------------------------
// Socket.IO — CORS + optional token authentication
// ---------------------------------------------------------------------------

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : false;

const io = new Server(server, {
    cors: allowedOrigins ? { origin: allowedOrigins, credentials: false } : undefined,
});

const requiredToken = process.env.WEB3270_TOKEN ?? null;
if (requiredToken) {
    logger.info('Socket.IO token authentication enabled');
    io.use((socket, next) => {
        const token = (socket.handshake.auth as Record<string, unknown>)?.token;
        if (token !== requiredToken) {
            logger.warn({ socketId: socket.id }, 'Auth rejected: invalid or missing token');
            return next(new Error('Unauthorized'));
        }
        next();
    });
}

// ---------------------------------------------------------------------------
// Static files + API
// ---------------------------------------------------------------------------

// Use __dirname-based absolute paths so the server works regardless of cwd.
// dist/server.js lives in <root>/dist/, so root is one level up.
const ROOT = path.join(__dirname, '..');
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', '@xterm')));

const defaultServer = process.env.DEFAULT_SERVER ?? null;

// Expose only id + name to the client — credentials and host stay server-side
app.get('/api/init', (_req, res) => {
    res.json({
        servers: [...registry.values()].map(({ id, name }) => ({ id, name })),
        defaultServer,
    });
});

// ---------------------------------------------------------------------------
// Process tracking — used to clean up on server shutdown
// ---------------------------------------------------------------------------

const activeSessions = new Set<IPty>();

/** All sessions that are kept alive waiting for the browser to reconnect. */
const persistentSessions = new Map<string, PersistentSession>();

function killShell(s: IPty): void {
    activeSessions.delete(s);
    try { s.kill(); } catch { /* already exited */ }
}

let shuttingDown = false;

function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`${signal} received — killing active c3270 sessions`);
    for (const session of persistentSessions.values()) {
        if (session.reattachTimer) clearTimeout(session.reattachTimer);
    }
    persistentSessions.clear();
    for (const s of activeSessions) killShell(s);

    // Close Socket.IO connections first so the HTTP server can drain.
    io.close();
    server.close(() => process.exit(0));

    // Force exit after 3 s if graceful shutdown stalls (e.g. hung socket).
    setTimeout(() => {
        logger.warn('Graceful shutdown timed out — forcing exit');
        process.exit(1);
    }, 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Socket.IO connection handling
// ---------------------------------------------------------------------------

io.on('connection', (socket: Socket) => {
    logger.info({ socketId: socket.id }, 'New browser session');

    let shell: IPty | null = null;
    let currentSessionId: string | null = null;
    let currentEntryId: string | null = null;

    // Per-socket resize rate limiter: max 10 events per second
    let resizeCount = 0;
    let resizeWindowStart = Date.now();

    socket.on('connect_to_mainframe', async (payload: ConnectPayload | null) => {
        // ── Explicit disconnect ──────────────────────────────────────────────
        if (!payload) {
            if (shell && currentSessionId) {
                const session = persistentSessions.get(currentSessionId);
                const raw = currentEntryId ? registry.get(currentEntryId) : undefined;

                if (session?.scriptPort && raw?.autologoff?.length) {
                    // ── Preferred: send logoff via c3270 scriptport ──────────
                    const actions = resolveScriptActions(raw.autologoff, resolveEntry(raw));
                    await runScriptCommands(session.scriptPort, actions, 10_000)
                        .catch(err => logger.warn({ sessionId: currentSessionId }, `Autologoff failed: ${err.message}`));

                } else if (raw?.logoffSequence) {
                    // ── Fallback: raw pty write (deprecated, best-effort) ────
                    const shellToLogoff = shell;
                    shellToLogoff.write(resolveEscapes(resolveEnv(raw.logoffSequence)));
                    await new Promise<void>(resolve => {
                        const timeout = setTimeout(resolve, 3000);
                        const disposable = shellToLogoff.onExit(() => {
                            clearTimeout(timeout); disposable.dispose(); resolve();
                        });
                    });
                }
            }
            if (shell) { killShell(shell); shell = null; }
            if (currentSessionId) {
                persistentSessions.delete(currentSessionId);
                currentSessionId = null;
            }
            currentEntryId = null;
            return;
        }

        // ── Kill any shell already attached to this socket ───────────────────
        if (shell) {
            killShell(shell);
            shell = null;
            if (currentSessionId) {
                persistentSessions.delete(currentSessionId);
                currentSessionId = null;
            }
            currentEntryId = null;
        }

        const cols = clamp(Math.floor(payload.cols) || 80, 20, 500);
        const rows = clamp(Math.floor(payload.rows) || 43,  5, 200);

        // ── Try to reattach to an existing persistent session ────────────────
        if (payload.sessionId) {
            const session = persistentSessions.get(payload.sessionId);
            if (session) {
                if (session.reattachTimer) { clearTimeout(session.reattachTimer); session.reattachTimer = null; }
                session.attachedSocket = socket;
                shell = session.pty;
                currentSessionId = payload.sessionId;
                currentEntryId = session.entryId;
                try { shell.resize(cols, rows); } catch { /* already exited */ }
                logger.info({ socketId: socket.id, sessionId: payload.sessionId }, 'Reattached to existing session');
                socket.emit('reconnected', { name: session.entryName, buffer: session.outputBuffer });
                return;
            }
            logger.info({ socketId: socket.id, sessionId: payload.sessionId }, 'Session not found — starting new connection');
        }

        // ── Spawn a new c3270 process ────────────────────────────────────────
        const raw = registry.get(payload.id);
        if (!raw) {
            socket.emit('error', `Unknown mainframe id: ${payload.id}`);
            return;
        }

        const entry = resolveEntry(raw);
        const { hostname, port, secure, rejectUnauthorized = true } = entry;

        // Validate resolved values before building c3270 arguments.
        // These are server-side config errors the browser user cannot fix,
        // so disconnect the socket immediately after reporting them.
        const rejectConfig = (reason: string) => {
            logger.error({ socketId: socket.id }, reason);
            socket.emit('error', 'Server configuration error');
            socket.disconnect(true);
        };

        if (!HOSTNAME_RE.test(hostname)) {
            rejectConfig('Rejected connect: invalid hostname in config');
            return;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            rejectConfig(`Rejected connect: invalid port in config (${port})`);
            return;
        }

        const target = `${hostname}:${port}`;
        const needsScriptPort = !!(entry.autologin?.length || entry.autologoff?.length);
        const scriptPort = needsScriptPort ? await getFreePort() : null;

        const termArgs = [
            ...(secure ? ['-secure', ...(rejectUnauthorized ? [] : ['-noverifycert'])] : []),
            '-model', '4',
            ...(scriptPort !== null ? ['-scriptport', String(scriptPort)] : []),
            target,
        ];

        logger.info({ socketId: socket.id, name: entry.name }, `Connecting to "${entry.name}"`);

        let spawnedShell: IPty;
        try {
            spawnedShell = pty.spawn(C3270_BIN, termArgs, {
                name: 'xterm-color',
                cols,
                rows,
                cwd: process.env.HOME ?? process.cwd(),
                env: buildChildEnv(),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ socketId: socket.id }, `Failed to spawn c3270: ${message}`);
            socket.emit('error', 'Failed to start c3270. Is it installed?');
            return;
        }

        const sessionId = randomUUID();
        const session: PersistentSession = {
            pty: spawnedShell,
            entryId: raw.id,
            entryName: entry.name,
            outputBuffer: '',
            reattachTimer: null,
            attachedSocket: socket,
            scriptPort,
        };

        shell = spawnedShell;
        currentSessionId = sessionId;
        currentEntryId = raw.id;
        activeSessions.add(spawnedShell);
        persistentSessions.set(sessionId, session);

        socket.emit('connected', { name: entry.name, sessionId });

        spawnedShell.onData((data: string) => {
            session.outputBuffer += data;
            if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
                session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_MAX);
            }
            if (session.attachedSocket) session.attachedSocket.emit('output', data);
        });

        spawnedShell.onExit(({ exitCode }: { exitCode: number }) => {
            activeSessions.delete(spawnedShell);
            persistentSessions.delete(sessionId);
            if (session.reattachTimer) clearTimeout(session.reattachTimer);
            logger.info({ sessionId, exitCode }, 'c3270 exited');
            if (shell === spawnedShell) shell = null;
            if (session.attachedSocket) session.attachedSocket.emit('disconnected', exitCode);
        });

        // Run autologin in the background — failure is non-fatal, user can log in manually.
        if (scriptPort !== null && entry.autologin?.length) {
            const actions = resolveScriptActions(entry.autologin, entry);
            runScriptCommands(scriptPort, actions, 30_000)
                .then(() => logger.info({ sessionId }, 'Autologin completed'))
                .catch(err => logger.warn({ sessionId }, `Autologin failed: ${err.message}`));
        }
    });

    socket.on('input', (data: string) => {
        if (shell) shell.write(data);
    });

    socket.on('resize', ({ cols, rows }: { cols: number; rows: number }) => {
        const now = Date.now();
        if (now - resizeWindowStart > 1000) { resizeCount = 0; resizeWindowStart = now; }
        if (resizeCount >= 10) return;
        resizeCount++;

        if (shell) shell.resize(
            clamp(Math.floor(cols) || 80, 20, 500),
            clamp(Math.floor(rows) || 43,  5, 200),
        );
    });

    socket.on('disconnect', () => {
        logger.info({ socketId: socket.id }, 'Browser session closed');
        if (currentSessionId) {
            const session = persistentSessions.get(currentSessionId);
            if (session && session.attachedSocket === socket) {
                // Detach socket but keep the c3270 process alive for reattachment.
                session.attachedSocket = null;
                const detachedSessionId = currentSessionId;
                session.reattachTimer = setTimeout(() => {
                    logger.info({ sessionId: detachedSessionId }, 'Session reattach timeout — killing c3270');
                    persistentSessions.delete(detachedSessionId);
                    killShell(session.pty);
                }, SESSION_TTL_MS);
                logger.info({ socketId: socket.id, sessionId: currentSessionId }, `Session detached — kept alive for ${SESSION_TTL_MS / 1000}s`);
            }
        } else if (shell) {
            killShell(shell);
        }
        shell = null;
        currentSessionId = null;
        currentEntryId = null;
    });
});

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '8080', 10);
server.listen(PORT, () => {
    logger.info(`Web3270 listening on http://localhost:${PORT}`);
});
