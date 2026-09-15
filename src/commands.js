import { readFileSync } from 'node:fs';
import { ArgumentError, ApiError } from './errors.js';
import {
    SEARCH_CLIENT_TYPE,
    SEARCH_CLIENT_VERSION,
    SEARCH_SOURCES,
    apiRequest,
    globalAllStreamId,
    resolveApiBases,
} from './client.js';

export const ENTRY_COLUMNS = ['id', 'title', 'author', 'published', 'origin_title', 'stream_id', 'url', 'summary', 'content'];
/** Default table/JSON projection. `content` is available but intentionally opt-in. */
export const DEFAULT_ENTRY_COLUMNS = ['id', 'title', 'author', 'published', 'origin_title', 'stream_id', 'url', 'summary'];
export const SEARCH_SCOPES = ['all', 'personal', 'business', 'tech'];

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizePositiveInt(value, fallback, label, max) {
    const raw = value === undefined || value === null || value === '' ? fallback : value;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
        throw new ArgumentError(`${label} must be an integer between 1 and ${max}`);
    }
    return n;
}

export function parseTimestamp(value, label) {
    if (value === undefined || value === null || String(value).trim() === '') return undefined;
    const raw = String(value).trim();
    const numeric = Number(raw);
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;

    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ArgumentError(`${label} must be a positive epoch-millisecond timestamp or ISO date`);
    }
    return parsed;
}

export function parseIdList(value) {
    const ids = String(value || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    if (ids.length === 0) {
        throw new ArgumentError('--ids must contain at least one Feedly entry id');
    }
    return ids;
}

export function parseLayers(raw, { readFile = readFileSync } = {}) {
    const text = String(raw ?? '').trim();
    if (!text) throw new ArgumentError('--layers must not be empty');

    let json = text;
    if (text.startsWith('@')) {
        const path = text.slice(1).trim();
        try {
            json = readFile(path, 'utf-8');
        } catch {
            throw new ArgumentError(`--layers file cannot be read: ${path}`);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new ArgumentError('--layers must be a JSON array or @/path/to/layers.json');
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((layer) => isRecord(layer))) {
        throw new ArgumentError('--layers must be a non-empty JSON array of layer objects');
    }
    return parsed;
}

function requireArrayPayload(data, field, label) {
    const value = field ? data?.[field] : data;
    if (!Array.isArray(value)) {
        throw new ApiError(`Feedly ${label} returned a malformed payload; expected ${field || 'an array'}.`);
    }
    return value;
}

function countMapFromPayload(data) {
    const rows = requireArrayPayload(data, 'unreadcounts', 'counts');
    return new Map(rows
        .filter((row) => isRecord(row) && typeof row.id === 'string')
        .map((row) => [row.id, Number(row.count || 0)]));
}

function isoDate(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n).toISOString();
}

/**
 * Minimal HTML entity decoding so bodies are readable as text.
 */
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×', deg: '°',
};

function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
            try {
                return String.fromCodePoint(code);
            } catch {
                return match;
            }
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? match : named;
    });
}

/**
 * Block-level tags that should become paragraph breaks. Collapsing every tag to
 * a space would flatten a 13KB article body into a single unreadable line.
 */
