import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import mainframes from '../mainframes.json';

interface MainframeEntry {
    id: string;
    name: string;
    hostname: string;
    port: number | string;
    secure: boolean;
    user?: string;
}

interface ResolvedEntry extends Omit<MainframeEntry, 'port'> {
    hostname: string;
    port: number;
    user?: string;
}

interface ConnectPayload {
    id: string;
    cols: number;
    rows: number;
}

interface ResizePayload {
    cols: number;
    rows: number;
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
    };
}

const registry = new Map<string, MainframeEntry>(
    (mainframes as MainframeEntry[]).map(m => [m.id, m])
);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

io.on('connection', (socket: Socket) => {
    console.log('[+] New browser session:', socket.id);

    let shell: IPty | null = null;

    socket.on('connect_to_mainframe', (payload: ConnectPayload | null) => {
        if (shell) {
            shell.kill();
            shell = null;
        }

        if (!payload) return;

        const raw = registry.get(payload.id);
        if (!raw) {
            socket.emit('error', `Unknown mainframe id: ${payload.id}`);
            return;
        }

        // Resolve env vars at connect time so changes don't require a restart
        const entry = resolveEntry(raw);
        const { hostname, port, secure, user } = entry;
        const cols = payload.cols || 80;
        const rows = payload.rows || 43;

        // c3270 accepts user@host:port format
        const target = user ? `${user}@${hostname}:${port}` : `${hostname}:${port}`;

        const termArgs: string[] = [
            ...(secure ? ['-secure', '-noverifycert'] : []),
            '-model', '4',
            target,
        ];

        console.log(`[+] [${socket.id}] Connecting to "${entry.name}" (${target})`);

        try {
            shell = pty.spawn('c3270', termArgs, {
                name: 'xterm-color',
                cols,
                rows,
                cwd: process.env.HOME ?? process.cwd(),
                env: process.env as Record<string, string>
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[-] Failed to spawn c3270:', message);
            socket.emit('error', 'Failed to start c3270. Is it installed?');
            return;
        }

        socket.emit('connected', entry.name);
        shell.onData((data: string) => socket.emit('output', data));

        shell.onExit(({ exitCode }: { exitCode: number }) => {
            console.log(`[-] c3270 exited (code ${exitCode})`);
            socket.emit('disconnected', exitCode);
            shell = null;
        });
    });

    socket.on('input', (data: string) => {
        if (shell) shell.write(data);
    });

    socket.on('resize', ({ cols, rows }: ResizePayload) => {
        if (shell) shell.resize(cols, rows);
    });

    socket.on('disconnect', () => {
        console.log('[-] Browser session closed:', socket.id);
        if (shell) {
            shell.kill();
            shell = null;
        }
    });
});

const PORT = parseInt(process.env.PORT ?? '8080', 10);
server.listen(PORT, () => {
    console.log(`[+] Web3270 listening on http://localhost:${PORT}`);
});
