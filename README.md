# feedly-cli

Standalone Feedly CLI — profile, unread streams, search, subscriptions, categories, and read markers.
No browser, no OpenCLI, no runtime dependencies. Extracted from the `opencli` Feedly plugin.

- Zero dependencies, ESM, Node.js >= 20 (uses the built-in `fetch`)
- Browser sign-in via Feedly's OAuth device flow — no token copy-pasting
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

Then sign in (browser, device flow) and make the CLI discoverable to agents:

```bash
feedly login
feedly skill install     # -> ~/.agents/skills/feedly-cli (via npx skills)
```

## Credentials

### Option A: sign in through the browser (recommended)

```bash
feedly login
```

This uses Feedly's OAuth **device flow**: it prints a short code, opens your
browser (or prints a URL when no browser is available), and waits until you
approve the request. The refresh token is then stored and verified
automatically — no copy-pasting tokens.

```
$ feedly login

To sign in to Feedly, open:
  https://cloud.feedly.com/v3/auth/connect/ABC-DEF-GHI

Confirm this code: ABC-DEF-GHI

Opened your browser. Approve the request there; waiting…

STATUS     PATH                             ID       EMAIL               NAME
logged_in  ~/.config/feedly/config.json     abc123   you@example.com     You
```

Useful variants:

| Command | Use case |
| --- | --- |
| `feedly login --no-browser` | Print the URL and code; approve from any device |
| `feedly login --print-url` | Print only the URL and exit (scripts/headless) |
| `feedly login --device` | Force the device flow even when stdin is not a TTY |
| `feedly login --no-verify` | Store without checking `/profile` (offline setups) |
| `feedly login --client-id X --client-secret Y` | Sign in with your own registered OAuth app |

> Feedly does not allow loopback redirect URIs (`http://127.0.0.1:...`) for the
> public clients, so a local callback server is not possible; the device flow is
> used instead. It relies on Feedly's public developer client
> (`feedlydev`), the same client the official developer-token page uses.

### Option B: paste an existing token

```bash
feedly login --paste                       # prints the page URL, reads a token from stdin
feedly login --refresh-token "<token>"
feedly login --access-token "<token>"
feedly login --token @/path/to/token.txt    # read from a file
```

`--paste` (and any non-TTY stdin) accepts a bare refresh/access token, a copied
`Authorization: Bearer …` header, or the whole JSON blob from Feedly's
[developer token page](https://feedly.com/v3/auth/dev) — `user_id` is preserved
when present. Tokens can also come from `FEEDLY_REFRESH_TOKEN` /
`FEEDLY_ACCESS_TOKEN` for CI.

### Config discovery

The config JSON is looked up in this order:

1. `--config <path>` or `FEEDLY_CONFIG_PATH`
2. `$XDG_CONFIG_HOME/feedly/config.json` (default `~/.config/feedly/config.json`)
3. `~/.feedly.json`
4. `~/.opencli/feedly.json` (OpenCLI plugin compatibility)

```json
{
  "refresh_token": "..."
}
```

Check what is discovered:

```bash
feedly config
```

`feedly login` writes the config with `0600` permissions and, unless
`--no-verify` is given, validates the credentials against Feedly before
reporting success.

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
| `feedly skill` | Print the bundled AI skill, or install it via `npx skills` |
| `feedly login` | Sign in via browser (device flow) or store an existing token |
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

## For AI agents

A CLI that an agent cannot discover is a CLI that does not exist. `feedly`
ships its own usage skill and can hand it to an agent on demand, so nothing has
to be installed separately for the agent to learn the tool.

| Command | What it does |
| --- | --- |
| `feedly skill` | Print `SKILL.md` — the full agent instructions |
| `feedly skill list` | List bundled skill files |
| `feedly skill read <file>` | Print one file, e.g. `references/search-api.md` |
| `feedly skill install` | Install via `npx skills` into `~/.agents/skills` |
| `feedly skill update` | Update the installed skill from the repository |
| `feedly skill remove` | Uninstall it |
| `feedly skill status` | Show install location, source, and last update |

So an agent can bootstrap itself with a single command:

```bash
feedly skill                 # read the instructions
feedly skill install         # make them discoverable in future sessions
```

`--help` also advertises this, and auth/config failures print
`hint: run \`feedly skill\` for agent usage`.

### Installation is delegated to `npx skills`

Installing is **not** reimplemented here. `feedly skill install` shells out to
[`skills`](https://github.com/vercel-labs/skills) (Vercel Labs, "the open agent
skills ecosystem"), which already knows every harness's skill directory, keeps
a lock file, and supports updates:

```bash
# what `feedly skill install` runs
npx -y skills@latest add coolxll/feedly-cli -s feedly-cli -a universal -g -y --json
```

`-a universal` targets the [Agent Skills](https://agentskills.io/specification)
standard directory **`~/.agents/skills`** only — no scattering symlinks across
other harness folders. `pi` reads that directory natively. `--project` drops
`-g` for project-local installs.

You can also skip this CLI entirely and install the skill the standard way:

```bash
npx skills add coolxll/feedly-cli -s feedly-cli -a universal -g
npx skills update feedly-cli -g      # uses ~/.agents/.skill-lock.json
```

Because the `skills` lock file records the source and content hash, updates
work without re-specifying the repository.

Flags: `--from <owner/repo|url|path>` (default: this package's repository),
`--agent <agent>` (default `universal`), `--project`, `--dry-run` (prints the
underlying command without running it).

The CLI has **no dependency on any agent harness**: reading the skill is a file
read, and installing is a subprocess call to a tool you already have via `npx`.

### Package layout

```
skills/feedly-cli/
├── SKILL.md                    # entry point (name + description frontmatter)
├── references/search-api.md    # deep-dive, loaded on demand
└── agents/openai.yaml          # display metadata for agent UIs
```

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
