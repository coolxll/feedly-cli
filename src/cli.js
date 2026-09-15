import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ArgumentError, FeedlyError } from './errors.js';
import {
    DEFAULT_TIMEOUT_MS,
    configCandidates,
    configFromRaw,
    defaultConfigPath,
    loadConfig,
    refreshAccessToken,
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
        summary: 'Store a Feedly token in the config file and verify it',
        options: {
            'refresh-token': { type: 'string', value: '<token>', help: 'Feedly refresh token (recommended)' },
            'access-token': { type: 'string', value: '<token>', help: 'Static Feedly access token' },
            'client-id': { type: 'string', value: '<id>', help: 'OAuth client id (default: try feedly, then feedlydev)' },
            'client-secret': { type: 'string', value: '<secret>', help: 'OAuth client secret, when required' },
        },
        columns: ['status', 'path', 'id', 'email', 'name'],
        run: async (values, ctx) => {
            const refreshToken = values['refresh-token'] || ctx.env.FEEDLY_REFRESH_TOKEN || '';
            const accessToken = values['access-token'] || ctx.env.FEEDLY_ACCESS_TOKEN || '';
            if (!refreshToken && !accessToken) {
                throw new ArgumentError(
                    'login needs --refresh-token or --access-token',
                    'You can also export FEEDLY_REFRESH_TOKEN or FEEDLY_ACCESS_TOKEN.',
                );
            }

            const targetPath = values.config || ctx.env.FEEDLY_CONFIG_PATH || defaultConfigPath(ctx.env);
            let config = existsSync(targetPath)
                ? loadConfig({ env: ctx.env, configPath: targetPath })
                : configFromRaw(targetPath, {});

            if (refreshToken) {
                config = saveConfig(config, {
                    refresh_token: refreshToken,
                    ...(values['client-id'] ? { client_id: values['client-id'] } : {}),
                    ...(values['client-secret'] ? { client_secret: values['client-secret'] } : {}),
                });
                config = await refreshAccessToken(config, { env: ctx.env });
            } else {
                config = saveConfig(config, {
                    access_token: accessToken,
                    expires_at: undefined,
                    expiresAt: undefined,
                });
            }

            const profile = await getProfile({ config, ...ctx.api });
            return [{
                status: 'logged_in',
                path: config.path,
                ...profileRow(profile),
            }];
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
    if (command === 'search') values.query = positionals[0] || '';

    const spec = COMMANDS[command];
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

function reportError(error, stderr, verbose) {
    const message = error?.message || String(error);
    write(stderr, `error: ${message}\n`);
    if (error instanceof FeedlyError && error.hint) write(stderr, `hint: ${error.hint}\n`);
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

        if (spec.object) {
            write(stdout, renderObject(result, { columns, format, wide: Boolean(values.wide) }));
            const cursor = objectCursorText(result);
            if (cursor && format !== 'json') write(stderr, `${cursor}\n`);
            return 0;
        }

        write(stdout, renderRows(result, { columns, format, wide: Boolean(values.wide) }));
        return 0;
    } catch (error) {
        return reportError(error, stderr, verbose);
    }
}

export { COMMANDS, GLOBAL_OPTIONS };
