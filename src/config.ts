import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from './logger';

export interface MainframeEntry {
    id: string;
    name: string;
    hostname: string;
    port: number | string;
    secure: boolean;
    user?: string;
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

function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
    const result = { ...base };
    for (const [key, val] of Object.entries(override)) {
        if (val && typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object') {
            result[key] = deepMerge(result[key], val);
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

export function loadConfig(configPath: string): MainframeEntry[] {
    const raw = readJson(configPath);

    if (typeof raw.$schema === 'string' && raw.$schema.toLowerCase().includes('zowe')) {
        logger.info(`Detected Zowe config format: ${configPath}`);
        return parseZoweConfig(loadZoweConfig(configPath));
    }

    return raw as MainframeEntry[];
}

const CANDIDATE_PATHS = [
    path.join(os.homedir(), '.web3270', 'mainframes.json'),
    path.join(os.homedir(), '.zowe', 'zowe.config.json'),
    path.join(os.homedir(), '.zowe', 'zowe.config.user.json'),
];

export function resolveConfigPath(): string | null {
    if (process.env.MAINFRAMES_CONFIG) return process.env.MAINFRAMES_CONFIG;
    return CANDIDATE_PATHS.find(p => fs.existsSync(p)) ?? null;
}
