import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, AuthError, ConfigError } from '../src/errors.js';
import {
    apiRequest,
    configCandidates,
    configFromRaw,
    defaultConfigPath,
    loadConfig,
    refreshAccessToken,
    resolveApiBases,
    resolveConfigPath,
    saveConfig,
} from '../src/client.js';

function jsonResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(data),
    };
}

function emptyResponse(status = 204) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => '',
    };
}

describe('config discovery', () => {
    let dir;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'feedly-cli-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('prefers an explicit path over the environment and defaults', () => {
        const explicit = join(dir, 'explicit.json');
        writeFileSync(explicit, '{}');
        assert.equal(resolveConfigPath({ env: { FEEDLY_CONFIG_PATH: join(dir, 'env.json') }, configPath: explicit }), explicit);
    });

    it('honors FEEDLY_CONFIG_PATH', () => {
        const path = join(dir, 'env.json');
        writeFileSync(path, '{}');
        assert.equal(resolveConfigPath({ env: { FEEDLY_CONFIG_PATH: path } }), path);
    });

    it('scans XDG, legacy dotfile, then OpenCLI locations', () => {
        const env = { XDG_CONFIG_HOME: dir };
        const [xdg, legacy, opencli] = configCandidates(env);

        assert.equal(resolveConfigPath({ env, exists: (path) => path === xdg }), xdg);
        assert.equal(resolveConfigPath({ env, exists: (path) => path === legacy }), legacy);
        assert.equal(resolveConfigPath({ env, exists: (path) => path === opencli }), opencli);
    });

    it('lists the default XDG config path first', () => {
        const candidates = configCandidates({ XDG_CONFIG_HOME: dir });
        assert.equal(candidates[0], join(dir, 'feedly', 'config.json'));
        assert.ok(candidates.some((path) => path.endsWith(join('.opencli', 'feedly.json'))));
    });

    it('resolves the default path without requiring an existing file', () => {
        assert.equal(
            resolveConfigPath({ env: { XDG_CONFIG_HOME: dir }, mustExist: false }),
            defaultConfigPath({ XDG_CONFIG_HOME: dir }),
        );
    });

    it('throws ConfigError when nothing exists', () => {
        assert.throws(
            () => resolveConfigPath({ env: { XDG_CONFIG_HOME: join(dir, 'missing') } }),
            ConfigError,
        );
    });
});

describe('config loading and saving', () => {
    let dir;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'feedly-cli-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('loads snake_case fields and normalizes second-based expiry', () => {
        const path = join(dir, 'feedly.json');
        writeFileSync(path, JSON.stringify({
            access_token: 'access-a',
            refresh_token: 'refresh-a',
            user_id: 'user-a',
            expires_at: 1_800_000_000,
        }));

        const config = loadConfig({ env: { FEEDLY_CONFIG_PATH: path } });

        assert.equal(config.accessToken, 'access-a');
        assert.equal(config.refreshToken, 'refresh-a');
        assert.equal(config.userId, 'user-a');
        assert.equal(config.expiresAt, 1_800_000_000_000);
    });

    it('loads camelCase fields', () => {
        const path = join(dir, 'feedly.json');
        writeFileSync(path, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() }));
        const config = loadConfig({ env: { FEEDLY_CONFIG_PATH: path } });
        assert.equal(config.accessToken, 'a');
        assert.equal(config.refreshToken, 'r');
    });

    it('rejects missing, malformed, and credential-free configs', () => {
        assert.throws(() => loadConfig({ env: { FEEDLY_CONFIG_PATH: join(dir, 'missing.json') } }), ConfigError);

        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{not json');
        assert.throws(() => loadConfig({ env: { FEEDLY_CONFIG_PATH: broken } }), ConfigError);

        const empty = join(dir, 'empty.json');
        writeFileSync(empty, '{}');
        assert.throws(() => loadConfig({ env: { FEEDLY_CONFIG_PATH: empty } }), ConfigError);
    });
});

