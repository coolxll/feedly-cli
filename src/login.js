import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

export const FEEDLY_DEV_PAGE = 'https://feedly.com/v3/auth/dev';

/**
 * Open a URL in the user's browser. Never throws: login continues even when no
 * browser can be launched, because the URL is always printed too.
 */
export function openUrl(url, { env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
    if (!canOpenBrowser({ env, platform })) return Promise.resolve(false);

    const custom = typeof env.BROWSER === 'string' ? env.BROWSER.trim() : '';
    let command;
    let args;
    if (custom) {
        [command, ...args] = custom.split(/\s+/);
        args.push(url);
    } else if (platform === 'darwin') {
        command = 'open';
        args = [url];
    } else if (platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', url.replace(/&/g, '^&')];
    } else {
        command = 'xdg-open';
        args = [url];
    }

    return new Promise((resolve) => {
        try {
            const child = spawnImpl(command, args, { stdio: 'ignore', detached: true });
            child.on?.('error', () => resolve(false));
            child.unref?.();
            resolve(true);
        } catch {
            resolve(false);
        }
    });
}

export function canOpenBrowser({ env = process.env, platform = process.platform } = {}) {
    if (stringField(env, 'FEEDLY_NO_BROWSER') || stringField(env, 'CI')) return false;
    if (platform === 'darwin' || platform === 'win32') return true;
    if (stringField(env, 'DISPLAY') || stringField(env, 'WAYLAND_DISPLAY') || stringField(env, 'WSL_DISTRO_NAME')) return true;
    return false;
}

function stringField(obj, ...keys) {
    for (const key of keys) {
        const value = obj?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/**
 * Accept whatever the user copies from Feedly's developer page: the full token
 * JSON, a bare access/refresh token, or a `curl`-style header value.
 */
export function parseTokenInput(input) {
    const text = String(input || '').trim();
    if (!text) return {};

    if (text.startsWith('{')) {
        try {
            const raw = JSON.parse(text);
            return {
                accessToken: stringField(raw, 'access_token', 'accessToken', 'token'),
                refreshToken: stringField(raw, 'refresh_token', 'refreshToken'),
                userId: stringField(raw, 'user_id', 'userId', 'id'),
                expiresAt: numberField(raw, 'expires_at', 'expiresAt', 'expiry'),
            };
        } catch {
            // fall through and treat it as an opaque token
        }
    }

    const withoutBearer = text.replace(/^authorization:\s*/i, '').replace(/^bearer\s+/i, '').trim();
    const token = withoutBearer.split(/\s+/)[0] || '';

    // A JWT is an access token; anything else is the durable refresh token.
    if (token.split('.').length === 3 && token.startsWith('eyJ')) {
        return { accessToken: token };
    }
    return { refreshToken: token };
}

function numberField(obj, ...keys) {
    for (const key of keys) {
        const value = obj?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return 0;
}

/** Tokens are never printed in full; this is only for confirmations. */
export function maskToken(token) {
    const value = String(token || '');
    if (!value) return '';
    if (value.length <= 12) return '*'.repeat(value.length);
    return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

/** Read one line, prompting on stderr so stdout stays machine-readable. */
export function promptLine(question, { stdin = process.stdin, stderr = process.stderr } = {}) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: stdin, output: stderr, terminal: Boolean(stdin.isTTY) });
        let settled = false;
        const done = (value) => {
            if (settled) return;
            settled = true;
            try {
                rl.close();
            } catch {
                // ignore
            }
            resolve(value);
        };

        rl.question(question, (answer) => done(answer));
        // Closed/EOF stdin (CI, `< /dev/null`) must not hang the process.
        rl.once('close', () => done(''));
        stdin.once?.('end', () => done(''));
    });
}
