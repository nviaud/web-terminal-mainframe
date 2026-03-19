import fs from 'fs';
import os from 'os';
import path from 'path';

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

export function loadConfig(configPath: string): MainframeEntry[] {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (typeof raw.$schema === 'string' && raw.$schema.toLowerCase().includes('zowe')) {
        console.log(`[+] Detected Zowe config format: ${configPath}`);
        return parseZoweConfig(raw as ZoweConfig);
    }

    return raw as MainframeEntry[];
}

const CANDIDATE_PATHS = [
    path.join(os.homedir(), '.web3270', 'mainframes.json'),
    path.join(os.homedir(), '.zowe', 'zowe.config.json'),
];

export function resolveConfigPath(): string | null {
    if (process.env.MAINFRAMES_CONFIG) return process.env.MAINFRAMES_CONFIG;
    return CANDIDATE_PATHS.find(p => fs.existsSync(p)) ?? null;
}
