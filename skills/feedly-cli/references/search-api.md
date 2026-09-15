# Feedly content search API

Reference for `feedly search --layers`. The full document lives at
[docs/search-api.md](../../docs/search-api.md).

## Endpoints and authentication

- General v3 API: `https://cloud.feedly.com/v3`
- Content search: `POST https://api.feedly.com/v3/search/contents`
- Authentication: `Authorization: Bearer <access token>`
- Token refresh: `POST https://cloud.feedly.com/v3/auth/token`

## Plain-text search

```json
{
  "layers": [
    { "parts": [{ "text": "test" }], "type": "matches", "salience": "about" }
  ],
  "source": {
    "items": [
      { "label": "All Personal Feeds", "type": "stream", "id": "user/<user-id>/category/global.all" },
      { "label": "Business & Strategy", "type": "publicationBucket", "id": "byf:business-and-strategy", "tier": "tier1" },
      { "label": "Tech Blogs", "type": "publicationBucket", "id": "byf:tech", "tier": "tier1" }
    ]
  }
}
```

## Verified template shape

```json
{
  "layers": [
    { "parts": [{ "id": "nlp/f/businessEvent/partnership" }], "type": "matches", "salience": "about" },
    { "parts": [{ "id": "nlp/f/entity/gz:org:openai" }], "type": "matches", "salience": "mention", "searchHint": "org" }
  ]
}
```

```bash
feedly search --layers @layers.json --scope personal
```

Some business-event models are Market Intelligence features and can return
`403` when the plan does not include them.
