# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

None of these were published to npm. The entries below record what each
version contained, so the `package.json` history stays auditable.

## [Unreleased]

## [1.4.2] - 2026-09-15

### Fixed

- `feedly login` now records the OAuth `client_id` that minted the refresh
  token. A Feedly refresh token is **bound to its minting client** (a token from
  `feedly` is rejected with `invalid refresh_token` by `feedlydev`, and vice
  versa), so a browser login previously made every refresh send a failing
  request to `feedly` before falling back to `feedlydev`. Refreshes now hit the
  right client on the first attempt.
- `refreshAccessToken` persists the client id that succeeded, so configs
  created before this release self-heal after one refresh.

### Changed

- `refreshAccessToken` no longer sends `client_secret`. Feedly ignores it on the
  refresh grant (a wrong value still succeeds), so it was dead weight; the
  parameter only matters for the device and auth-code flows.

### Documentation

- `docs/api-notes.md` corrected: the public client is `feedlydev` and only its
  device/auth-code grants require a secret; `feedly` cannot be used for login
  because no secret for it is available. Documents the client-binding rule, and
  that `expires_in` is 604800s (7 days).

## [1.4.1] - 2026-09-15

### Fixed

- `feedly skill install` / `feedly skill update` now install the skill **bundled
  in this package** instead of fetching the GitHub repository, so the installed
  skill can no longer lag behind the CLI version you are running (for example
  when releasing before pushing). Previously the source was derived from the
  `repository` field, so `feedly skill read` (bundled) and `feedly skill
  install` (repo) could disagree.
- `feedly skill status` reports `in-sync` / `drifted` by hashing the installed
  skill against the bundled one, so an upgrade can be detected.

### Added

- `feedly skill update upstream` follows the GitHub origin recorded in
  `~/.agents/.skill-lock.json`, for users who prefer tracking the repo.
- `feedly skill status` also reports the CLI `version` and the install `source`.

## [1.4.0] - 2026-09-15

### Fixed

- `normalizeEntry` no longer picks between `summary` and `content` with a
  ternary, and no longer slices bodies to 240 characters. Feedly full text was
  being discarded for every feed that returned both (`content` up to ~13KB) and
  truncated for every other feed, in all output formats including
  `--json`/`--jsonl`.

### Added

- `content` field (full article text, falling back to the summary) and the
  matching `--columns content`.
- `--body-limit <n>` to cap body length on demand, marking the cut with
  `…[truncated N chars]`, and `--no-body` to omit bodies from every format.
- HTML bodies now keep paragraph breaks and decode numeric/named entities
  instead of collapsing to a single line.

## [1.3.0] - 2026-09-15

### Changed

- `feedly skill install` / `update` / `remove` delegate to the
  [`skills`](https://github.com/vercel-labs/skills) CLI, targeting only
  `~/.agents/skills`.

### Removed

- The bespoke copy/symlink installer and its fan-out to other agent
  directories (`--force`, `--link`, `--root` were replaced by `--from`,
  `--project`, and the `skills` CLI's own behaviour). **Breaking** for anyone
  who used those flags.

## [1.2.0] - 2026-09-15

### Added

- `feedly skill`, `feedly skill list|read|install|status` to self-serve the
  bundled agent skill; `--help` and auth errors point at it.

## [1.1.0] - 2026-09-15

### Added

- Browser sign-in via Feedly's OAuth device flow (`feedly login`), with
  `--no-browser`, `--print-url`, `--device`, `--paste`, `--no-verify`, and
  custom `--client-id`/`--client-secret`.
- `--token @file`, `--refresh-token`, `--access-token`, and
  `FEEDLY_REFRESH_TOKEN` / `FEEDLY_ACCESS_TOKEN` for non-interactive setups.

## [1.0.0] - 2026-09-15

### Added

- Standalone extraction of the OpenCLI Feedly plugin: `profile`, `unread`,
  `stream-page`, `search`, `streams`, `categories`, `subscriptions`, `counts`,
  and `mark-read`.
- Zero-dependency ESM CLI for Node >= 20, with `table`/`json`/`jsonl`/`tsv`/`csv`
  output, config discovery (including `~/.opencli/feedly.json`), refresh-token
  rotation, and typed errors with exit codes 2/3/4.

[Unreleased]: https://github.com/coolxll/feedly-cli/compare/v1.4.2...HEAD
[1.4.2]: https://github.com/coolxll/feedly-cli/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/coolxll/feedly-cli/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/coolxll/feedly-cli/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/coolxll/feedly-cli/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/coolxll/feedly-cli/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/coolxll/feedly-cli/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/coolxll/feedly-cli/releases/tag/v1.0.0
