# feedly-cli

Standalone Feedly CLI — profile, unread streams, search, subscriptions, categories, and read markers.
No browser, no OpenCLI, no runtime dependencies. Extracted from the `opencli` Feedly plugin.

- Zero dependencies, ESM, Node.js >= 20 (uses the built-in `fetch`)
- Token refresh with the `feedly` / `feedlydev` public client ids, or a custom client
- Table, JSON, JSONL, TSV, and CSV output for pipelines
- Reads your existing `~/.opencli/feedly.json` automatically (easy migration)
- Typed errors with stable exit codes

## Install

```bash
# from GitHub (recommended until a registry release exists)
npm install -g github:coolxll/feedly-cli

# or clone and link
git clone https://github.com/coolxll/feedly-cli.git
cd feedly-cli
npm link

# or run without installing
npx github:coolxll/feedly-cli unread --limit 5
```

Verify:

```bash
feedly --version
feedly --help
```

## Credentials

`feedly` looks for a config JSON in this order:

1. `--config <path>` or `FEEDLY_CONFIG_PATH`
2. `$XDG_CONFIG_HOME/feedly/config.json` (default `~/.config/feedly/config.json`)
3. `~/.feedly.json`
4. `~/.opencli/feedly.json` (OpenCLI plugin compatibility)

The file must contain `refresh_token` (recommended) or `access_token`:

```json
{
  "refresh_token": "..."
}
```

Check what is discovered:

```bash
feedly config
```

Store a token and verify it in one step:

```bash
feedly login --refresh-token "<token>"
# or a static access token
feedly login --access-token "<token>"

# custom client id / secret when you have your own OAuth app
feedly login --refresh-token "<token>" --client-id my-client --client-secret my-secret
```

`login` writes the config with `0600` permissions and validates it against
Feedly before reporting success. Tokens can also come from
`FEEDLY_REFRESH_TOKEN` / `FEEDLY_ACCESS_TOKEN`.

### Migrating from OpenCLI

Nothing to do: `~/.opencli/feedly.json` is picked up automatically. To move it
to the XDG location instead:

```bash
feedly login --refresh-token "$(jq -r .refresh_token ~/.opencli/feedly.json)"
```

## Commands

| Command | Description |
| --- | --- |
| `feedly profile` | Verify credentials and show account metadata |
| `feedly unread` | List unread entries from a stream |
| `feedly stream-page` | Read exactly one stream page and keep its continuation cursor |
| `feedly search <query>` | Search personal feeds and Feedly publication buckets |
| `feedly streams` | List global, category, and feed streams with unread counts |
| `feedly categories` | List categories with unread counts |
| `feedly subscriptions` | List feed subscriptions with unread counts |
| `feedly counts` | List raw unread marker counts |
| `feedly mark-read` | Mark entries read (requires `--confirm MARK_READ`) |
| `feedly login` | Store a token in the config file and verify it |
| `feedly config` | Show config candidates and credential status |

Run `feedly <command> --help` for the full option list.

## Usage examples

```bash
# Account and unread
feedly profile --json
feedly unread --limit 20
feedly unread --limit 50 --jsonl
feedly unread --stream-id "user/<id>/category/global.all" --limit 10 --json

# Discover stream ids, categories, and sources
feedly streams
feedly categories
feedly subscriptions
feedly counts --json

# Search
feedly search "typescript" --limit 40 --json
feedly search "OpenAI" --scope personal --newer-than 2026-01-01 --older-than 2026-07-01
feedly search "database" --scope tech
feedly search "database" --scope business --json

# Paged reading (cursor round-trip)
feedly stream-page --limit 100 --json            # -> { "items": [...], "continuation": "..." }
feedly stream-page --continuation "<cursor>" --json

# Mark read (round-trip from any list command)
feedly unread --jsonl | jq -r .id | feedly mark-read --ids - --confirm MARK_READ
feedly mark-read --ids "entry-id-1,entry-id-2" --confirm MARK_READ
```

### Search scopes

| Scope | Sources |
| --- | --- |
| `all` (default) | personal `global.all` + Business & Strategy + Tech Blogs |
| `personal` | the account's `global.all` stream |
| `business` | Feedly's Business & Strategy publication bucket |
| `tech` | Feedly's Tech Blogs publication bucket |

`--newer-than` / `--older-than` accept epoch milliseconds or ISO dates;
`newer-than` must be earlier than `older-than`.

### Structured search layers

For Feedly's template-style search (NLP models and resolved entities), pass the
layers directly:

```bash
feedly search --layers '[{"parts":[{"id":"nlp/f/businessEvent/partnership"}],"type":"matches","salience":"about"}]' --scope tech
feedly search --layers @layers.json --scope personal
```

See [docs/search-api.md](docs/search-api.md) for the verified layer shapes.

## Output formats

`--format table|json|jsonl|tsv|csv` (or `-f`), plus `--json` / `--jsonl`
shorthands.

- `table` (default) aligns columns, honors CJK widths, and truncates long
  titles/summaries at 60 characters. `id`, `stream_id`, and `url` are never
  truncated so values stay copy-pastable. Use `--wide` to disable truncation.
- `json` pretty-prints the full array; `jsonl` emits one object per line.
- `--columns id,title,url` projects and reorders columns.

`stream-page` prints the full `{ items, continuation }` object for `--format
json`. With tabular formats only the items go to stdout and the cursor is
printed to stderr as `continuation: <cursor>`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Usage / argument error |
| `3` | Config or authentication error |
| `4` | Feedly API or network error |

Add `--verbose` for stack traces.

## Proxies

Node's built-in `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` unless
`NODE_USE_ENV_PROXY=1` is set (Node >= 23.6). Behind a proxy, run:

```bash
NODE_USE_ENV_PROXY=1 feedly unread --limit 5
```

The CLI prints this hint automatically when a request fails while proxy
variables are configured.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `FEEDLY_CONFIG_PATH` | Config file path |
| `FEEDLY_REFRESH_TOKEN` | Refresh token for `feedly login` |
| `FEEDLY_ACCESS_TOKEN` | Static access token for `feedly login` |
| `FEEDLY_API_BASE` | Override the general API base (default `https://cloud.feedly.com/v3`) |
| `FEEDLY_SEARCH_API_BASE` | Override the search API base (default `https://api.feedly.com/v3`) |
| `XDG_CONFIG_HOME` | Base directory for the default config location |
| `NODE_USE_ENV_PROXY` | Honor `HTTP(S)_PROXY` with the built-in fetch |

## Library usage

```js
import { getUnreadEntries, searchContents, markEntriesRead } from '@coolxll/feedly-cli';

const entries = await getUnreadEntries({ limit: 10 });
const results = await searchContents({ query: 'typescript', scope: 'tech' });
await markEntriesRead(results.map((entry) => entry.id));
```

## Development

```bash
npm test          # node:test, no dependencies
npm run test:watch
```

Tests cover config discovery, token refresh/rotation, 401 retry, pagination,
search request shape, output formats, and a full CLI run against a local
mock Feedly server.

## Notes

- This is an unofficial client for Feedly's private v3 API. Endpoints may
  change; see [docs/api-notes.md](docs/api-notes.md) for known pitfalls.
- Never commit tokens. Config files written by this CLI use `0600` permissions.

## License

MIT
