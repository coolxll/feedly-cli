# Feedly API notes

Behaviour observed while building this CLI. Treat everything here as
version-sensitive private API details, not a stable public contract.

## Hosts

- General v3 API: `https://cloud.feedly.com/v3`
- Content search API: `https://api.feedly.com/v3`
- Web app: `https://feedly.com`

Override with `FEEDLY_API_BASE` / `FEEDLY_SEARCH_API_BASE`.

## Authentication

`Authorization: Bearer <access token>`.

### Device flow (what `feedly login` uses)

Feedly supports RFC 8628 device authorization:

1. `POST /v3/auth/device` with `client_id`, `client_secret`, `scope` returns
   `device_code`, `user_code`, `verification_uri(_complete)`, `expires_in` (900s),
   and `interval` (5s).
2. The user approves at `https://cloud.feedly.com/v3/auth/connect/<user_code>`.
3. Poll `POST /v3/auth/token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` until it stops
   returning `authorization_pending` (also handle `slow_down`, `access_denied`,
   and expiry).

Feedly's public developer client is `client_id=feedlydev` with
`client_secret=feedlydev`; it is the same client used by the official
`https://feedly.com/v3/auth/dev` token page. Both values are required — omitting
`client_secret` yields `missing client_secret`.

Loopback redirect URIs are **not** allow-listed, which is why the device flow is
used instead of a local callback server:

| `redirect_uri` | Result |
| --- | --- |
| `https://feedly.com/v3/auth/dev` | allowed (official PKCE page) |
| `urn:ietf:wg:oauth:2.0:oob` | allowed |
| `http://127.0.0.1:<port>/callback` | rejected |
| `https://localhost:<port>/callback` | `invalid_redirect_uri` |

### Refresh token

`POST /v3/auth/token` exchanges a refresh token:

```
grant_type=refresh_token
refresh_token=<token>
client_id=feedly          # falls back to feedlydev
client_secret=<optional>
```

The two public client ids work without a secret for personal use. A
configured `client_id` (and optional `client_secret`) takes precedence, then
`feedly`, then `feedlydev`. Responses may rotate the refresh token — the CLI
persists the new value.

`expires_in` is seconds. `expires_at` in config files is accepted in both
seconds and milliseconds and normalized to milliseconds.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v3/auth/device` | Device authorization; needs `client_id` + `client_secret` |
| `GET` | `/v3/profile` | Account info and the user id |
| `GET` | `/v3/streams/contents` | `streamId`, `count`, `continuation`, `unreadOnly`, `ranked` |
| `POST` | `/v3/search/contents` | Search API host; JSON body of `layers` + `source` |
| `GET` | `/v3/categories` | Categories |
| `GET` | `/v3/subscriptions` | Subscribed feeds |
| `GET` | `/v3/markers/counts` | Unread counts (`unreadcounts[]`) |
| `POST` | `/v3/markers` | `{ action: "markAsRead", type: "entries", entryIds: [...] }` |

Stream ids follow `user/<userId>/category/<name>`, `user/<userId>/tag/<name>`,
or `feed/<url>`.

## Pitfalls

- The search API lives on a different host than the rest of v3.
- `ct` / `cv` query parameters come from desktop-client traffic and may drift
  over time. They are currently `feedly.desktop` and `31.0.3087`.
- `newerThan` / `olderThan` are epoch milliseconds, and `newerThan` must be
  earlier than `olderThan`.
- Search results arrive in `items[]`; an empty array is a valid empty result,
  not a failure.
- Malformed entries (missing `id`) are treated as API errors instead of being
  silently dropped, so pagination cannot lose rows without a signal.
- Some business-event NLP models are Market Intelligence features and can
  return plan-permission errors (HTTP 403).
- Pagination uses an opaque `continuation`; loop until it is absent/empty or
  the requested count is reached.

## Entry bodies

A stream item carries two independent `{ content, direction }` blocks:

- `summary.content` — the RSS teaser (often 100–500 chars)
- `content.content` — the full article body (commonly 1KB–13KB)

Both may be present, and either may be missing. Observed in one 20-item page:

| feed | summary | content |
| --- | --- | --- |
| 36氪 | 12290 (no content) | absent |
| 钛媒体 | 98 | 7650 |
| V2EX | 0 | up to 4721 |
| Solidot / BBC 中文 | 116–489 | absent |

Do not pick one with a ternary — a short `summary` next to a long `content` is the
common case, and choosing by presence silently discards the article. Read both,
and fall back to the summary only when `content` is missing. Bodies contain raw
HTML (paragraphs, `<br>`, entities), so strip tags for text output.
