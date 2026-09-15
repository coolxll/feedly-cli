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
