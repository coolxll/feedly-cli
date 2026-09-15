# Feedly content search API

Reference for `feedly search`, including structured template-style layers.

## Endpoints and authentication

- General v3 API: `https://cloud.feedly.com/v3`
- Content search: `POST https://api.feedly.com/v3/search/contents`
- Authentication: `Authorization: Bearer <access token>`
- Token refresh: `POST https://cloud.feedly.com/v3/auth/token`

## Plain-text search

```json
{
  "layers": [
    {
      "parts": [{ "text": "test" }],
      "type": "matches",
      "salience": "about"
    }
  ],
  "source": {
    "items": [
      {
        "label": "All Personal Feeds",
        "type": "stream",
        "id": "user/<user-id>/category/global.all"
      },
      {
        "label": "Business & Strategy",
        "type": "publicationBucket",
        "id": "byf:business-and-strategy",
        "tier": "tier1"
      },
      {
        "label": "Tech Blogs",
        "type": "publicationBucket",
        "id": "byf:tech",
        "tier": "tier1"
      }
    ]
  }
}
```

Query parameters: `count`, `newerThan`, `olderThan`, `ct`, `cv`. Treat the
desktop-client metadata (`ct`, `cv`) as version-sensitive.

This is what `feedly search "test"` sends:

```bash
feedly search test --scope all --json
```

## Verified template shape

A Feedly web template (`Competitors — Partnerships AND Company`) produced:

```json
{
  "layers": [
    {
      "parts": [{ "id": "nlp/f/businessEvent/partnership" }],
      "type": "matches",
      "salience": "about"
    },
    {
      "parts": [{ "id": "nlp/f/entity/gz:org:openai" }],
      "type": "matches",
      "salience": "mention",
      "searchHint": "org"
    }
  ]
}
```

The first layer selects a Feedly machine-learning model, the second a resolved
organization entity. Entity selection searches aliases; a plain-text fallback
is less precise.

Send it with `--layers`:

```bash
feedly search --layers '[
  {"parts":[{"id":"nlp/f/businessEvent/partnership"}],"type":"matches","salience":"about"},
  {"parts":[{"id":"nlp/f/entity/gz:org:openai"}],"type":"matches","salience":"mention","searchHint":"org"}
]' --scope personal
```

## Web search builder state

The browser page stores its builder state in the `options` query parameter as
base64url-encoded JSON. Useful fields:

- `layers`: structured search conditions
- `bundles`: source presets
- `refineMode`: selected bundle
- `publishedFilter`: UI time preset
- `languages`: selected languages

Use this as discovery evidence, not as a stable public contract.

## Source bundles observed

- `customMode`: personal `global.all` + `byf:business-and-strategy` + `byf:tech`
- `allFeedlyMode`: personal `global.all` + `discovery:all-topics`
- `boardMode`: `user/<id>/tag/global.all`
- `annotatedMode`: `user/<id>/tag/global.annotated`

The CLI exposes the `customMode` subset through `--scope`.

## Implementation boundary

Full template support requires:

1. Multiple layers in the request body (supported via `--layers`).
2. Stable built-in template-to-model mappings.
3. Entity/model autocomplete or resolution.
4. A plain-text fallback when resolution fails.
5. Clear errors for plan-gated models such as Market Intelligence features.

Do not claim exact template parity until resolver requests and responses have
fixture-backed tests.
