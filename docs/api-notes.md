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

Feedly's public developer client is `client_id=feedlydev`; the device grant
also requires `client_secret=feedlydev`. `client_secret` is validated here
(unlike the refresh grant): omitting it yields `missing client_secret` and a
wrong value yields `bad client_secret`.

`client_id=feedly` cannot be used for login: the device grant demands a secret,
and none for `feedly` is publicly available — both plausible guesses are rejected
with `bad client_secret`. `feedlydev` is also what Feedly's own
`https://feedly.com/v3/auth/dev` page uses (its `clientId` constant), though that
page does not publish the secret.

Because a public secret is involved, `--paste` exists as an independent path: it
uses the official PKCE page, which as a public client needs **no** secret, at the
cost of copying the token by hand.

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
client_id=<the client that minted the token>
```

**A refresh token is bound to the client that created it.** Verified by swapping
clients on the same token:

| `client_id` sent | Result |
| --- | --- |
| the minting client | `200` with a new access token |
| the other public client | `400 invalid refresh_token` |
| an unknown client | `400 unknown client_id` |

So a token minted through `feedly` is rejected by `feedlydev`, and the reverse.
The CLI records `client_id` in the config (written on login and refreshed on a
successful refresh) and tries that value first, falling back to `feedly` then
`feedlydev` for configs that predate the field.

`client_secret` is **ignored** on this grant — a wrong value still succeeds, and
omitting it is fine. It is only meaningful for the device and auth-code flows.

`expires_in` is seconds (observed: `604800`, i.e. 7 days). `expires_at` in config
files is accepted in both seconds and milliseconds and normalized to
milliseconds. Refresh responses have been observed to return the same refresh
token unchanged, but the CLI still persists a rotated value if one is sent.

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
