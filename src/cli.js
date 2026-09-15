import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ArgumentError, AuthError, ConfigError, FeedlyError } from './errors.js';
import {
    DEFAULT_TIMEOUT_MS,
    configCandidates,
    configFromRaw,
    defaultConfigPath,
    deviceLogin,
    loadConfig,
    refreshAccessToken,
    requestDeviceCode,
    saveConfig,
} from './client.js';
import {
    ENTRY_COLUMNS,
    SEARCH_SCOPES,
    getCategories,
    getCounts,
    getProfile,
    getStreamPage,
    getStreams,
    getSubscriptions,
    getUnreadEntries,
    markEntriesRead,
    parseIdList,
    profileRow,
    searchContents,
} from './commands.js';
import { FORMATS, objectCursorText, renderObject, renderRows } from './output.js';
import { FEEDLY_DEV_PAGE, openUrl, parseTokenInput, promptLine } from './login.js';
import { AGENT_HINT, defaultSkillRoot, installSkill, listSkillFiles, packagedSkillDir, readSkillFile, skillStatus } from './skills.js';
import { VERSION } from './version.js';

/* -------------------------------------------------------------------------- */
/* Option and command definitions                                             */
/* -------------------------------------------------------------------------- */

const GLOBAL_OPTIONS = {
    json: { type: 'boolean', help: 'Same as --format json' },
    jsonl: { type: 'boolean', help: 'Same as --format jsonl' },
    format: { type: 'string', short: 'f', value: '<format>', help: `Output format (${FORMATS.join(', ')})` },
    columns: { type: 'string', value: '<list>', help: 'Comma-separated columns to print' },
    wide: { type: 'boolean', help: 'Do not truncate long table cells' },
    config: { type: 'string', value: '<path>', help: 'Path to the Feedly config JSON' },
    timeout: { type: 'string', value: '<ms>', help: `HTTP timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    verbose: { type: 'boolean', help: 'Print stack traces for errors' },
    help: { type: 'boolean', short: 'h', help: 'Show help' },
    version: { type: 'boolean', short: 'V', help: 'Show version' },
};

const STREAM_ID_OPTION = { type: 'string', value: '<id>', help: 'Feedly stream id; defaults to global.all' };

const COMMANDS = {
    profile: {
        summary: 'Verify credentials and show account metadata',
        columns: ['id', 'email', 'name', 'locale'],
        run: async (_values, ctx) => [profileRow(await getProfile(ctx.api))],
    },

    search: {
        summary: 'Search personal feeds and Feedly publication buckets',
        positionals: [{ name: 'query', required: false, help: 'Text to search for (omit when using --layers)' }],
        options: {
            limit: { type: 'string', value: '<n>', help: 'Maximum results to return (1-100, default 40)' },
            'newer-than': { type: 'string', value: '<date>', help: 'Epoch-ms timestamp or ISO date lower bound' },
            'older-than': { type: 'string', value: '<date>', help: 'Epoch-ms timestamp or ISO date upper bound' },
            scope: { type: 'string', value: '<scope>', choices: SEARCH_SCOPES, help: 'Sources to search (default all)' },
            layers: { type: 'string', value: '<json|@file>', help: 'Advanced: structured search layers JSON or @file' },
        },
        columns: ENTRY_COLUMNS,
        run: async (values, ctx) => searchContents({
            query: values.query,
            layers: values.layers,
            limit: values.limit,
            newerThan: values['newer-than'],
            olderThan: values['older-than'],
            scope: values.scope,
            ...ctx.api,
        }),
    },

    unread: {
        summary: 'List unread entries from a stream',
        options: {
            limit: { type: 'string', value: '<n>', help: 'Maximum unread entries to return (1-1000, default 20)' },
            'stream-id': STREAM_ID_OPTION,
        },
        columns: ENTRY_COLUMNS,
        run: async (values, ctx) => getUnreadEntries({
            limit: values.limit,
            streamId: values['stream-id'] || '',
            ...ctx.api,
        }),
    },

    'stream-page': {
        summary: 'Read one stream page and keep its continuation cursor',
        object: true,
        options: {
            limit: { type: 'string', value: '<n>', help: 'Page size (1-1000, default 100)' },
            'stream-id': STREAM_ID_OPTION,
            continuation: { type: 'string', value: '<cursor>', help: 'Opaque cursor returned by the previous page' },
            all: { type: 'boolean', help: 'Include read entries (default: unread only)' },
        },
        columns: ENTRY_COLUMNS,
        run: async (values, ctx) => getStreamPage({
            limit: values.limit,
            streamId: values['stream-id'] || '',
            continuation: values.continuation || '',
            unreadOnly: !values.all,
            ...ctx.api,
        }),
    },

    streams: {
        summary: 'List global, category, and feed streams with unread counts',
        columns: ['id', 'type', 'label', 'parent', 'unread'],
        run: async (_values, ctx) => getStreams(ctx.api),
    },

    categories: {
        summary: 'List categories with unread counts',
        columns: ['id', 'label', 'unread'],
        run: async (_values, ctx) => getCategories(ctx.api),
    },

    subscriptions: {
        summary: 'List feed subscriptions with unread counts',
        columns: ['id', 'title', 'categories', 'website', 'unread'],
        run: async (_values, ctx) => getSubscriptions(ctx.api),
    },

    counts: {
        summary: 'List raw unread marker counts',
        columns: ['id', 'count', 'updated'],
        run: async (_values, ctx) => getCounts(ctx.api),
    },

    'mark-read': {
        summary: 'Mark entries as read (requires --confirm MARK_READ)',
        options: {
            ids: { type: 'string', value: '<ids|->', help: 'Comma-separated entry ids, or - to read ids from stdin' },
            confirm: { type: 'string', value: 'MARK_READ', help: 'Safety confirmation; must be MARK_READ' },
        },
        columns: ['status', 'count'],
        run: async (values, ctx) => {
            if (values.confirm !== 'MARK_READ') {
                throw new ArgumentError('--confirm MARK_READ is required before marking entries read');
            }
            if (!values.ids) {
                throw new ArgumentError('--ids is required', 'Pass entry ids or `--ids -` to read them from stdin.');
            }
            return markEntriesRead(parseIdList(values.ids), ctx.api);
        },
    },

    login: {
        summary: 'Sign in through the browser (device flow) or store an existing token',
        options: {
            'refresh-token': { type: 'string', value: '<token>', help: 'Skip the browser and store this refresh token' },
            'access-token': { type: 'string', value: '<token>', help: 'Skip the browser and store this static access token' },
            'token': { type: 'string', value: '<token|@file>', help: 'Alias for --refresh-token, or a file containing one' },
            browser: { type: 'boolean', default: true, help: 'Open the browser automatically (default: on)' },
            'no-browser': { type: 'boolean', help: 'Do not open the browser; print the URL and code only' },
            device: { type: 'boolean', help: 'Use the browser/device flow even when stdin is not a TTY' },
            paste: { type: 'boolean', help: 'Print the token page URL and read the token from stdin' },
            'print-url': { type: 'boolean', help: 'Only print the login URL, then exit' },
            'client-id': { type: 'string', value: '<id>', help: `OAuth client id (default: ${'feedlydev'})` },
            'client-secret': { type: 'string', value: '<secret>', help: 'OAuth client secret for a custom client' },
            'no-verify': { type: 'boolean', help: 'Skip the profile check after storing the token' },
        },
        columns: ['status', 'path', 'id', 'email', 'name'],
        run: async (values, ctx) => {
            const targetPath = values.config || ctx.env.FEEDLY_CONFIG_PATH || defaultConfigPath(ctx.env);
            const base = existsSync(targetPath)
                ? loadConfig({ env: ctx.env, configPath: targetPath })
                : configFromRaw(targetPath, {});

            const directToken = values.token || values['refresh-token'];
            const accessToken = values['access-token'] || ctx.env.FEEDLY_ACCESS_TOKEN || '';
            const envRefresh = ctx.env.FEEDLY_REFRESH_TOKEN || '';
            const clientPatch = {
                ...(values['client-id'] ? { client_id: values['client-id'] } : {}),
                ...(values['client-secret'] ? { client_secret: values['client-secret'] } : {}),
            };

            let config = base;

            if (directToken || accessToken) {
                const input = directToken || accessToken;
                const literal = !directToken && accessToken ? { accessToken } : parseTokenInput(readMaybeFile(input));
                const patch = {
                    ...clientPatch,
                    ...(literal.refreshToken ? { refresh_token: literal.refreshToken } : {}),
                    ...(literal.accessToken && !literal.refreshToken
                        ? { access_token: literal.accessToken, expires_at: undefined, expiresAt: undefined }
                        : {}),
                };
                if (!patch.refresh_token && !patch.access_token) {
                    throw new ArgumentError('No usable token was found in the provided input.');
                }
                config = saveConfig(config, patch);
            } else if (envRefresh) {
                config = saveConfig(config, { ...clientPatch, refresh_token: envRefresh });
            } else {
                const useBrowser = values.browser !== false && !values['no-browser'];
                const interactive = !values['print-url'] && !values.device
                    && (values.paste || !ctx.stdin.isTTY);
                if (interactive) return loginWithPaste(values, ctx, config, clientPatch);

                const deviceOptions = {
                    env: ctx.env,
                    ...(values['client-id'] ? { clientId: values['client-id'] } : {}),
                    ...(values['client-secret'] ? { clientSecret: values['client-secret'] } : {}),
                };

                // `--print-url` is for headless setups: hand back the URL and stop.
                if (values['print-url']) {
                    const device = await requestDeviceCode(deviceOptions);
                    const url = device.verificationUriComplete || device.verificationUri;
                    write(ctx.stdout, `${url}\n`);
                    if (device.userCode) write(ctx.stderr, `Confirm this code: ${device.userCode}\n`);
                    return null;
                }

                const result = await deviceLogin({
                    ...deviceOptions,
                    onPrompt: async ({ verificationUri, verificationUriComplete, userCode }) => {
                        const url = verificationUriComplete || verificationUri;
                        write(ctx.stderr, `\nTo sign in to Feedly, open:\n  ${url}\n`);
                        if (userCode) write(ctx.stderr, `\nConfirm this code: ${userCode}\n`);
                        const opened = useBrowser ? await openUrl(url, { env: ctx.env }) : false;
                        write(ctx.stderr, opened
                            ? '\nOpened your browser. Approve the request there; waiting…\n\n'
                            : '\nOpen the URL above in a browser to approve. Waiting…\n\n');
                    },
                });

                const expiresIn = Math.max(1, Number(result.tokens.expires_in || 3600)) * 1000;
                config = saveConfig(config, {
                    ...clientPatch,
                    access_token: result.tokens.access_token,
                    ...(result.tokens.refresh_token ? { refresh_token: result.tokens.refresh_token } : {}),
                    ...(result.tokens.id ? { user_id: result.tokens.id } : {}),
                    expires_at: Date.now() + expiresIn,
                });
            }

            return finalizeLogin(config, values, ctx);
        },
    },

    skill: {
        summary: 'Print or install the bundled AI agent skill',
        positionals: [
            { name: 'action', required: false, help: 'Print SKILL.md (default), or: list, read, install, status' },
            { name: 'file', required: false, help: 'File to print with `read`, e.g. references/search-api.md' },
        ],
        options: {
            force: { type: 'boolean', help: 'Overwrite an existing installation' },
            link: { type: 'boolean', help: 'Symlink instead of copying (local development)' },
            'dry-run': { type: 'boolean', help: 'Report what would happen without writing' },
            root: { type: 'string', value: '<dir>', help: 'Skills directory (default ~/.agents/skills)' },
        },
        run: async (values, ctx) => {
            const action = String(values.action || '').trim().toLowerCase();
            const home = ctx.env.HOME || undefined;
            const root = values.root || defaultSkillRoot(home ? { home } : {});
            const asJson = ctx.format === 'json' || ctx.format === 'jsonl';

            switch (action) {
                case '':
                case 'read':
                case 'show':
                case 'cat': {
                    const { path, content } = readSkillFile(values.file || 'SKILL.md');
                    return asJson ? [{ action: 'read', path, content }] : content;
                }
                case 'list': {
                    return listSkillFiles(packagedSkillDir()).map((file) => ({ file }));
                }
                case 'install': {
                    const result = installSkill({
                        root,
                        force: Boolean(values.force),
                        link: Boolean(values.link),
                        dryRun: Boolean(values['dry-run']),
                    });
                    if (result.status === 'error') {
                        throw new ConfigError(`Could not install the skill: ${result.error}`);
                    }
                    return [{ action: result.status, path: result.path, status: result.status }];
                }
                case 'status':
                case 'path': {
                    const status = skillStatus({ root });
                    return [{
                        action: 'status',
                        path: status.path,
                        status: `installed=${status.installed}${status.mode ? ` (${status.mode})` : ''}`,
                    }];
                }
                default:
                    throw new ArgumentError(
                        `Unknown skill action: ${action}`,
                        'Use one of: (none), read, list, install, status.',
                    );
            }
        },
    },

    config: {
        summary: 'Show config file candidates and credential status',
        columns: ['path', 'exists', 'credentials', 'expires_at'],
        run: async (values, ctx) => {
            const candidates = values.config
                ? [...new Set([values.config, ...configCandidates(ctx.env)])]
                : configCandidates(ctx.env);

            return candidates.map((path) => {
                const row = { path, exists: existsSync(path) ? 'yes' : 'no', credentials: '', expires_at: '' };
                if (row.exists === 'yes') {
                    try {
                        const raw = JSON.parse(readFileSync(path, 'utf-8'));
                        const config = configFromRaw(path, raw);
                        row.credentials = [
                            config.accessToken ? 'access_token' : '',
                            config.refreshToken ? 'refresh_token' : '',
                        ].filter(Boolean).join('+') || 'none';
                        row.expires_at = config.expiresAt ? new Date(config.expiresAt).toISOString() : '';
                    } catch {
                        row.credentials = 'unreadable';
                    }
                }
                return row;
            });
        },
    },
};

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                            */
/* -------------------------------------------------------------------------- */

function parseArgsOptions(options) {
    const out = {};
    for (const [name, spec] of Object.entries(options)) {
        out[name] = {
            type: spec.type,
            ...(spec.short ? { short: spec.short } : {}),
        };
    }
    return out;
}

/**
 * The command name is the first non-option token. Only global options can
 * appear before it, so this scan knows which flags consume a value.
 */
function findCommand(argv) {
    const valueTaking = new Set(['--format', '-f', '--columns', '--config', '--timeout']);
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--') return argv[i + 1] || '';
        if (token.startsWith('-')) {
            if (!token.includes('=') && valueTaking.has(token)) i += 1;
            continue;
        }
        return token;
    }
    return '';
}

function parseCommandLine(argv) {
    const command = findCommand(argv);
    if (command && command !== 'help' && command !== 'version' && !Object.hasOwn(COMMANDS, command)) {
        throw new ArgumentError(
            `Unknown command: ${command}`,
            `Available commands: ${Object.keys(COMMANDS).join(', ')}.`,
        );
    }

    const commandOptions = command === 'help' ? {} : COMMANDS[command]?.options || {};
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: { ...parseArgsOptions(GLOBAL_OPTIONS), ...parseArgsOptions(commandOptions) },
            allowPositionals: true,
            strict: true,
        });
    } catch (err) {
        throw new ArgumentError(String(err?.message || err).replace(/^Unknown option '([^']+)'$/, 'Unknown option $1'));
    }

    const positionals = parsed.positionals.slice(1);
    const values = { ...parsed.values };
    const spec = COMMANDS[command];
    for (const [index, positional] of (spec?.positionals || []).entries()) {
        values[positional.name] = positionals[index] ?? '';
    }

    const allowed = spec?.positionals?.length || 0;
    if (positionals.length > allowed) {
        throw new ArgumentError(`Unexpected argument: ${positionals[allowed]}`);
    }
    return { command, values, spec };
}

function resolveFormat(values) {
    if (values.json && values.jsonl) {
        throw new ArgumentError('--json and --jsonl are mutually exclusive');
    }
    const format = String(values.format || (values.json ? 'json' : values.jsonl ? 'jsonl' : 'table')).toLowerCase();
    if (!FORMATS.includes(format)) {
        throw new ArgumentError(`Unknown format: ${format}`, `Supported formats: ${FORMATS.join(', ')}.`);
    }
    return format;
}

function resolveTimeout(values) {
    if (values.timeout === undefined) return DEFAULT_TIMEOUT_MS;
    const timeout = Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1) {
        throw new ArgumentError('--timeout must be a positive integer in milliseconds');
    }
    return timeout;
}

function resolveColumns(values, spec) {
    const fromFlag = String(values.columns || '')
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean);
    if (fromFlag.length === 0) return spec.columns || [];

    const known = spec.columns || [];
    const unknown = fromFlag.filter((column) => !known.includes(column));
    if (known.length > 0 && unknown.length > 0) {
        throw new ArgumentError(
            `Unknown column(s): ${unknown.join(', ')}`,
            `Available columns for this command: ${known.join(', ')}.`,
        );
    }
    return fromFlag;
}

async function readStream(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
}

/** Accept CSV, JSONL, or a JSON array of entries/ids on stdin. */
export function extractIds(text) {
    const ids = [];
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                const rows = Array.isArray(parsed) ? parsed : [parsed];
                let matched = false;
                for (const row of rows) {
                    const id = typeof row === 'string' ? row : row?.id;
                    if (typeof id === 'string' && id.trim()) {
                        ids.push(id.trim());
                        matched = true;
                    }
                }
                if (matched) continue;
            } catch {
                // fall through to CSV parsing
            }
        }
        for (const part of trimmed.split(',')) {
            if (part.trim()) ids.push(part.trim());
        }
    }
    return [...new Set(ids)];
}

/* -------------------------------------------------------------------------- */
/* Help                                                                       */
/* -------------------------------------------------------------------------- */

function optionLabel(name, spec) {
    const short = spec.short ? `-${spec.short}, ` : '    ';
    return `${short}--${name}${spec.value ? ` ${spec.value}` : ''}`;
}

function optionHelp(spec) {
    return spec.choices ? `${spec.help} (one of: ${spec.choices.join(', ')})` : spec.help;
}

function renderOptionList(options) {
    const entries = Object.entries(options);
    const labels = entries.map(([name, spec]) => optionLabel(name, spec));
    const width = Math.max(0, ...labels.map((label) => label.length));
    return entries.map(([name, spec], index) => `  ${labels[index].padEnd(width)}  ${optionHelp(spec)}`);
}

export function renderHelp(command = '') {
    if (command) {
        const spec = COMMANDS[command];
        const positionals = (spec.positionals || []).map((p) => (p.required === false ? ` [${p.name}]` : ` <${p.name}>`)).join('');
        const lines = [
            `Usage: feedly ${command}${positionals} [options]`,
            '',
            spec.summary,
            '',
            'Options:',
            ...renderOptionList({ ...spec.options, ...GLOBAL_OPTIONS }),
            '',
        ];
        return `${lines.join('\n')}`;
    }

    const names = Object.keys(COMMANDS);
    const width = Math.max(...names.map((name) => name.length));
    return [
        'feedly — Feedly from the command line',
        '',
        'Usage: feedly <command> [options]',
        '',
        'Commands:',
        ...names.map((name) => `  ${name.padEnd(width)}  ${COMMANDS[name].summary}`),
        '',
        'Global options:',
        ...renderOptionList(GLOBAL_OPTIONS),
        '',
        `Run \`feedly <command> --help\` for command options. Version ${VERSION}.`,
        '',
        AGENT_HINT,
        '',
    ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function write(out, text) {
    if (!text) return;
    try {
        out.write(text);
    } catch (err) {
        if (err?.code !== 'EPIPE') throw err;
    }
}

/** `--token @file` reads the token from a file instead of argv. */
function readMaybeFile(value) {
    const text = String(value || '').trim();
    if (!text.startsWith('@')) return text;
    const path = text.slice(1).trim();
    try {
        return readFileSync(path, 'utf-8');
    } catch {
        throw new ArgumentError(`Token file cannot be read: ${path}`);
    }
}

/**
 * Fallback login for non-TTY sessions (CI, ssh, piped stdin): print Feedly's
 * developer page URL and read the pasted token instead of opening a browser.
 */
async function loginWithPaste(values, ctx, config, clientPatch) {
    write(ctx.stderr, [
        '',
        'Sign in through the browser, then copy the refresh token it shows.',
        `  1. Open ${FEEDLY_DEV_PAGE}`,
        '  2. Approve access with your Feedly account',
        '  3. Paste the refresh token (or the whole token JSON) below',
        '',
    ].join('\n'));

    const answer = await promptLine('Token: ', { stdin: ctx.stdin, stderr: ctx.stderr });
    const parsed = parseTokenInput(answer);
    if (!parsed.refreshToken && !parsed.accessToken) {
        throw new ArgumentError('No token was provided.', 'Re-run `feedly login` and paste the token from the Feedly page.');
    }

    const next = saveConfig(config, {
        ...clientPatch,
        ...(parsed.refreshToken ? { refresh_token: parsed.refreshToken } : {}),
        ...(parsed.accessToken && !parsed.refreshToken
            ? { access_token: parsed.accessToken, expires_at: undefined, expiresAt: undefined }
            : {}),
        ...(parsed.userId ? { user_id: parsed.userId } : {}),
    });
    return finalizeLogin(next, values, ctx);
}

/** Refresh/verify the stored token and report the account it belongs to. */
async function finalizeLogin(config, values, ctx) {
    if (values['no-verify'] === true) {
        return [{ status: 'stored', path: config.path, id: config.userId, email: '', name: '' }];
    }
    const stored = config.refreshToken
        ? await refreshAccessToken(config, { env: ctx.env })
        : config;
    const profile = await getProfile({ config: stored, ...ctx.api });
    return [{ status: 'logged_in', path: stored.path, ...profileRow(profile) }];
}

function reportError(error, stderr, verbose) {
    const message = error?.message || String(error);
    write(stderr, `error: ${message}\n`);
    if (error instanceof FeedlyError && error.hint) write(stderr, `hint: ${error.hint}\n`);
    // Point agents at the bundled skill for setup/auth problems.
    if (error instanceof ConfigError || error instanceof AuthError) {
        write(stderr, 'hint: run `feedly skill` for agent usage, or `feedly login` to sign in.\n');
    }
    if (verbose && error?.stack) write(stderr, `${error.stack}\n`);
    if (error instanceof FeedlyError) return error.exitCode;
    return 1;
}

export async function run(argv = [], io = {}) {
    const env = io.env || process.env;
    const stdout = io.stdout || process.stdout;
    const stderr = io.stderr || process.stderr;
    const stdin = io.stdin || process.stdin;

    let verbose = false;
    try {
        const { command, values, spec } = parseCommandLine(argv);
        verbose = Boolean(values.verbose);

        if (values.version || command === 'version') {
            write(stdout, `${VERSION}\n`);
            return 0;
        }
        if (command === 'help') {
            const target = argv[argv.indexOf('help') + 1] || '';
            if (target && !Object.hasOwn(COMMANDS, target)) {
                throw new ArgumentError(`Unknown command: ${target}`);
            }
            write(stdout, renderHelp(target));
            return 0;
        }
        if (!command || values.help) {
            write(stdout, renderHelp(command));
            return 0;
        }

        const format = resolveFormat(values);
        const timeout = resolveTimeout(values);
        const ctx = {
            env,
            stdin,
            stdout,
            stderr,
            format,
            api: { env, configPath: values.config || '', timeout },
        };

        if (command === 'mark-read' && values.ids === '-') {
            if (stdin.isTTY) {
                throw new ArgumentError('--ids - expects entry ids on stdin', 'Example: feedly unread --jsonl | feedly mark-read --ids - --confirm MARK_READ');
            }
            values.ids = extractIds(await readStream(stdin)).join(',');
        }

        const result = await spec.run(values, ctx);
        const columns = resolveColumns(values, spec);

        // Commands may return raw text (skill docs) instead of rows.
        if (typeof result === 'string') {
            write(stdout, result.endsWith('\n') ? result : `${result}\n`);
            return 0;
        }

        if (spec.object) {
            write(stdout, renderObject(result, { columns, format, wide: Boolean(values.wide) }));
            const cursor = objectCursorText(result);
            if (cursor && format !== 'json') write(stderr, `${cursor}\n`);
            return 0;
        }

        if (result === null) return 0;

        write(stdout, renderRows(result, { columns, format, wide: Boolean(values.wide) }));
        return 0;
    } catch (error) {
        return reportError(error, stderr, verbose);
    }
}

export { COMMANDS, GLOBAL_OPTIONS };
