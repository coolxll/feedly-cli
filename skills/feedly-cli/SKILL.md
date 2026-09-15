---
name: feedly-cli
description: Use the standalone feedly CLI to inspect a Feedly account, list unread entries and streams, search personal feeds or Feedly publication buckets, page through a stream with a continuation cursor, and mark entries read. Use when a user asks to query Feedly, search subscribed feeds/newsletters, filter Feedly results by date or source scope, configure Feedly credentials, or investigate Feedly structured/template search layers.
---

# Feedly CLI

Browser-free Feedly access from the terminal. Run live help before use because
the installed version is the source of truth.

## Preflight

```bash
feedly --version
feedly <command> --help
```

Credentials come from a config JSON (`refresh_token` or `access_token`)
discovered at `--config`, `FEEDLY_CONFIG_PATH`,
`~/.config/feedly/config.json`, `~/.feedly.json`, or `~/.opencli/feedly.json`.
Never place tokens in commands, skill files, fixtures, or source code.

If credentials are missing or expired and the user can act interactively, run
`feedly login`: it uses Feedly's OAuth device flow, prints a code plus URL, and
waits for browser approval. Use `feedly login --print-url` in headless
sessions to hand the URL to the user. `feedly config` reports what is
discovered.

## Choose a command

- Verify credentials or obtain the account id: `feedly profile --json`
- Search subscribed and curated sources: `feedly search <query> ... --json`
- Read unread entries: `feedly unread ... --json`
- Page through a stream with a cursor: `feedly stream-page ... --json`
- Discover source ids: `feedly streams --json`
- Inspect categories, subscriptions, or raw counts: matching command
- Mark entries read: `feedly mark-read --ids ... --confirm MARK_READ`

Prefer `--json` or `--jsonl` when parsing results. Table output truncates long
titles/bodies (ids stay intact) and is meant for humans.

## Article bodies are available

Entries carry both `summary` (RSS teaser) and `content` (full text) **untruncated**
in `--json`/`--jsonl`/`csv`/`tsv`. Read the body instead of the teaser, and
prefer `content` (it falls back to the summary):

```bash
feedly unread --limit 20 --jsonl | jq -r '"\(.title)\n\(.content)\n"'
feedly unread --limit 5 --columns id,title,content --wide
```

`content` is not a default table column; request it explicitly. Use
`--body-limit <n>` to cap payload size and `--no-body` to omit bodies entirely.

## Keeping this skill current

The skill you are reading ships inside the `feedly` CLI package. If the CLI is
upgraded, refresh the installed copy so it matches:

```bash
feedly skill status      # reports in-sync or drifted
feedly skill update      # re-install from the bundled skill
```

`feedly skill update` matches the installed CLI version; `feedly skill update
upstream` follows the GitHub repo recorded in `~/.agents/.skill-lock.json`
instead (which can be ahead of or behind your CLI).

## Search contents

```bash
feedly search "typescript" --limit 40 --json
feedly search "OpenAI" --scope personal --newer-than 2026-01-01 --older-than 2026-07-01 --json
feedly search "database" --scope tech --json
feedly search --layers @layers.json --scope tech --json
```

Treat `--newer-than` and `--older-than` as epoch-millisecond timestamps or ISO
dates. Keep `newer-than` earlier than `older-than`.

Use scopes as follows:

- `personal`: the account's `global.all` stream
- `business`: Feedly's Business & Strategy publication bucket
- `tech`: Feedly's Tech Blogs publication bucket
- `all`: all three sources above

For Feedly template-style search (NLP models, resolved entities), pass
structured `--layers` JSON instead of a query. See
[references/search-api.md](references/search-api.md).

Return stable entry ids so callers can feed them to `mark-read`:

```bash
feedly unread --jsonl | jq -r .id | feedly mark-read --ids - --confirm MARK_READ
```

## Failure handling

- Exit code `2`: usage error. Re-read `--help`; do not guess flags.
- Exit code `3`: config or auth error. Point the user at `feedly login` (device
  flow) or `feedly config`; do not fall back to browser scraping.
- Exit code `4`: API or network error. On `401`, the refresh-token retry
  already ran once; ask for credential renewal. On `403`, report that the
  Feedly plan or feature may not permit the request.
- On an empty `items` array, return an empty result rather than treating it as
  a failure.
- On malformed entries or payloads, keep the typed error; do not coerce broken
  data into empty rows.
- Behind a proxy, set `NODE_USE_ENV_PROXY=1` so Node's fetch honors
  `HTTP(S)_PROXY`.
