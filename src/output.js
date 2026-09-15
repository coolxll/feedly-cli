export const FORMATS = ['table', 'json', 'jsonl', 'tsv', 'csv'];
export const DEFAULT_MAX_CELL_WIDTH = 60;

/**
 * Display width of a string, counting East Asian wide characters as two
 * columns so tables stay aligned with CJK titles.
 */
export function displayWidth(text) {
    let width = 0;
    for (const char of String(text)) {
        const code = char.codePointAt(0);
        if (code === 0x200d || (code >= 0x0300 && code <= 0x036f) || char === '\uFE0F') continue;
        width += isWideCodePoint(code) ? 2 : 1;
    }
    return width;
}

function isWideCodePoint(code) {
    return (
        (code >= 0x1100 && code <= 0x115f)
        || (code >= 0x2e80 && code <= 0x303e)
        || (code >= 0x3041 && code <= 0x33ff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0xa000 && code <= 0xa4cf)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe30 && code <= 0xfe6f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6)
        || (code >= 0x1f300 && code <= 0x1f64f)
        || (code >= 0x1f900 && code <= 0x1f9ff)
        || (code >= 0x20000 && code <= 0x3fffd)
    );
}

function truncate(text, maxWidth) {
    if (maxWidth <= 0 || displayWidth(text) <= maxWidth) return text;
    let out = '';
    let width = 0;
    for (const char of String(text)) {
        const charWidth = displayWidth(char);
        if (width + charWidth > maxWidth - 1) break;
        out += char;
        width += charWidth;
    }
    return `${out}…`;
}

export function stringifyCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function projectRow(row, columns) {
    const out = {};
    for (const column of columns) out[column] = row?.[column];
    return out;
}

function singleLine(text) {
    return String(text).replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();
}

function jsonValue(row) {
    return JSON.stringify(row);
}

function csvCell(text) {
    const value = String(text);
    if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
}

function tsvCell(text) {
    return String(text).replace(/[\t\r\n]/g, ' ');
}

const NEVER_TRUNCATED = new Set(['id', 'stream_id', 'url']);

function renderTable(rows, columns, { wide, maxWidth }) {
    const cells = rows.map((row) => columns.map((column) => {
        const text = singleLine(stringifyCell(row?.[column]));
        return wide || NEVER_TRUNCATED.has(column) ? text : truncate(text, maxWidth);
    }));
    const widths = columns.map((column, index) => Math.max(
        displayWidth(column),
        ...cells.map((row) => displayWidth(row[index])),
    ));

    const pad = (text, width) => `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
    const lines = [
        columns.map((column, index) => pad(column.toUpperCase(), widths[index])).join('  ').trimEnd(),
        widths.map((width) => '-'.repeat(width)).join('  ').trimEnd(),
        ...cells.map((row) => row.map((cell, index) => pad(cell, widths[index])).join('  ').trimEnd()),
    ];
    return `${lines.join('\n')}\n`;
}

/**
 * Render an array of row objects.
 *
 * `table`/`tsv`/`csv` project to `columns`; `json`/`jsonl` emit the full rows.
 * Empty input still prints a header for tabular formats so pipelines stay
 * self-describing.
 */
export function renderRows(rows, {
    columns = [],
    format = 'table',
    wide = false,
    maxWidth = DEFAULT_MAX_CELL_WIDTH,
} = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const selected = columns.length > 0 ? columns : Object.keys(list[0] || {});

    switch (format) {
        case 'json':
            return `${JSON.stringify(list, null, 2)}\n`;
        case 'jsonl':
            return list.length > 0 ? `${list.map(jsonValue).join('\n')}\n` : '';
        case 'tsv':
            return `${[selected.join('\t'), ...list.map((row) => selected.map((column) => tsvCell(stringifyCell(row?.[column]))).join('\t'))].join('\n')}\n`;
        case 'csv':
            return `${[selected.map(csvCell).join(','), ...list.map((row) => selected.map((column) => csvCell(stringifyCell(row?.[column]))).join(','))].join('\n')}\n`;
        case 'table':
        default:
            return renderTable(
                list.map((row) => projectRow(row, selected)),
                selected,
                { wide, maxWidth },
            );
    }
}

/**
 * Render a `{ items, continuation }` result (stream-page).
 *
 * `json` emits the whole object so the cursor is machine readable. Every other
 * format emits only the items; the cursor is returned separately via
 * `objectCursorText` so callers can print it to stderr.
 */
export function renderObject(result, options = {}) {
    if (options.format === 'json') {
        return `${JSON.stringify(result, null, 2)}\n`;
    }
    return renderRows(result?.items, options);
}

export function objectCursorText(result) {
    return result && typeof result.continuation === 'string' && result.continuation
        ? `continuation: ${result.continuation}`
        : '';
}
