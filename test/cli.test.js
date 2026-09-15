import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BIN = fileURLToPath(new URL('../bin/feedly.js', import.meta.url));

let server;
let baseUrl;
let dir;
let configPath;
let markerPayloads;
let searchBodies;
let tokenRequests;

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
}

function runCli(args, { env = {}, input } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN, ...args], {
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input ?? '');
    });
}

function cliEnv(extra = {}) {
    return {
        FEEDLY_CONFIG_PATH: configPath,
        FEEDLY_API_BASE: `${baseUrl}/v3`,
        FEEDLY_SEARCH_API_BASE: `${baseUrl}/v3`,
        ...extra,
    };
}

before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'feedly-cli-e2e-'));
    configPath = join(dir, 'feedly.json');
    writeFileSync(configPath, JSON.stringify({ access_token: 'test-token' }));
    markerPayloads = [];
    searchBodies = [];
    tokenRequests = [];

    server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const send = (status, data) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(data === undefined ? '' : JSON.stringify(data));
        };

        if (url.pathname === '/v3/auth/token') {
            tokenRequests.push(await readBody(req));
            return send(200, { access_token: 'refreshed-token', refresh_token: 'refresh-rotated', expires_in: 3600 });
        }

        if (req.headers.authorization !== 'Bearer test-token' && req.headers.authorization !== 'Bearer refreshed-token') {
            return send(401, { errorMessage: 'bad token' });
        }

        if (url.pathname === '/v3/profile') {
            return send(200, { id: 'user-1', email: 'test@example.com', givenName: 'Test', familyName: 'User', locale: 'en' });
        }
        if (url.pathname === '/v3/streams/contents') {
            return send(200, {
                continuation: null,
                items: [
                    {
                        id: 'entry-1',
                        title: 'First entry',
                        published: 1_700_000_000_000,
                        origin: { title: 'Feed A', streamId: 'feed/a' },
                        alternate: [{ href: 'https://example.com/1' }],
                    },
                    { id: 'entry-2', title: 'Second entry', origin: { title: 'Feed B', streamId: 'feed/b' } },
                ],
            });
        }
        if (url.pathname === '/v3/markers/counts') {
            return send(200, { unreadcounts: [{ id: 'feed/a', count: 2 }, { id: 'feed/b', count: 1 }] });
        }
        if (url.pathname === '/v3/categories') {
            return send(200, [{ id: 'user/user-1/category/Tech', label: 'Tech' }]);
        }
        if (url.pathname === '/v3/subscriptions') {
            return send(200, [{ id: 'feed/a', title: 'Feed A', categories: [{ label: 'Tech' }], website: 'https://a.example.com' }]);
        }
        if (url.pathname === '/v3/search/contents') {
            searchBodies.push(JSON.parse(await readBody(req)));
            return send(200, {
                items: [{ id: 'entry-9', title: 'Search hit', origin: { title: 'Feed A', streamId: 'feed/a' } }],
            });
        }
        if (url.pathname === '/v3/markers' && req.method === 'POST') {
            markerPayloads.push(JSON.parse(await readBody(req)));
            return send(204);
        }
        return send(404, { errorMessage: `no route for ${url.pathname}` });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('feedly CLI end to end', () => {
    it('prints version and help', async () => {
        const version = await runCli(['--version']);
        assert.equal(version.code, 0);
        assert.equal(version.stdout.trim(), '1.0.0');

        const help = await runCli([]);
        assert.equal(help.code, 0);
        assert.match(help.stdout, /Usage: feedly <command> \[options\]/);
        assert.match(help.stdout, /mark-read/);
    });

    it('prints command help', async () => {
        const { code, stdout } = await runCli(['search', '--help']);
        assert.equal(code, 0);
        assert.match(stdout, /Usage: feedly search \[query\] \[options\]/);
        assert.match(stdout, /--scope <scope>/);
    });

    it('returns profile as json', async () => {
        const { code, stdout, stderr } = await runCli(['profile', '--json'], { env: cliEnv() });
        assert.equal(code, 0, stderr);
        assert.deepEqual(JSON.parse(stdout), [{
            id: 'user-1',
            email: 'test@example.com',
            name: 'Test User',
            locale: 'en',
        }]);
    });

    it('returns unread entries as jsonl and honors --limit', async () => {
        const { code, stdout } = await runCli(['unread', '--limit', '2', '--jsonl'], { env: cliEnv() });
        assert.equal(code, 0);
        const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(lines.length, 2);
        assert.equal(lines[0].id, 'entry-1');
    });

    it('renders tables and csv by default and with -f', async () => {
        const table = await runCli(['streams'], { env: cliEnv() });
        assert.equal(table.code, 0);
        assert.match(table.stdout, /^ID\s+TYPE/);

        const csv = await runCli(['streams', '-f', 'csv'], { env: cliEnv() });
        assert.equal(csv.code, 0);
        assert.match(csv.stdout, /^id,type,label,parent,unread\n/);
        assert.match(csv.stdout, /feed\/a,feed,Feed A,Tech,2/);
    });

    it('searches and forwards the scope to the request body', async () => {
        const { code, stdout } = await runCli(['search', 'node', '--scope', 'tech', '--json'], { env: cliEnv() });
        assert.equal(code, 0);
        assert.equal(JSON.parse(stdout)[0].title, 'Search hit');
        assert.deepEqual(searchBodies.at(-1).source.items, [
            { label: 'Tech Blogs', type: 'publicationBucket', id: 'byf:tech', tier: 'tier1' },
        ]);
    });

    it('marks entries read only with explicit confirmation', async () => {
        const refused = await runCli(['mark-read', '--ids', 'entry-1', '--confirm', 'NOPE'], { env: cliEnv() });
        assert.equal(refused.code, 2);
        assert.match(refused.stderr, /--confirm MARK_READ is required/);

        const { code, stdout } = await runCli(
            ['mark-read', '--ids', 'entry-1,entry-2', '--confirm', 'MARK_READ', '--json'],
            { env: cliEnv() },
        );
        assert.equal(code, 0);
        assert.deepEqual(JSON.parse(stdout), [{ status: 'marked_read', count: 2 }]);
        assert.deepEqual(markerPayloads.at(-1), {
            action: 'markAsRead',
            type: 'entries',
            entryIds: ['entry-1', 'entry-2'],
        });
    });

    it('accepts entry ids on stdin', async () => {
        const unread = await runCli(['unread', '--limit', '2', '--jsonl'], { env: cliEnv() });
        const marked = await runCli(['mark-read', '--ids', '-', '--confirm', 'MARK_READ', '--json'], {
            env: cliEnv(),
            input: unread.stdout,
        });
        assert.equal(marked.code, 0);
        assert.deepEqual(markerPayloads.at(-1).entryIds, ['entry-1', 'entry-2']);
    });

    it('shows the resolved config file', async () => {
        const { code, stdout } = await runCli(['config', '--json'], { env: cliEnv() });
        assert.equal(code, 0);
        const rows = JSON.parse(stdout);
        const current = rows.find((row) => row.path === configPath);
        assert.equal(current.exists, 'yes');
        assert.equal(current.credentials, 'access_token');
    });

    it('logs in with a refresh token and stores it', async () => {
        const loginPath = join(dir, 'login.json');
        const { code, stdout, stderr } = await runCli(
            ['login', '--refresh-token', 'refresh-new', '--config', loginPath, '--json'],
            { env: cliEnv() },
        );
        assert.equal(code, 0, stderr);
        assert.equal(JSON.parse(stdout)[0].status, 'logged_in');

        const stored = JSON.parse(readFileSync(loginPath, 'utf-8'));
        assert.equal(stored.refresh_token, 'refresh-rotated');
        assert.equal(stored.access_token, 'refreshed-token');
        assert.match(tokenRequests.at(-1), /client_id=feedly/);
    });

    it('fails with exit code 3 when the config is missing', async () => {
        const { code, stderr } = await runCli(['profile'], {
            env: cliEnv({ FEEDLY_CONFIG_PATH: join(dir, 'missing.json') }),
        });
        assert.equal(code, 3);
        assert.match(stderr, /^error: Feedly config not found/m);
    });

    it('fails with exit code 2 for usage errors', async () => {
        const unknownCommand = await runCli(['nope'], { env: cliEnv() });
        assert.equal(unknownCommand.code, 2);
        assert.match(unknownCommand.stderr, /Unknown command: nope/);

        const unknownOption = await runCli(['profile', '--nope'], { env: cliEnv() });
        assert.equal(unknownOption.code, 2);
        assert.match(unknownOption.stderr, /Unknown option/);

        const badFormat = await runCli(['profile', '--format', 'yaml'], { env: cliEnv() });
        assert.equal(badFormat.code, 2);
        assert.match(badFormat.stderr, /Unknown format: yaml/);

        const unexpected = await runCli(['streams', 'extra'], { env: cliEnv() });
        assert.equal(unexpected.code, 2);
        assert.match(unexpected.stderr, /Unexpected argument: extra/);
    });

    it('surfaces API failures with exit code 4', async () => {
        const { code, stderr } = await runCli(['profile'], {
            env: cliEnv({ FEEDLY_API_BASE: `${baseUrl}/nope` }),
        });
        assert.equal(code, 4);
        assert.match(stderr, /^error: Feedly API GET \/profile failed/m);
    });
});
