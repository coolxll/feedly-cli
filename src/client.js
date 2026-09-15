import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ApiError, AuthError, ConfigError } from './errors.js';

export const DEFAULT_API_BASE = 'https://cloud.feedly.com/v3';
export const DEFAULT_SEARCH_API_BASE = 'https://api.feedly.com/v3';
export const DEFAULT_CLIENT_IDS = ['feedly', 'feedlydev'];
export const SEARCH_CLIENT_TYPE = 'feedly.desktop';
export const SEARCH_CLIENT_VERSION = '31.0.3087';
export const DEFAULT_TIMEOUT_MS = 30_000;

const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Feedly publication buckets exposed through the `search` scope flag. */
export const SEARCH_SOURCES = {
    business: {
        label: 'Business & Strategy',
        type: 'publicationBucket',
        id: 'byf:business-and-strategy',
        tier: 'tier1',
    },
    tech: {
        label: 'Tech Blogs',
        type: 'publicationBucket',
        id: 'byf:tech',
        tier: 'tier1',
    },
};

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(obj, ...keys) {
    for (const key of keys) {
        const value = obj?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function numberField(obj, ...keys) {
    for (const key of keys) {
        const value = obj?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return 0;
}

export function resolveApiBases(env = process.env) {
    return {
        apiBase: stringField(env, 'FEEDLY_API_BASE') || DEFAULT_API_BASE,
        searchApiBase: stringField(env, 'FEEDLY_SEARCH_API_BASE') || DEFAULT_SEARCH_API_BASE,
    };
}

/* -------------------------------------------------------------------------- */
/* Config discovery                                                           */
/* -------------------------------------------------------------------------- */

function configHome(env) {
    const xdg = stringField(env, 'XDG_CONFIG_HOME');
    return join(xdg || join(homedir(), '.config'), 'feedly');
}

export function defaultConfigPath(env = process.env) {
    return join(configHome(env), 'config.json');
}

/**
 * Config discovery order:
 *   1. `--config <path>` / `FEEDLY_CONFIG_PATH`
 *   2. `$XDG_CONFIG_HOME/feedly/config.json` (default `~/.config/feedly/config.json`)
 *   3. `~/.feedly.json`
 *   4. `~/.opencli/feedly.json` (OpenCLI plugin compatibility)
 */
export function configCandidates(env = process.env) {
    const explicit = stringField(env, 'FEEDLY_CONFIG_PATH');
    const candidates = [
        ...(explicit ? [explicit] : []),
        defaultConfigPath(env),
        join(homedir(), '.feedly.json'),
        join(homedir(), '.opencli', 'feedly.json'),
    ];
    return [...new Set(candidates)];
}

export function resolveConfigPath({
    env = process.env,
    configPath = '',
    mustExist = true,
    exists = existsSync,
} = {}) {
    const explicit = stringField({ path: configPath }, 'path') || stringField(env, 'FEEDLY_CONFIG_PATH');
    if (explicit) {
        if (mustExist && !exists(explicit)) {
            throw new ConfigError(
                `Feedly config not found: ${explicit}`,
                'Run `feedly login --refresh-token <token> --config <path>` to create it.',
            );
        }
        return explicit;
    }

    for (const candidate of configCandidates(env)) {
        if (exists(candidate)) return candidate;
    }

    if (!mustExist) return defaultConfigPath(env);
    throw new ConfigError(
        `No Feedly config found. Looked for:\n${configCandidates(env).map((path) => `  - ${path}`).join('\n')}`,
        'Run `feedly login --refresh-token <token>`, set FEEDLY_CONFIG_PATH, or pass --config <path>.',
    );
}

function normalizeExpiresAt(value) {
    if (!value) return 0;
    // Some tools store seconds since epoch; this CLI stores milliseconds.
    return value < 10_000_000_000 ? value * 1000 : value;
}

export function configFromRaw(path, raw) {
    return {
        path,
        raw,
        accessToken: stringField(raw, 'access_token', 'accessToken'),
        refreshToken: stringField(raw, 'refresh_token', 'refreshToken'),
        userId: stringField(raw, 'user_id', 'userId', 'id'),
        clientId: stringField(raw, 'client_id', 'clientId'),
        clientSecret: stringField(raw, 'client_secret', 'clientSecret'),
        expiresAt: normalizeExpiresAt(numberField(raw, 'expires_at', 'expiresAt', 'expiry', 'expires')),
    };
}

export function loadConfig({ env = process.env, configPath = '', readFile = readFileSync, exists } = {}) {
    const path = resolveConfigPath({ env, configPath, exists });
    let rawText;
    try {
        rawText = readFile(path, 'utf-8');
    } catch {
        throw new ConfigError(`Unable to read Feedly config: ${path}`);
    }

    let raw;
    try {
        raw = JSON.parse(rawText);
    } catch {
        throw new ConfigError(`Feedly config is not valid JSON: ${path}`);
    }
    if (!isRecord(raw)) {
        throw new ConfigError(`Feedly config must be a JSON object: ${path}`);
    }

    const config = configFromRaw(path, raw);
    if (!config.accessToken && !config.refreshToken) {
        throw new ConfigError(
            `Feedly config is missing credentials: ${path}`,
            'Expected refresh_token for automatic refresh, or access_token for a static token.',
        );
    }
    return config;
}

export function saveConfig(config, patch, { writeFile = writeFileSync, mkdir = mkdirSync } = {}) {
    const next = { ...config.raw, ...patch };
    for (const [key, value] of Object.entries(next)) {
        if (value === undefined) delete next[key];
    }
    mkdir(dirname(config.path), { recursive: true });
    writeFile(config.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return configFromRaw(config.path, next);
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

function refreshClientIds(config) {
    const ids = [];
    if (config.clientId) ids.push(config.clientId);
    for (const id of DEFAULT_CLIENT_IDS) {
        if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

async function parseJsonResponse(resp, label) {
    const text = await resp.text();
    if (!text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        throw new ApiError(`${label} returned malformed JSON`);
    }
}

/**
 * Node's built-in fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY is set
 * (Node >= 23.6 / 24). Point users at the fix when a proxy is configured.
 */
function networkErrorHint(env) {
    const proxy = stringField(env, 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
    if (!proxy || stringField(env, 'NODE_USE_ENV_PROXY')) return '';
    return `A proxy is configured (${proxy}) but Node's fetch ignores proxy environment variables by default. Re-run with NODE_USE_ENV_PROXY=1 (Node >= 23.6).`;
}

async function fetchForToken(url, init, env, fetchImpl) {
    try {
        return await fetchImpl(url, init);
    } catch (err) {
        const cause = err?.cause?.message ? ` (${err.cause.message})` : '';
        throw new ApiError(`Feedly token refresh request failed: ${err?.message || err}${cause}`, { hint: networkErrorHint(env) });
    }
}

export async function refreshAccessToken(config, { fetchImpl = fetch, writeFile = writeFileSync, mkdir = mkdirSync, env = process.env } = {}) {
    if (!config.refreshToken) {
        throw new AuthError(
            'Feedly access token is expired and no refresh_token is configured.',
            'Run `feedly login --refresh-token <token>` to store a refresh token.',
        );
    }

    const failures = [];
    for (const clientId of refreshClientIds(config)) {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: config.refreshToken,
            client_id: clientId,
        });
        if (config.clientSecret) body.set('client_secret', config.clientSecret);

        const resp = await fetchForToken(`${resolveApiBases(env).apiBase}/auth/token`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
            body,
        }, env, fetchImpl);
        const data = await parseJsonResponse(resp, `Feedly token refresh (${clientId})`);
        if (resp.ok && isRecord(data) && typeof data.access_token === 'string' && data.access_token.trim()) {
            const expiresIn = Math.max(1, Number(data.expires_in || 3600)) * 1000;
            return saveConfig(config, {
                access_token: data.access_token,
                expires_at: Date.now() + expiresIn,
                ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
                ...(config.raw.accessToken !== undefined ? { accessToken: data.access_token } : {}),
                ...(config.raw.expiresAt !== undefined ? { expiresAt: Date.now() + expiresIn } : {}),
                ...(data.refresh_token && config.raw.refreshToken !== undefined ? { refreshToken: data.refresh_token } : {}),
            }, { writeFile, mkdir });
        }
        failures.push(`${clientId}: HTTP ${resp.status}`);
    }

    throw new AuthError(
        `Feedly token refresh failed (${failures.join('; ')}).`,
        'The refresh token may have been revoked; run `feedly login --refresh-token <token>` again.',
    );
}

async function ensureAccessToken(config, opts) {
    if (config.accessToken && (!config.expiresAt || Date.now() < config.expiresAt - TOKEN_EXPIRY_SKEW_MS)) {
        return { config, accessToken: config.accessToken };
    }
    const refreshed = await refreshAccessToken(config, opts);
    return { config: refreshed, accessToken: refreshed.accessToken };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

function buildUrl(path, query = {}, apiBase = DEFAULT_API_BASE) {
    const raw = path.startsWith('http') ? path : `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
    const url = new URL(raw);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

async function fetchWithTimeout(fetchImpl, url, init, timeout, env) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
        if (controller.signal.aborted) {
            throw new ApiError(`Feedly request timed out after ${timeout}ms: ${url}`);
        }
        const cause = err?.cause?.message ? ` (${err.cause.message})` : '';
        throw new ApiError(`Feedly request failed: ${err?.message || err}${cause}`, { hint: networkErrorHint(env) });
    } finally {
        clearTimeout(timer);
    }
}

export async function apiRequest(path, {
    method = 'GET',
    query,
    body,
    config,
    env = process.env,
    configPath = '',
    fetchImpl = fetch,
    timeout = DEFAULT_TIMEOUT_MS,
    retryAuth = true,
    writeFile = writeFileSync,
    mkdir = mkdirSync,
    readFile = readFileSync,
} = {}) {
    let activeConfig = config || loadConfig({ env, configPath, readFile });
    const tokenInfo = await ensureAccessToken(activeConfig, { fetchImpl, writeFile, mkdir, env });
    activeConfig = tokenInfo.config;

    const { apiBase } = resolveApiBases(env);
    const url = buildUrl(path, query, apiBase);
    const resp = await fetchWithTimeout(fetchImpl, url, {
        method,
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${tokenInfo.accessToken}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    }, timeout, env);

    if (resp.status === 401 && retryAuth && activeConfig.refreshToken) {
        const refreshed = await refreshAccessToken(activeConfig, { fetchImpl, writeFile, mkdir, env });
        return apiRequest(path, {
            method,
            query,
            body,
            config: refreshed,
            env,
            fetchImpl,
            timeout,
            retryAuth: false,
            writeFile,
            mkdir,
            readFile,
        });
    }

    if (resp.status === 204 || resp.status === 202) return null;
    const data = await parseJsonResponse(resp, `Feedly API ${method} ${path}`);
    if (!resp.ok) {
        const message = isRecord(data)
            ? stringField(data, 'errorMessage', 'message', 'error') || `HTTP ${resp.status}`
            : `HTTP ${resp.status}`;
        if (resp.status === 401 || resp.status === 403) {
            throw new AuthError(
                `Feedly API rejected the credentials: ${message}`,
                resp.status === 403 ? 'The Feedly plan may not include this feature.' : '',
            );
        }
        throw new ApiError(`Feedly API ${method} ${path} failed: ${message}`, { status: resp.status });
    }
    return data;
}

export function globalAllStreamId(userId) {
    if (!userId) {
        throw new ApiError('Feedly profile did not include a user id for the default stream.');
    }
    return `user/${userId}/category/global.all`;
}
