import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BIN = fileURLToPath(new URL('../bin/feedly.js', import.meta.url));
const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8')).version;

let server;
let baseUrl;
let dir;
let configPath;
let markerPayloads;
let searchBodies;
let tokenRequests;
let deviceRequests;
let devicePolls;

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
    deviceRequests = [];
    devicePolls = [];

    server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const send = (status, data) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(data === undefined ? '' : JSON.stringify(data));
        };

        if (url.pathname === '/v3/auth/device') {
            deviceRequests.push(await readBody(req));
            return send(200, {
                device_code: 'device-code-1',
                user_code: 'ABC-DEF-GHI',
                verification_uri: 'https://cloud.feedly.com/v3/auth/connect',
                verification_uri_complete: 'https://cloud.feedly.com/v3/auth/connect/ABC-DEF-GHI',
                expires_in: 900,
                interval: 1,
            });
        }

        if (url.pathname === '/v3/auth/token') {
            const body = await readBody(req);
            tokenRequests.push(body);
            if (body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code')) {
                devicePolls.push(body);
                if (devicePolls.length < 2) return send(400, { error: 'authorization_pending' });
                return send(200, { access_token: 'device-token', refresh_token: 'device-refresh', expires_in: 3600 });
            }
            return send(200, { access_token: 'refreshed-token', refresh_token: 'refresh-rotated', expires_in: 3600 });
        }

        if (req.headers.authorization !== 'Bearer test-token' && req.headers.authorization !== 'Bearer refreshed-token' && req.headers.authorization !== 'Bearer device-token') {
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
                        // TMTPost shape: short RSS summary next to a long full-text body.
                        summary: { content: '<p>short teaser</p>' },
                        content: { content: `<p>${'long body '.repeat(200)}</p>` },
                    },
                    // 36kr shape: no content block, but a long summary.
                    {
                        id: 'entry-2',
                        title: 'Second entry',
                        origin: { title: 'Feed B', streamId: 'feed/b' },
                        summary: { content: `<p>${'summary only '.repeat(100)}</p>` },
                    },
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
        assert.equal(version.stdout.trim(), VERSION);

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

    it('returns full article bodies through --json/--jsonl (regression)', async () => {
        const { code, stdout } = await runCli(['unread', '--limit', '2', '--jsonl'], { env: cliEnv() });
        assert.equal(code, 0);
        const [first, second] = stdout.trim().split('\n').map((line) => JSON.parse(line));

        // TMTPost shape: the long body survives, and summary stays the teaser.
        assert.ok(first.content.length > 240, `content was ${first.content.length}`);
        assert.match(first.content, /long body/);
        assert.equal(first.summary, 'short teaser');

        // 36kr shape: a long summary is no longer sliced to 240.
        assert.ok(second.summary.length > 240, `summary was ${second.summary.length}`);
        assert.equal(second.content, second.summary);
    });

    it('exposes content as an opt-in column and supports --body-limit/--no-body', async () => {
        const selected = await runCli(['unread', '--limit', '1', '--columns', 'id,content', '--json'], { env: cliEnv() });
        assert.equal(selected.code, 0);
        const [row] = JSON.parse(selected.stdout);
        // `--columns` projects tabular output but JSON keeps full rows.
        assert.equal(row.id, 'entry-1');
        assert.ok(row.content.length > 240, `content was ${row.content.length}`);

        const limited = await runCli(['unread', '--limit', '1', '--body-limit', '50', '--json'], { env: cliEnv() });
        assert.equal(limited.code, 0);
        const capped = JSON.parse(limited.stdout)[0].content;
        assert.ok(capped.startsWith('long body'), capped);
        assert.match(capped, /…\[truncated \d+ chars\]$/);
        // 50 chars of body plus the truncation marker, not the full 2000.
        assert.ok(capped.length < 100, `capped was ${capped.length}`);

        const noBody = await runCli(['unread', '--limit', '1', '--no-body', '--json'], { env: cliEnv() });
        assert.equal(noBody.code, 0);
        assert.equal('content' in JSON.parse(noBody.stdout)[0], false);
        assert.equal('summary' in JSON.parse(noBody.stdout)[0], false);

        const badLimit = await runCli(['unread', '--body-limit', 'abc'], { env: cliEnv() });
        assert.equal(badLimit.code, 2);
        assert.match(badLimit.stderr, /--body-limit must be a positive integer/);
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

    it('logs in through the device flow without a browser', async () => {
        const loginPath = join(dir, 'device-login.json');
        devicePolls.length = 0;

        const stored = await runCli(
            ['login', '--device', '--no-browser', '--no-verify', '--config', loginPath, '--json'],
            { env: cliEnv({ BROWSER: '', DISPLAY: '', CI: '' }) },
        );

        assert.equal(stored.code, 0, stored.stderr);
        // The device code and approval URL must be surfaced to the user.
        assert.match(stored.stderr, /ABC-DEF-GHI/);
        assert.match(stored.stderr, /https:\/\/cloud\.feedly\.com\/v3\/auth\/connect\/ABC-DEF-GHI/);
        assert.equal(JSON.parse(stored.stdout)[0].status, 'stored');

        // Tokens come from the device grant, persisted as returned.
        const config = JSON.parse(readFileSync(loginPath, 'utf-8'));
        assert.equal(config.access_token, 'device-token');
        assert.equal(config.refresh_token, 'device-refresh');
        // The minting client is recorded so refresh does not try the wrong one.
        assert.equal(config.client_id, 'feedlydev');
        assert.equal(deviceRequests.length, 1);
        assert.match(deviceRequests[0], /client_id=feedlydev/);
        // Pending then approved: the CLI keeps polling until tokens arrive.
        assert.equal(devicePolls.length, 2);

        // A second run verifies the stored credentials against /profile.
        const verified = await runCli(
            ['login', '--device', '--no-browser', '--config', loginPath, '--json'],
            { env: cliEnv({ BROWSER: '', DISPLAY: '', CI: '' }) },
        );
        assert.equal(verified.code, 0, verified.stderr);
        assert.equal(JSON.parse(verified.stdout)[0].status, 'logged_in');
        assert.equal(JSON.parse(verified.stdout)[0].id, 'user-1');
    });

    it('prints a login URL with --print-url without writing config', async () => {
        const loginPath = join(dir, 'print-url.json');
        const { code, stdout } = await runCli(['login', '--print-url', '--config', loginPath], { env: cliEnv() });
        assert.equal(code, 0);
        assert.match(stdout, /^https:\/\/cloud\.feedly\.com\/v3\/auth\/connect\/ABC-DEF-GHI\n$/);
        assert.equal(existsSync(loginPath), false);
    });

    it('accepts a pasted token JSON on stdin and keeps the user id', async () => {
        const loginPath = join(dir, 'pasted.json');
        const payload = JSON.stringify({ id: 'user-9', refresh_token: 'pasted-refresh' });
        const { code, stdout } = await runCli(
            ['login', '--no-verify', '--config', loginPath, '--json'],
            { env: cliEnv(), input: `${payload}\n` },
        );
        assert.equal(code, 0);
        assert.equal(JSON.parse(stdout)[0].status, 'stored');
        assert.equal(JSON.parse(stdout)[0].id, 'user-9');

        const stored = JSON.parse(readFileSync(loginPath, 'utf-8'));
        assert.equal(stored.refresh_token, 'pasted-refresh');
        assert.equal(stored.user_id, 'user-9');
    });

    it('stores a token passed through --token @file', async () => {
        const tokenFile = join(dir, 'token.txt');
        const loginPath = join(dir, 'file-login.json');
        writeFileSync(tokenFile, 'file-refresh\n');

        const { code } = await runCli(
            ['login', '--token', `@${tokenFile}`, '--no-verify', '--config', loginPath],
            { env: cliEnv() },
        );
        assert.equal(code, 0);
        assert.equal(JSON.parse(readFileSync(loginPath, 'utf-8')).refresh_token, 'file-refresh');
    });

    it('fails fast when pasted input is empty', async () => {
        const { code, stderr } = await runCli(
            ['login', '--config', join(dir, 'never.json')],
            { env: cliEnv(), input: '' },
        );
        assert.equal(code, 2);
        assert.match(stderr, /No token was provided/);
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

    it('prints the bundled skill and delegates install to `skills`', async () => {
        const skillHome = mkdtempSync(join(tmpdir(), 'feedly-skill-e2e-'));
        try {
            // `feedly skill` prints SKILL.md so an agent can self-serve.
            const read = await runCli(['skill'], { env: cliEnv({ HOME: skillHome }) });
            assert.equal(read.code, 0);
            assert.match(read.stdout, /^---\nname: feedly-cli\n/);

            const listing = await runCli(['skill', 'list'], { env: cliEnv({ HOME: skillHome }) });
            assert.equal(listing.code, 0);
            assert.match(listing.stdout, /SKILL\.md/);
            assert.match(listing.stdout, /references\/search-api\.md/);

            const single = await runCli(['skill', 'read', 'references/search-api.md'], { env: cliEnv({ HOME: skillHome }) });
            assert.equal(single.code, 0);
            assert.match(single.stdout, /search\/contents/);

            // Install is delegated to the `skills` CLI; assert the exact command.
            // Default source is the BUNDLED skill so it always matches this
            // CLI version (regression: it used to fetch the GitHub repo).
            const dry = await runCli(['skill', 'install', '--dry-run', '--json'], { env: cliEnv({ HOME: skillHome }) });
            assert.equal(dry.code, 0);
            const row = JSON.parse(dry.stdout)[0];
            assert.equal(row.status, 'dry-run');
            assert.match(row.command, /skills@latest add .*skills\/feedly-cli -s feedly-cli -a universal -g/);
            assert.doesNotMatch(row.command, /add coolxll\/feedly-cli/);
            assert.match(dry.stderr, /# would run: npx -y skills@latest add/);

            const projectScoped = await runCli(['skill', 'install', '--project', '--dry-run', '--json'], { env: cliEnv({ HOME: skillHome }) });
            assert.doesNotMatch(JSON.parse(projectScoped.stdout)[0].command, / -g /);

            const custom = await runCli(
                ['skill', 'install', '--from', 'someone/other-repo', '--agent', 'claude-code', '--dry-run', '--json'],
                { env: cliEnv({ HOME: skillHome }) },
            );
            assert.match(JSON.parse(custom.stdout)[0].command, /add someone\/other-repo -s feedly-cli -a claude-code/);

            // `update` re-syncs from the bundled skill, not the GitHub repo.
            const update = await runCli(['skill', 'update', '--dry-run', '--json'], { env: cliEnv({ HOME: skillHome }) });
            assert.equal(update.code, 0);
            assert.match(JSON.parse(update.stdout)[0].command, /skills@latest add .*skills\/feedly-cli/);

            // `update upstream` follows the lock origin instead.
            const upstream = await runCli(['skill', 'update', 'upstream', '--dry-run', '--json'], { env: cliEnv({ HOME: skillHome }) });
            assert.match(JSON.parse(upstream.stdout)[0].command, /skills@latest update feedly-cli/);

            const status = await runCli(['skill', 'status', '--json'], { env: cliEnv({ HOME: skillHome }) });
            assert.equal(status.code, 0);
            assert.match(JSON.parse(status.stdout)[0].status, /installed=no/);
        } finally {
            rmSync(skillHome, { recursive: true, force: true });
        }
    });

    it('advertises the agent skill in help output', async () => {
        const { stdout } = await runCli(['--help']);
        assert.match(stdout, /AI agents: this CLI ships its own usage skill/);
        assert.match(stdout, /feedly skill {2,}print the agent instructions/);
    });

    it('surfaces API failures with exit code 4', async () => {
        const { code, stderr } = await runCli(['profile'], {
            env: cliEnv({ FEEDLY_API_BASE: `${baseUrl}/nope` }),
        });
        assert.equal(code, 4);
        assert.match(stderr, /^error: Feedly API GET \/profile failed/m);
    });
});