const BLOCK_TAGS = /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;
const DROPPED_TAGS = /<(?:script|style|img|source|video|audio|iframe|object|embed|svg|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>|<(?:img|source|video|audio|iframe|object|embed|br|hr)\b[^>]*>/gi;

export function stripHtml(value) {
    const raw = String(value || '');
    if (!raw) return '';

    const text = raw
        .replace(DROPPED_TAGS, (match) => (match.startsWith('</') || /^<(?:img|source|video|audio|iframe|object|embed|br|hr)\b/i.test(match) ? '\n' : ' '))
        .replace(BLOCK_TAGS, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[\t\r\f\v\u00a0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/ {2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return decodeEntities(text);
}

/** Extract a Feedly `{ content, direction }` text block, if present. */
function textBlock(value) {
    if (!isRecord(value)) return '';
    return typeof value.content === 'string' ? value.content : '';
}

function firstAlternateUrl(entry) {
    const alternate = Array.isArray(entry?.alternate) ? entry.alternate : [];
    const found = alternate.find((item) => isRecord(item) && typeof item.href === 'string' && item.href.trim());
    return found?.href || '';
}

/**
 * Normalize a Feedly entry.
 *
 * `summary` and `content` are extracted independently and returned **whole**;
 * Feedly often has a short RSS `summary` next to a full-text `content`, and
 * picking one with a ternary silently threw the article body away. Truncation
 * is a presentation concern and happens in the output layer (or on demand via
 * `--body-limit`).
 */
export function normalizeEntry(entry) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
        throw new ApiError('Feedly returned an entry without a stable id.');
    }
    const origin = isRecord(entry.origin) ? entry.origin : {};
    const summaryText = textBlock(entry.summary);
    const contentText = textBlock(entry.content);

    return {
        id: entry.id,
        title: String(entry.title || '').trim(),
        author: String(entry.author || '').trim(),
        published: isoDate(entry.published || entry.updated || entry.crawled),
        origin_title: String(origin.title || '').trim(),
        stream_id: String(origin.streamId || '').trim(),
        url: firstAlternateUrl(entry) || String(origin.htmlUrl || '').trim(),
        // RSS teaser. Keeps the legacy fallback (summary, else body) so existing
        // `.summary` consumers never get less text than before.
        summary: stripHtml(summaryText || contentText),
        // Full text, falling back to the summary when Feedly sends no body.
        content: stripHtml(contentText || summaryText),
    };
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export async function getProfile(opts = {}) {
    const data = await apiRequest('/profile', opts);
    if (!isRecord(data) || typeof data.id !== 'string') {
        throw new ApiError('Feedly profile returned a malformed payload; expected id.');
    }
    return data;
}

export function profileRow(profile) {
    return {
        id: profile.id || '',
        email: profile.email || '',
        name: [profile.givenName, profile.familyName].filter(Boolean).join(' ') || profile.fullName || '',
        locale: profile.locale || '',
    };
}

function searchSourceItems(scope, userId) {
    const normalizedScope = String(scope || 'all').trim().toLowerCase();
    if (!SEARCH_SCOPES.includes(normalizedScope)) {
        throw new ArgumentError(`--scope must be one of: ${SEARCH_SCOPES.join(', ')}`);
    }

    const items = [];
    if (normalizedScope === 'all' || normalizedScope === 'personal') {
        items.push({
            label: 'All Personal Feeds',
            type: 'stream',
            id: globalAllStreamId(userId),
        });
    }
    if (normalizedScope === 'all' || normalizedScope === 'business') {
        items.push(SEARCH_SOURCES.business);
    }
    if (normalizedScope === 'all' || normalizedScope === 'tech') {
        items.push(SEARCH_SOURCES.tech);
    }
    return items;
}

export async function searchContents({
    query,
    layers,
    limit = 40,
    newerThan,
    olderThan,
    scope = 'all',
    ...opts
} = {}) {
    const text = String(query || '').trim();
    if (text && layers) {
        throw new ArgumentError('provide either a search <query> or --layers, not both');
    }
    if (!text && !layers) {
        throw new ArgumentError('search requires a <query> argument or --layers <json>');
    }

    const count = normalizePositiveInt(limit, 40, '--limit', 100);
    const newer = parseTimestamp(newerThan, '--newer-than');
    const older = parseTimestamp(olderThan, '--older-than');
    if (newer !== undefined && older !== undefined && newer >= older) {
        throw new ArgumentError('--newer-than must be earlier than --older-than');
    }

    const normalizedScope = String(scope || 'all').trim().toLowerCase();
    let userId = '';
    if (normalizedScope === 'all' || normalizedScope === 'personal') {
        const profile = await getProfile(opts);
        userId = profile.id;
    }

    const searchLayers = layers || [{
        parts: [{ text }],
        type: 'matches',
        salience: 'about',
    }];

    const { searchApiBase } = resolveApiBases(opts.env);
    const data = await apiRequest(`${searchApiBase}/search/contents`, {
        ...opts,
        method: 'POST',
        query: {
            count,
            newerThan: newer,
            olderThan: older,
            ct: SEARCH_CLIENT_TYPE,
            cv: SEARCH_CLIENT_VERSION,
        },
        body: {
            layers: searchLayers,
            source: {
                items: searchSourceItems(normalizedScope, userId),
            },
        },
    });
    return requireArrayPayload(data, 'items', 'search').map(normalizeEntry);
}

export async function getUnreadEntries({ limit = 20, streamId = '', unreadOnly = true, ...opts } = {}) {
    const count = normalizePositiveInt(limit, 20, '--limit', 1000);
    let resolvedStreamId = streamId;
    if (!resolvedStreamId) {
        const profile = await getProfile(opts);
        resolvedStreamId = globalAllStreamId(profile.id);
    }

    const rows = [];
    let continuation = '';
    while (rows.length < count) {
        const pageSize = Math.min(100, count - rows.length);
        const data = await apiRequest('/streams/contents', {
            ...opts,
            query: {
                streamId: resolvedStreamId,
                unreadOnly: unreadOnly ? 'true' : undefined,
                ranked: 'newest',
                count: pageSize,
                continuation,
            },
        });
        const items = requireArrayPayload(data, 'items', 'unread');
        rows.push(...items.map(normalizeEntry));
        continuation = typeof data?.continuation === 'string' ? data.continuation : '';
        if (!continuation || items.length === 0) break;
    }
    return rows.slice(0, count);
}

/**
 * Read exactly one stream page. The returned `continuation` cursor can be fed
 * back into `--continuation` to fetch the next page.
 */
export async function getStreamPage({ limit = 100, streamId = '', continuation = '', unreadOnly = true, ...opts } = {}) {
    const count = normalizePositiveInt(limit, 100, '--limit', 1000);
    let resolvedStreamId = streamId;
    if (!resolvedStreamId) {
        const profile = await getProfile(opts);
        resolvedStreamId = globalAllStreamId(profile.id);
    }
    const data = await apiRequest('/streams/contents', {
        ...opts,
        query: {
            streamId: resolvedStreamId,
            unreadOnly: unreadOnly ? 'true' : undefined,
            ranked: 'newest',
            count,
            continuation,
        },
    });
    return {
        items: requireArrayPayload(data, 'items', 'stream-page').map(normalizeEntry),
        continuation: typeof data?.continuation === 'string' ? data.continuation : null,
    };
}

export async function getCategories(opts = {}) {
    const [categories, counts] = await Promise.all([
        apiRequest('/categories', opts),
        apiRequest('/markers/counts', opts),
    ]);
    const unreadById = countMapFromPayload(counts);
    return requireArrayPayload(categories, null, 'categories').map((category) => ({
        id: String(category.id || ''),
        label: String(category.label || ''),
        unread: unreadById.get(category.id) || 0,
    }));
}

export async function getSubscriptions(opts = {}) {
    const [subscriptions, counts] = await Promise.all([
        apiRequest('/subscriptions', opts),
        apiRequest('/markers/counts', opts),
    ]);
    const unreadById = countMapFromPayload(counts);
    return requireArrayPayload(subscriptions, null, 'subscriptions').map((sub) => ({
        id: String(sub.id || ''),
        title: String(sub.title || ''),
        categories: Array.isArray(sub.categories) ? sub.categories.map((c) => c.label || c.id).filter(Boolean).join(', ') : '',
        website: String(sub.website || ''),
        unread: unreadById.get(sub.id) || 0,
    }));
}

export async function getCounts(opts = {}) {
    const data = await apiRequest('/markers/counts', opts);
    return requireArrayPayload(data, 'unreadcounts', 'counts').map((row) => ({
        id: String(row.id || ''),
        count: Number(row.count || 0),
        updated: isoDate(row.updated),
    }));
}

export async function getStreams(opts = {}) {
    const [profile, categories, subscriptions, counts] = await Promise.all([
        getProfile(opts),
        apiRequest('/categories', opts),
        apiRequest('/subscriptions', opts),
        apiRequest('/markers/counts', opts),
    ]);
    const unreadById = countMapFromPayload(counts);
    const rows = [
        {
            id: globalAllStreamId(profile.id),
            type: 'global',
            label: 'All',
            parent: '',
            unread: unreadById.get(globalAllStreamId(profile.id)) || 0,
        },
        {
            id: `user/${profile.id}/tag/global.saved`,
            type: 'global',
            label: 'Saved',
            parent: '',
            unread: unreadById.get(`user/${profile.id}/tag/global.saved`) || 0,
        },
    ];

    for (const category of requireArrayPayload(categories, null, 'categories')) {
        rows.push({
            id: String(category.id || ''),
            type: 'category',
            label: String(category.label || ''),
            parent: '',
            unread: unreadById.get(category.id) || 0,
        });
    }
    for (const sub of requireArrayPayload(subscriptions, null, 'subscriptions')) {
        rows.push({
            id: String(sub.id || ''),
            type: 'feed',
            label: String(sub.title || ''),
            parent: Array.isArray(sub.categories) ? sub.categories.map((c) => c.label || c.id).filter(Boolean).join(', ') : '',
            unread: unreadById.get(sub.id) || 0,
        });
    }
    return rows;
}

export async function markEntriesRead(ids, opts = {}) {
    const entryIds = Array.isArray(ids) ? ids : parseIdList(ids);
    await apiRequest('/markers', {
        ...opts,
        method: 'POST',
        body: {
            action: 'markAsRead',
            type: 'entries',
            entryIds,
        },
    });
    return [{ status: 'marked_read', count: entryIds.length }];
}
