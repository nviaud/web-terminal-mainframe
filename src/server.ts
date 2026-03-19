import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
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
}

/** Allowed characters in a hostname (covers DNS names, IPv4, and IPv6 bracket notation). */
const HOSTNAME_RE = /^[a-zA-Z0-9.\-:[\]]+$/;

/** Allowed characters in a username. */
const USER_RE = /^[a-zA-Z0-9._@\-]+$/;

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

/**
 * Convert a string into a sequence of c3270 Key(U+XXXX) scripting actions.
 *
 * Using Key() per character instead of String() avoids c3270's argument
 * parser misinterpreting characters like ')' that would terminate the
 * String() action early.
 */
function toKeyActions(text: string): string {
    return text
        .split('')
        .map(ch => `Key(U+${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()})`)
        .join('\r') + '\r';
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

app.use(express.static('public'));
app.use('/vendor', express.static('node_modules/@xterm'));

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

function killShell(s: IPty): void {
    activeSessions.delete(s);
    try { s.kill(); } catch { /* already exited */ }
}

process.on('SIGTERM', () => {
    logger.info('SIGTERM received — killing active c3270 sessions');
    for (const s of activeSessions) killShell(s);
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    logger.info('SIGINT received — killing active c3270 sessions');
    for (const s of activeSessions) killShell(s);
    server.close(() => process.exit(0));
});

// ---------------------------------------------------------------------------
// Socket.IO connection handling
// ---------------------------------------------------------------------------

io.on('connection', (socket: Socket) => {
    logger.info({ socketId: socket.id }, 'New browser session');

    let shell: IPty | null = null;

    // Per-socket resize rate limiter: max 10 events per second
    let resizeCount = 0;
    let resizeWindowStart = Date.now();

    socket.on('connect_to_mainframe', (payload: ConnectPayload | null) => {
        if (shell) {
            killShell(shell);
            shell = null;
        }

        if (!payload) return;

        const raw = registry.get(payload.id);
        if (!raw) {
            socket.emit('error', `Unknown mainframe id: ${payload.id}`);
            return;
        }

        const entry = resolveEntry(raw);
        const { hostname, port, secure, user, password, rejectUnauthorized = true } = entry;

        // Validate resolved values before building c3270 arguments
        if (!HOSTNAME_RE.test(hostname)) {
            logger.error({ socketId: socket.id }, 'Rejected connect: invalid hostname in config');
            socket.emit('error', 'Server configuration error');
            return;
        }
        if (user && !USER_RE.test(user)) {
            logger.error({ socketId: socket.id }, 'Rejected connect: invalid user in config');
            socket.emit('error', 'Server configuration error');
            return;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            logger.error({ socketId: socket.id, port }, 'Rejected connect: invalid port in config');
            socket.emit('error', 'Server configuration error');
            return;
        }

        // Clamp terminal dimensions to sane bounds
        const cols = clamp(Math.floor(payload.cols) || 80, 20, 500);
        const rows = clamp(Math.floor(payload.rows) || 43,  5, 200);

        // Build args WITHOUT the target so that user@host never appears in `ps aux`.
        // The Connect() action is written to the pty after spawn instead.
        const termArgs = [
            ...(secure ? ['-secure', ...(rejectUnauthorized ? [] : ['-noverifycert'])] : []),
            '-model', '4',
            '-script',
        ];

        // Connect string is sent over the pty — stays in memory, never in argv.
        const connectTarget = user ? `${user}@${hostname}:${port}` : `${hostname}:${port}`;

        logger.info({ socketId: socket.id, name: entry.name }, `Connecting to "${entry.name}"`);

        try {
            shell = pty.spawn(C3270_BIN, termArgs, {
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

        const spawnedShell = shell;
        activeSessions.add(spawnedShell);

        // Send the connect action via stdin — keeps credentials out of argv / ps.
        // If a password is configured, wait for the first input field (the login screen)
        // and type it automatically. The password is never written to argv or logs.
        spawnedShell.write(`Connect(${connectTarget})\r`);
        if (password) {
            spawnedShell.write(`Wait(InputField)\r`);
            spawnedShell.write(toKeyActions(password));
            spawnedShell.write(`Enter()\r`);
        }

        socket.emit('connected', entry.name);
        spawnedShell.onData((data: string) => socket.emit('output', data));
        spawnedShell.onExit(({ exitCode }: { exitCode: number }) => {
            activeSessions.delete(spawnedShell);
            logger.info({ socketId: socket.id, exitCode }, 'c3270 exited');
            // Only clear the outer reference if it still points to THIS process.
            // A second connect_to_mainframe may have already replaced it.
            if (shell === spawnedShell) shell = null;
            socket.emit('disconnected', exitCode);
        });
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
        if (shell) { killShell(shell); shell = null; }
    });
});

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '8080', 10);
server.listen(PORT, () => {
    logger.info(`Web3270 listening on http://localhost:${PORT}`);
});
