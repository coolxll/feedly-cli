import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from '../src/errors.js';
import { deviceLogin, pollDeviceToken, requestDeviceCode } from '../src/client.js';
import { canOpenBrowser, maskToken, openUrl, parseTokenInput } from '../src/login.js';

function jsonResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(data),
    };
}

describe('token input parsing', () => {
    it('extracts fields from the Feedly developer page JSON', () => {
        const input = JSON.stringify({
            id: 'user-1',
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
        });
        assert.deepEqual(parseTokenInput(input), {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            userId: 'user-1',
            expiresAt: 0,
        });
    });

    it('treats a JWT as an access token and anything else as a refresh token', () => {
        assert.deepEqual(parseTokenInput('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'), {
            accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
        });
        assert.deepEqual(parseTokenInput('Aq6-abcdefghijklmnop'), { refreshToken: 'Aq6-abcdefghijklmnop' });
    });

    it('strips a copied Authorization header and handles empty input', () => {
        assert.deepEqual(parseTokenInput('Authorization: Bearer Aq6-tokenvalue'), { refreshToken: 'Aq6-tokenvalue' });
        assert.deepEqual(parseTokenInput('   '), {});
    });

    it('masks tokens for display', () => {
        assert.equal(maskToken(''), '');
        assert.equal(maskToken('short'), '*****');
        assert.match(maskToken('abcdefghijklmnopqrstuvwxyz'), /^abcdef…wxyz \(26 chars\)$/);
    });
});

describe('browser launching', () => {
    it('only reports a browser when a display is available', () => {
        assert.equal(canOpenBrowser({ platform: 'darwin', env: {} }), true);
        assert.equal(canOpenBrowser({ platform: 'linux', env: {} }), false);
        assert.equal(canOpenBrowser({ platform: 'linux', env: { DISPLAY: ':0' } }), true);
        assert.equal(canOpenBrowser({ platform: 'linux', env: { DISPLAY: ':0', CI: 'true' } }), false);
        assert.equal(canOpenBrowser({ platform: 'darwin', env: { FEEDLY_NO_BROWSER: '1' } }), false);
    });

    it('does not spawn anything in headless environments', async () => {
        assert.equal(await openUrl('https://example.com', { platform: 'linux', env: {} }), false);
    });
});

describe('device flow', () => {
    const devicePayload = {
        device_code: 'device-1',
        user_code: 'ABC-DEF-GHI',
        verification_uri: 'https://cloud.feedly.com/v3/auth/connect',
        verification_uri_complete: 'https://cloud.feedly.com/v3/auth/connect/ABC-DEF-GHI',
        expires_in: 900,
        interval: 5,
    };

    it('requests a device code with the public dev client', async () => {
        let seenBody;
        const fetchImpl = async (url, init) => {
            assert.match(String(url), /\/v3\/auth\/device$/);
            seenBody = init.body;
            return jsonResponse(200, devicePayload);
        };

        const device = await requestDeviceCode({ fetchImpl });

        assert.equal(seenBody.get('client_id'), 'feedlydev');
        assert.equal(seenBody.get('client_secret'), 'feedlydev');
        assert.equal(device.userCode, 'ABC-DEF-GHI');
        assert.equal(device.interval, 5);
    });

    it('maps polling outcomes to statuses', async () => {
        const pending = async () => jsonResponse(400, { error: 'authorization_pending' });
        const denied = async () => jsonResponse(400, { error: 'access_denied' });
        const approved = async () => jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 });

        assert.deepEqual(await pollDeviceToken({ deviceCode: 'd', fetchImpl: pending }), { status: 'pending' });
        assert.deepEqual(await pollDeviceToken({ deviceCode: 'd', fetchImpl: denied }), { status: 'denied' });
        const ok = await pollDeviceToken({ deviceCode: 'd', fetchImpl: approved });
        assert.equal(ok.status, 'approved');
        assert.equal(ok.tokens.access_token, 'a');
    });

    it('polls until approval and reports the tokens', async () => {
        let polls = 0;
        const fetchImpl = async (url) => {
            if (/\/auth\/device$/.test(String(url))) return jsonResponse(200, devicePayload);
            polls += 1;
            if (polls === 1) return jsonResponse(400, { error: 'authorization_pending' });
            return jsonResponse(200, { access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 3600 });
        };

        let clock = 0;
        const prompts = [];
        const result = await deviceLogin({
            fetchImpl,
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
            onPrompt: (device) => prompts.push(device.userCode),
        });

        assert.equal(polls, 2);
        assert.deepEqual(prompts, ['ABC-DEF-GHI']);
        assert.equal(result.tokens.access_token, 'device-access');
        assert.equal(result.tokens.refresh_token, 'device-refresh');
    });

    it('honours slow_down by waiting longer', async () => {
        const sleeps = [];
        let clock = 0;
        let polls = 0;
        const fetchImpl = async (url) => {
            if (/\/auth\/device$/.test(String(url))) return jsonResponse(200, devicePayload);
            polls += 1;
            if (polls === 1) return jsonResponse(400, { error: 'slow_down' });
            return jsonResponse(200, { access_token: 'a', expires_in: 60 });
        };

        await deviceLogin({
            fetchImpl,
            now: () => clock,
            sleep: async (ms) => { sleeps.push(ms); clock += ms; },
        });

        assert.deepEqual(sleeps, [5000, 10000]);
    });

    it('fails on denial and on expiry', async () => {
        const deniedFetch = async (url) => (/\/auth\/device$/.test(String(url))
            ? jsonResponse(200, devicePayload)
            : jsonResponse(400, { error: 'access_denied' }));

        await assert.rejects(() => deviceLogin({
            fetchImpl: deniedFetch,
            now: () => 0,
            sleep: async () => {},
        }), AuthError);

        const pendingFetch = async (url) => (/\/auth\/device$/.test(String(url))
            ? jsonResponse(200, { ...devicePayload, expires_in: 1, interval: 1 })
            : jsonResponse(400, { error: 'authorization_pending' }));

        let clock = 0;
        await assert.rejects(() => deviceLogin({
            fetchImpl: pendingFetch,
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
            maxWaitMs: 10_000,
        }), /Timed out waiting for Feedly device approval/);
    });
});
