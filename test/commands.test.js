import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ArgumentError } from '../src/errors.js';
import { configFromRaw } from '../src/client.js';
import {
    getStreamPage,
    getStreams,
    getUnreadEntries,
    markEntriesRead,
    normalizeEntry,
    parseIdList,
    parseLayers,
    parseTimestamp,
    profileRow,
    searchContents,
} from '../src/commands.js';

function jsonResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(data),
    };
}

const config = configFromRaw('memory', { access_token: 'access' });

describe('argument parsing helpers', () => {
    it('parses id lists and rejects empty input', () => {
        assert.deepEqual(parseIdList(' entry-1 , entry-2 ,, '), ['entry-1', 'entry-2']);
        assert.throws(() => parseIdList(' , '), ArgumentError);
    });

    it('parses epoch and ISO timestamps', () => {
        assert.equal(parseTimestamp('1784188908875', '--newer-than'), 1784188908875);
        assert.equal(parseTimestamp('2026-01-01T00:00:00Z', '--newer-than'), Date.parse('2026-01-01T00:00:00Z'));
        assert.equal(parseTimestamp('', '--newer-than'), undefined);
        assert.throws(() => parseTimestamp('yesterday', '--newer-than'), ArgumentError);
    });

    it('parses inline and file-backed search layers', () => {
        const dir = mkdtempSync(join(tmpdir(), 'feedly-cli-layers-'));
        try {
            const file = join(dir, 'layers.json');
            writeFileSync(file, JSON.stringify([{ parts: [{ id: 'nlp/f/entity/gz:org:openai' }], type: 'matches' }]));

            assert.deepEqual(parseLayers('[{"parts":[{"text":"x"}],"type":"matches"}]'), [{ parts: [{ text: 'x' }], type: 'matches' }]);
            assert.deepEqual(parseLayers(`@${file}`), [{ parts: [{ id: 'nlp/f/entity/gz:org:openai' }], type: 'matches' }]);
            assert.throws(() => parseLayers('{}'), ArgumentError);
            assert.throws(() => parseLayers('@/nonexistent/layers.json'), ArgumentError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('entry normalization', () => {
    it('normalizes stable fields and strips HTML from summaries', () => {
        const entry = normalizeEntry({
            id: 'entry-1',
            title: 'Test result',
            author: 'Author',
            published: 1_700_000_000_000,
            origin: { title: 'Example Feed', streamId: 'feed/example', htmlUrl: 'https://example.com' },
            summary: { content: '<p>Hello <b>world</b></p>' },
        });

        assert.deepEqual(entry, {
            id: 'entry-1',
            title: 'Test result',
            author: 'Author',
            published: '2023-11-14T22:13:20.000Z',
            origin_title: 'Example Feed',
            stream_id: 'feed/example',
            url: 'https://example.com',
            summary: 'Hello world',
        });
    });

    it('prefers alternate links and rejects entries without ids', () => {
        const entry = normalizeEntry({
            id: 'entry-2',
            title: 'Two',
            alternate: [{ href: 'https://example.com/two' }],
            origin: { htmlUrl: 'https://fallback.example.com' },
        });
        assert.equal(entry.url, 'https://example.com/two');
        assert.throws(() => normalizeEntry({ title: 'missing id' }), ApiError);
    });

    it('formats profile rows', () => {
        assert.deepEqual(profileRow({ id: 'u1', email: 'a@b.c', givenName: 'Ada', familyName: 'Lovelace', locale: 'en' }), {
            id: 'u1',
            email: 'a@b.c',
            name: 'Ada Lovelace',
            locale: 'en',
        });
    });
});

describe('unread pagination and stream joining', () => {
    it('paginates unread stream contents up to the requested limit', async () => {
        const continuations = [];
        const fetchImpl = async (url) => {
            const parsed = new URL(url);
            continuations.push(parsed.searchParams.get('continuation') || '');
            assert.equal(parsed.searchParams.get('unreadOnly'), 'true');
            assert.equal(parsed.searchParams.get('ranked'), 'newest');
            if (!parsed.searchParams.get('continuation')) {
                return jsonResponse(200, {
                    continuation: 'next-page',
                    items: [
                        { id: 'entry-1', title: 'One', origin: { title: 'Feed A', streamId: 'feed/a' }, published: 1000 },
                    ],
                });
            }
            return jsonResponse(200, {
                items: [
                    { id: 'entry-2', title: 'Two', origin: { title: 'Feed B', streamId: 'feed/b' }, alternate: [{ href: 'https://example.com/two' }] },
                ],
            });
        };

        const rows = await getUnreadEntries({ config, fetchImpl, streamId: 'feed/a', limit: 2 });

        assert.deepEqual(rows.map((row) => row.id), ['entry-1', 'entry-2']);
        assert.equal(rows[1].url, 'https://example.com/two');
        assert.deepEqual(continuations, ['', 'next-page']);
    });

    it('resolves global.all through the profile when no stream id is given', async () => {
        const paths = [];
        const fetchImpl = async (url) => {
            const parsed = new URL(url);
            paths.push(parsed.pathname);
            if (parsed.pathname.endsWith('/profile')) return jsonResponse(200, { id: 'user-1' });
            assert.equal(parsed.searchParams.get('streamId'), 'user/user-1/category/global.all');
            return jsonResponse(200, { items: [] });
        };

        assert.deepEqual(await getUnreadEntries({ config, fetchImpl }), []);
        assert.deepEqual(paths, ['/v3/profile', '/v3/streams/contents']);
    });

    it('does not treat malformed unread item payloads as empty results', async () => {
        const fetchImpl = async () => jsonResponse(200, { items: [{ title: 'missing id' }] });
        await assert.rejects(() => getUnreadEntries({ config, fetchImpl, streamId: 'feed/a', limit: 1 }), ApiError);
    });

    it('returns one stream page with its continuation cursor', async () => {
        const fetchImpl = async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.searchParams.get('count'), '50');
            assert.equal(parsed.searchParams.get('continuation'), 'cursor-1');
            assert.equal(parsed.searchParams.get('unreadOnly'), null);
            return jsonResponse(200, {
                continuation: 'cursor-2',
                items: [{ id: 'entry-9', title: 'Nine' }],
            });
        };

        const page = await getStreamPage({
            config,
            fetchImpl,
            streamId: 'feed/a',
            limit: 50,
            continuation: 'cursor-1',
            unreadOnly: false,
        });

        assert.equal(page.continuation, 'cursor-2');
        assert.deepEqual(page.items.map((item) => item.id), ['entry-9']);
    });

    it('joins global, category, and feed streams with unread counts', async () => {
        const fetchImpl = async (url) => {
            const path = new URL(url).pathname.replace('/v3', '');
            if (path === '/profile') return jsonResponse(200, { id: 'user-1' });
            if (path === '/categories') return jsonResponse(200, [{ id: 'user/user-1/category/Tech', label: 'Tech' }]);
            if (path === '/subscriptions') {
                return jsonResponse(200, [{
                    id: 'feed/https://example.com/rss',
                    title: 'Example',
                    categories: [{ id: 'user/user-1/category/Tech', label: 'Tech' }],
                }]);
            }
            if (path === '/markers/counts') {
                return jsonResponse(200, {
                    unreadcounts: [
                        { id: 'user/user-1/category/global.all', count: 8 },
                        { id: 'user/user-1/category/Tech', count: 3 },
                        { id: 'feed/https://example.com/rss', count: 2 },
                    ],
                });
            }
            throw new Error(`unexpected URL ${url}`);
        };

        const rows = await getStreams({ config, fetchImpl });

        assert.deepEqual(rows, [
            { id: 'user/user-1/category/global.all', type: 'global', label: 'All', parent: '', unread: 8 },
            { id: 'user/user-1/tag/global.saved', type: 'global', label: 'Saved', parent: '', unread: 0 },
            { id: 'user/user-1/category/Tech', type: 'category', label: 'Tech', parent: '', unread: 3 },
            { id: 'feed/https://example.com/rss', type: 'feed', label: 'Example', parent: 'Tech', unread: 2 },
        ]);
    });
});

describe('content search', () => {
    it('posts the verified Feedly search shape and normalizes results', async () => {
        let searchCalls = 0;
        const fetchImpl = async (url, init) => {
            const parsed = new URL(url);
            if (parsed.pathname === '/v3/profile') return jsonResponse(200, { id: 'user-1' });

            searchCalls += 1;
            assert.equal(parsed.origin, 'https://api.feedly.com');
            assert.equal(parsed.pathname, '/v3/search/contents');
            assert.equal(parsed.searchParams.get('count'), '25');
            assert.equal(parsed.searchParams.get('newerThan'), String(Date.parse('2026-01-01T00:00:00Z')));
            assert.equal(parsed.searchParams.get('olderThan'), '1784188908875');
            assert.equal(parsed.searchParams.get('ct'), 'feedly.desktop');
            assert.equal(parsed.searchParams.get('cv'), '31.0.3087');
            assert.equal(init.method, 'POST');
            assert.equal(init.headers.authorization, 'Bearer access');
            assert.deepEqual(JSON.parse(init.body), {
                layers: [{ parts: [{ text: 'test' }], type: 'matches', salience: 'about' }],
                source: {
                    items: [
                        { label: 'All Personal Feeds', type: 'stream', id: 'user/user-1/category/global.all' },
                        { label: 'Business & Strategy', type: 'publicationBucket', id: 'byf:business-and-strategy', tier: 'tier1' },
                        { label: 'Tech Blogs', type: 'publicationBucket', id: 'byf:tech', tier: 'tier1' },
                    ],
                },
            });
            return jsonResponse(200, {
                items: [{
                    id: 'entry-1',
                    title: 'Test result',
                    author: 'Author',
                    published: 1_700_000_000_000,
                    origin: { title: 'Example Feed', streamId: 'feed/example', htmlUrl: 'https://example.com' },
                    summary: { content: '<p>Hello <b>world</b></p>' },
                }],
            });
        };

        const rows = await searchContents({
            config,
            fetchImpl,
            query: ' test ',
            limit: 25,
            newerThan: '2026-01-01T00:00:00Z',
            olderThan: '1784188908875',
        });

        assert.equal(searchCalls, 1);
        assert.deepEqual(rows, [{
            id: 'entry-1',
            title: 'Test result',
            author: 'Author',
            published: '2023-11-14T22:13:20.000Z',
            origin_title: 'Example Feed',
            stream_id: 'feed/example',
            url: 'https://example.com',
            summary: 'Hello world',
        }]);
    });

    it('search a publication bucket without loading the profile', async () => {
        const fetchImpl = async (_url, init) => {
            assert.deepEqual(JSON.parse(init.body).source.items, [
                { label: 'Tech Blogs', type: 'publicationBucket', id: 'byf:tech', tier: 'tier1' },
            ]);
            return jsonResponse(200, { items: [] });
        };

        assert.deepEqual(await searchContents({ config, fetchImpl, query: 'node', scope: 'tech' }), []);
    });

    it('supports structured layers instead of a text query', async () => {
        const fetchImpl = async (_url, init) => {
            const body = JSON.parse(init.body);
            assert.deepEqual(body.layers, [
                { parts: [{ id: 'nlp/f/businessEvent/partnership' }], type: 'matches', salience: 'about' },
                { parts: [{ id: 'nlp/f/entity/gz:org:openai' }], type: 'matches', salience: 'mention', searchHint: 'org' },
            ]);
            assert.deepEqual(body.source.items, [
                { label: 'Tech Blogs', type: 'publicationBucket', id: 'byf:tech', tier: 'tier1' },
            ]);
            return jsonResponse(200, { items: [] });
        };

        const layers = [
            { parts: [{ id: 'nlp/f/businessEvent/partnership' }], type: 'matches', salience: 'about' },
            { parts: [{ id: 'nlp/f/entity/gz:org:openai' }], type: 'matches', salience: 'mention', searchHint: 'org' },
        ];

        assert.deepEqual(await searchContents({ config, fetchImpl, layers, scope: 'tech' }), []);
    });

    it('rejects empty queries, ambiguous input, and reversed date ranges', async () => {
        await assert.rejects(() => searchContents({ config, query: ' ' }), ArgumentError);
        await assert.rejects(() => searchContents({ config, query: 'x', layers: [{ parts: [] }] }), ArgumentError);
        await assert.rejects(() => searchContents({ config, query: 'x', scope: 'nope' }), ArgumentError);
        await assert.rejects(() => searchContents({
            config,
            query: 'test',
            newerThan: '2026-07-01',
            olderThan: '2026-01-01',
        }), ArgumentError);
    });
});

describe('mark-read', () => {
    it('posts the Feedly marker payload for confirmed entries', async () => {
        const fetchImpl = async (_url, init) => {
            assert.equal(init.method, 'POST');
            assert.deepEqual(JSON.parse(init.body), {
                action: 'markAsRead',
                type: 'entries',
                entryIds: ['entry-1', 'entry-2'],
            });
            return { ok: true, status: 204, text: async () => '' };
        };

        assert.deepEqual(await markEntriesRead(['entry-1', 'entry-2'], { config, fetchImpl }), [
            { status: 'marked_read', count: 2 },
        ]);
    });
});
