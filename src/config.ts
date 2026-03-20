import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from './logger';

export interface MainframeEntry {
    /** Unique identifier used by the client to request a connection. Never exposed beyond id+name. */
    id: string;
    /** Human-readable label shown in the server picker. */
    name: string;
    /** Mainframe hostname or IP. Supports $VAR / ${VAR} env-var substitution. */
    hostname: string;
    /** TN3270 port. Accepts a number or an env-var string such as "$MF_PORT". */
    port: number | string;
    /** Whether to use TLS (-secure flag). */
    secure: boolean;
    /** When secure=true, controls whether c3270 verifies the server certificate. Defaults to true. */
    rejectUnauthorized?: boolean;

    // TODO implement autologin
    /**
     * Optional TSO/VTAM login username typed on the mainframe login screen after connection.
     * Supports $VAR / ${VAR} env-var substitution. Never passed as a command-line argument.
     */
    user?: string;
    /** Optional password. Supports $VAR / ${VAR} env-var substitution. Never logged or sent as argv. */
    password?: string;
}

interface ZoweProfile {
    type?: string;
    properties?: {
        host?: string;
        port?: number;
        user?: string;
        rejectUnauthorized?: boolean;
    };
    profiles?: Record<string, ZoweProfile>;
    secure?: string[];
}

interface ZoweConfig {
    $schema?: string;
    profiles?: Record<string, ZoweProfile>;
}

function parseZoweConfig(config: ZoweConfig): MainframeEntry[] {
    const entries: MainframeEntry[] = [];

    function walk(id: string, profile: ZoweProfile, inheritedHost?: string, inheritedUser?: string) {
        const props = profile.properties ?? {};
        const host = props.host ?? inheritedHost;
        const user = props.user ?? inheritedUser;

        if (host) {
            entries.push({
                id,
                name: id,
                hostname: host,
                port: props.port ?? 23,
                secure: props.rejectUnauthorized === false ? false : !!props.rejectUnauthorized,
                rejectUnauthorized: props.rejectUnauthorized ?? true,
                user,
            });
        }

        for (const [childKey, child] of Object.entries(profile.profiles ?? {})) {
            walk(`${id}.${childKey}`, child, host, user);
        }
    }

    for (const [key, profile] of Object.entries(config.profiles ?? {})) {
        walk(key, profile);
    }

    return entries;
}

/** Deep-merge two plain objects. Depth is capped at 10 to prevent stack overflow from crafted configs. */
function deepMerge(base: Record<string, any>, override: Record<string, any>, depth = 0): Record<string, any> {
    if (depth > 10) return { ...base, ...override };
    const result = { ...base };
    for (const [key, val] of Object.entries(override)) {
        if (val && typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object') {
            result[key] = deepMerge(result[key], val, depth + 1);
        } else {
            result[key] = val;
        }
    }
    return result;
}

function readJson(filePath: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadZoweConfig(configPath: string): ZoweConfig {
    const isUserFile = configPath.endsWith('.user.json');
    const basePath = isUserFile ? configPath.replace('.user.json', '.json') : configPath;
    const userPath = isUserFile ? configPath : configPath.replace(/\.json$/, '.user.json');

    const baseExists = fs.existsSync(basePath);
    const userExists = fs.existsSync(userPath);

    if (baseExists && userExists) {
        logger.info(`Merging Zowe user config: ${userPath}`);
        return deepMerge(readJson(basePath), readJson(userPath)) as ZoweConfig;
    }

    return readJson(baseExists ? basePath : userPath) as ZoweConfig;
}

function validateEntry(entry: unknown, index: number): MainframeEntry {
    if (typeof entry !== 'object' || entry === null) {
        throw new Error(`Config entry ${index} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) {
        throw new Error(`Config entry ${index}: 'id' must be a non-empty string`);
    }
    if (typeof e.name !== 'string' || !e.name) {
        throw new Error(`Config entry ${index}: 'name' must be a non-empty string`);
    }
    if (typeof e.hostname !== 'string' || !e.hostname) {
        throw new Error(`Config entry ${index}: 'hostname' must be a non-empty string`);
    }
    if (typeof e.port !== 'number' && typeof e.port !== 'string') {
        throw new Error(`Config entry ${index}: 'port' must be a number or env-var string`);
    }
    if (typeof e.secure !== 'boolean') {
        throw new Error(`Config entry ${index}: 'secure' must be a boolean`);
    }
    return entry as MainframeEntry;
}

export function loadConfig(configPath: string): MainframeEntry[] {
    const raw = readJson(configPath);

    if (typeof raw.$schema === 'string' && raw.$schema.toLowerCase().includes('zowe')) {
        logger.info(`Detected Zowe config format: ${configPath}`);
        return parseZoweConfig(loadZoweConfig(configPath));
    }

    if (!Array.isArray(raw)) {
        throw new Error(`Config file must be a JSON array or a Zowe config object: ${configPath}`);
    }

    return raw.map((e, i) => validateEntry(e, i));
}

const CANDIDATE_PATHS = [
    path.join(os.homedir(), '.web3270', 'mainframes.json'),
    path.join(os.homedir(), '.zowe', 'zowe.config.json'),
    path.join(os.homedir(), '.zowe', 'zowe.config.user.json'),
];

export function resolveConfigPath(): string | null {
    if (process.env.MAINFRAMES_CONFIG) {
        const resolved = path.resolve(process.env.MAINFRAMES_CONFIG);
        if (!resolved.endsWith('.json')) {
            throw new Error(`MAINFRAMES_CONFIG must point to a .json file, got: "${resolved}"`);
        }
        return resolved;
    }
    return CANDIDATE_PATHS.find(p => fs.existsSync(p)) ?? null;
}