describe('token refresh and API helper', () => {
    let dir;
    let config;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'feedly-cli-'));
        config = configFromRaw(join(dir, 'feedly.json'), { refresh_token: 'refresh-1' });
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('refreshes with client_id=feedly, then falls back to feedlydev', async () => {
        const seenClientIds = [];
        const fetchImpl = async (_url, init) => {
            seenClientIds.push(init.body.get('client_id'));
            if (seenClientIds.length === 1) return jsonResponse(400, { error: 'invalid_client' });
            return jsonResponse(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200 });
        };

        const refreshed = await refreshAccessToken(config, { fetchImpl });

        assert.deepEqual(seenClientIds, ['feedly', 'feedlydev']);
        assert.equal(refreshed.accessToken, 'access-2');
        assert.equal(refreshed.refreshToken, 'refresh-2');
        assert.ok(refreshed.expiresAt > Date.now());
        assert.equal(JSON.parse(readFileSync(config.path, 'utf-8')).refresh_token, 'refresh-2');
    });

    it('remembers the client that worked so later refreshes hit it first', async () => {
        // A refresh token is bound to its minting client; after falling back to
        // feedlydev the config should record it rather than retrying feedly.
        const first = [];
        await refreshAccessToken(config, {
            fetchImpl: async (_url, init) => {
                first.push(init.body.get('client_id'));
                if (first.length === 1) return jsonResponse(400, { error: 'invalid refresh_token' });
                return jsonResponse(200, { access_token: 'a', expires_in: 60 });
            },
        });
        assert.deepEqual(first, ['feedly', 'feedlydev']);
        assert.equal(JSON.parse(readFileSync(config.path, 'utf-8')).client_id, 'feedlydev');

        // Second refresh goes straight to the recorded client.
        const second = [];
        const reloaded = configFromRaw(config.path, JSON.parse(readFileSync(config.path, 'utf-8')));
        await refreshAccessToken(reloaded, {
            fetchImpl: async (_url, init) => {
                second.push(init.body.get('client_id'));
                return jsonResponse(200, { access_token: 'b', expires_in: 60 });
            },
        });
        assert.deepEqual(second, ['feedlydev']);
    });

    it('prefers a configured client id before the defaults', async () => {
        const seenClientIds = [];
        const withClient = { ...config, clientId: 'custom', clientSecret: 'secret' };
        const fetchImpl = async (_url, init) => {
            seenClientIds.push(init.body.get('client_id'));
            return jsonResponse(200, { access_token: 'access-3', expires_in: 60 });
        };

        await refreshAccessToken(withClient, { fetchImpl });

        assert.deepEqual(seenClientIds, ['custom']);
    });

    it('does not send client_secret on refresh, where it is ignored', async () => {
        const withSecret = { ...config, clientSecret: 'secret' };
        let body;
        await refreshAccessToken(withSecret, {
            fetchImpl: async (_url, init) => {
                body = init.body;
                return jsonResponse(200, { access_token: 'a', expires_in: 60 });
            },
        });
        assert.equal(body.get('client_secret'), null);
    });

    it('fails with AuthError when no refresh token is available', async () => {
        const staticConfig = configFromRaw(join(dir, 'static.json'), { access_token: 'expired' });
        await assert.rejects(() => refreshAccessToken(staticConfig, { fetchImpl: async () => jsonResponse(500, {}) }), AuthError);
    });

    it('saves refreshed tokens with restrictive permissions', async () => {
        const fetchImpl = async () => jsonResponse(200, { access_token: 'access-4', expires_in: 3600 });
        await refreshAccessToken(config, { fetchImpl });
        const mode = statSync(config.path).mode & 0o777;
        assert.equal(mode & 0o077, 0, `expected private permissions, got ${mode.toString(8)}`);
    });

    it('retries one API request after a 401 by refreshing the token', async () => {
        const active = configFromRaw(join(dir, 'active.json'), { access_token: 'old', refresh_token: 'refresh-1' });
        active.expiresAt = Date.now() + 600_000;

        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url: String(url), authorization: init.headers.authorization });
            if (String(url).endsWith('/profile') && init.headers.authorization === 'Bearer old') {
                return jsonResponse(401, { errorMessage: 'expired' });
            }
            if (String(url).endsWith('/auth/token')) {
                return jsonResponse(200, { access_token: 'new', expires_in: 3600 });
            }
            return jsonResponse(200, { id: 'user-1', email: 'a@example.com' });
        };

        const data = await apiRequest('/profile', { config: active, fetchImpl });

        assert.equal(data.id, 'user-1');
        assert.equal(calls.length, 3);
        assert.equal(calls[2].authorization, 'Bearer new');
    });

    it('raises AuthError without a retry when the token cannot be refreshed', async () => {
        const staticConfig = configFromRaw(join(dir, 'static2.json'), { access_token: 'old' });
        staticConfig.expiresAt = Date.now() + 600_000;
        const fetchImpl = async () => jsonResponse(401, { errorMessage: 'expired' });

        await assert.rejects(() => apiRequest('/profile', { config: staticConfig, fetchImpl }), AuthError);
    });

    it('throws ApiError for malformed JSON payloads', async () => {
        const active = configFromRaw(join(dir, 'malformed.json'), { access_token: 'access' });
        const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{not-json' });

        await assert.rejects(() => apiRequest('/profile', { config: active, fetchImpl }), ApiError);
    });

    it('returns null for 204 responses', async () => {
        const active = configFromRaw(join(dir, 'empty.json'), { access_token: 'access' });
        const fetchImpl = async () => emptyResponse();
        assert.equal(await apiRequest('/markers', { config: active, fetchImpl, method: 'POST', body: {} }), null);
    });

    it('uses FEEDLY_API_BASE and FEEDLY_SEARCH_API_BASE overrides', async () => {
        const seen = [];
        const active = configFromRaw(join(dir, 'base.json'), { access_token: 'access' });
        const fetchImpl = async (url) => {
            seen.push(String(url));
            return jsonResponse(200, { id: 'user-1' });
        };

        await apiRequest('/profile', {
            config: active,
            fetchImpl,
            env: { FEEDLY_API_BASE: 'http://localhost:1234/v3' },
        });

        assert.equal(seen[0], 'http://localhost:1234/v3/profile');
        assert.deepEqual(
            resolveApiBases({ FEEDLY_SEARCH_API_BASE: 'http://localhost:1234/search' }),
            { apiBase: 'https://cloud.feedly.com/v3', searchApiBase: 'http://localhost:1234/search' },
        );
    });

    it('times out slow requests', async () => {
        const active = configFromRaw(join(dir, 'slow.json'), { access_token: 'access' });
        const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });

        await assert.rejects(
            () => apiRequest('/profile', { config: active, fetchImpl, timeout: 10 }),
            /timed out/,
        );
    });

    it('stores refreshed expiry on camelCase configs too', async () => {
        const camel = configFromRaw(join(dir, 'camel.json'), { refreshToken: 'refresh-camel' });
        const fetchImpl = async () => jsonResponse(200, { access_token: 'access-camel', expires_in: 60 });
        await refreshAccessToken(camel, { fetchImpl });
        const raw = JSON.parse(readFileSync(camel.path, 'utf-8'));
        assert.equal(raw.access_token, 'access-camel');
        assert.equal(raw.accessToken ?? null, null);
    });

    it('saveConfig merges patches and drops undefined values', () => {
        const path = join(dir, 'merge.json');
        const base = configFromRaw(path, { refresh_token: 'r', expires_at: 1 });
        const next = saveConfig(base, { access_token: 'a', expires_at: undefined, expiresAt: undefined });
        assert.equal(next.accessToken, 'a');
        assert.equal(next.expiresAt, 0);
        assert.equal('expires_at' in next.raw, false);
    });
});
