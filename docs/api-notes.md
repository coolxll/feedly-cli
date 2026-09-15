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
