import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, objectCursorText, renderObject, renderRows } from '../src/output.js';

const rows = [
    { id: 'entry-1', title: 'Hello', unread: 3 },
    { id: 'entry-2', title: '你好世界', unread: 12 },
];

describe('table rendering', () => {
    it('aligns columns, including wide CJK text', () => {
        const out = renderRows(rows, { columns: ['id', 'title', 'unread'] });
        const lines = out.trimEnd().split('\n');

        assert.equal(lines[0], 'ID       TITLE     UNREAD');
        assert.equal(lines[1], '-------  --------  ------');
        assert.equal(lines[2], 'entry-1  Hello     3');
        assert.match(lines[3], /^entry-2  你好世界\s+12$/);
        assert.equal(displayWidth('你好世界'), 8);
    });

    it('truncates long cells unless --wide is used', () => {
        const long = [{ id: 'x', summary: 'a'.repeat(200) }];
        const truncated = renderRows(long, { columns: ['id', 'summary'] });
        assert.match(truncated, /a{58}…/);

        const wide = renderRows(long, { columns: ['id', 'summary'], wide: true });
        assert.match(wide, /a{200}/);
        assert.doesNotMatch(wide, /…/);
    });

    it('never truncates identifier columns so ids stay copy-pastable', () => {
        const longId = `${'a'.repeat(80)}=_1a0a407aca6:21`;
        const out = renderRows([{ id: longId, summary: 'x'.repeat(200) }], { columns: ['id', 'summary'] });
        assert.match(out, new RegExp(longId));
        assert.match(out, /x{58}…/);
    });

    it('never truncates body columns in json, jsonl, csv, or tsv', () => {
        const body = 'x'.repeat(5000);
        const row = { id: 'e', summary: body, content: body };

        assert.equal(JSON.parse(renderRows([row], { format: 'json' }))[0].content.length, 5000);
        assert.equal(JSON.parse(renderRows([row], { format: 'jsonl' }).trim()).content.length, 5000);
        assert.match(renderRows([row], { columns: ['id', 'content'], format: 'csv' }), new RegExp(`x{5000}`));
        assert.match(renderRows([row], { columns: ['id', 'content'], format: 'tsv' }), new RegExp(`x{5000}`));
    });

    it('still truncates long body cells in table output', () => {
        const row = { id: 'e', content: 'y'.repeat(5000) };
        const table = renderRows([row], { columns: ['id', 'content'] });
        assert.match(table, /y{58}…/);
        assert.doesNotMatch(table, /y{5000}/);

        const wide = renderRows([row], { columns: ['id', 'content'], wide: true });
        assert.match(wide, /y{5000}/);
    });

    it('caps bodies only when --body-limit is requested', () => {
        const row = { id: 'e', summary: 'a'.repeat(1000), content: 'b'.repeat(1000) };

        // Default: no limit anywhere.
        assert.equal(JSON.parse(renderRows([row], { format: 'json' }))[0].content.length, 1000);

        const capped = JSON.parse(renderRows([row], { format: 'json', bodyLimit: 100 }))[0];
        assert.equal(capped.content.length, 100 + '…[truncated 1000 chars]'.length);
        assert.match(capped.content, /^b{100}…\[truncated 1000 chars\]$/);
        assert.match(capped.summary, /^a{100}…/);

        // A limit longer than the text leaves it untouched.
        assert.equal(JSON.parse(renderRows([row], { format: 'json', bodyLimit: 5000 }))[0].content, 'b'.repeat(1000));
        // Non-body columns are never capped.
        assert.equal(JSON.parse(renderRows([{ id: 'x'.repeat(500) }], { format: 'json', bodyLimit: 10 }))[0].id.length, 500);
    });

    it('applies body limits to stream-page json objects', () => {
        const page = { items: [{ id: 'e', content: 'z'.repeat(400) }], continuation: 'c1' };
        const out = JSON.parse(renderObject(page, { format: 'json', bodyLimit: 50 }));
        assert.match(out.items[0].content, /^z{50}…/);
        assert.equal(out.continuation, 'c1');
    });

    it('prints headers for empty results', () => {
        assert.equal(renderRows([], { columns: ['id', 'title'] }), 'ID  TITLE\n--  -----\n');
    });

    it('renders json and jsonl with full rows', () => {
        assert.equal(renderRows(rows, { format: 'json' }), `${JSON.stringify(rows, null, 2)}\n`);
        assert.equal(renderRows(rows, { format: 'jsonl' }), `${JSON.stringify(rows[0])}\n${JSON.stringify(rows[1])}\n`);
        assert.equal(renderRows([], { format: 'json' }), '[]\n');
        assert.equal(renderRows([], { format: 'jsonl' }), '');
    });

    it('escapes tsv and csv values', () => {
        const tricky = [{ id: 'a,b', title: 'say "hi"', summary: 'line1\nline2' }];
        assert.equal(
            renderRows(tricky, { columns: ['id', 'title', 'summary'], format: 'csv' }),
            'id,title,summary\n"a,b","say ""hi""","line1\nline2"\n',
        );
        assert.equal(
            renderRows(tricky, { columns: ['id', 'title', 'summary'], format: 'tsv' }),
            'id\ttitle\tsummary\na,b\tsay "hi"\tline1 line2\n',
        );
    });

    it('renders booleans, nulls, and nested objects', () => {
        const out = renderRows([{ id: 'x', flag: true, missing: null, meta: { a: 1 } }], {
            columns: ['id', 'flag', 'missing', 'meta'],
            format: 'jsonl',
        });
        assert.equal(out, '{"id":"x","flag":true,"missing":null,"meta":{"a":1}}\n');
    });
});

describe('object rendering (stream-page)', () => {
    const page = { items: rows, continuation: 'cursor-1' };

    it('emits the full object for json so the cursor is machine readable', () => {
        assert.equal(renderObject(page, { format: 'json' }), `${JSON.stringify(page, null, 2)}\n`);
    });

    it('emits only items for tabular formats and exposes the cursor separately', () => {
        const table = renderObject(page, { columns: ['id', 'title'], format: 'table' });
        assert.match(table, /entry-1/);
        assert.doesNotMatch(table, /cursor-1/);
        assert.equal(objectCursorText(page), 'continuation: cursor-1');
        assert.equal(objectCursorText({ items: [], continuation: null }), '');
    });
});
