# API patterns

These conventions apply across every endpoint. They are the parts of the contract
a client can rely on without reading each page.

## The envelope

Bulk list endpoints return the same two fields:

```json
{ "result": [ /* rows */ ], "token": "eyJ2IjoxfQ" }
```

`result` is the page you asked for. `token` is the cursor for the next one, and it
is **opaque** — do not parse it, derive it, or construct one yourself.

## Pagination

| Rule | Behaviour |
|---|---|
| Pass back what you got | `?token=<value from the previous response>` |
| `token` omitted | First page |
| `token` does not match the filters used to issue it | `400` — a cursor is bound to the filter set that produced it, because resuming with different filters would skip rows silently |
| Cursor too old | `400 pagination_too_old` — re-issue the request from the first page |
| End of data | The final page still carries a `token`; the *next* request returns an empty `result` |

Two different paging styles exist, and mixing them up is the usual mistake:

- **cursor** (`token`) on `POST`/stream endpoints that can append while you read;
- **offset** (`limit`, `offset`) on `GET /v1/object` and `GET /v1/operator`, where
  the list is ordered by name so a pager sees a stable sequence.

## Errors

Every failure uses one shape:

```json
{
  "correlation_id": "1f0a…",
  "error": "human-readable message",
  "error_type": "machine-readable code",
  "metadata": {}
}
```

| Status | Meaning | `error_type` examples |
|---|---|---|
| `400` | The request is wrong — bad parameter, missing required filter, or validation failure | `bad_request`, `trajectory_invalid`, `invalid_source`, `pagination_too_old` |
| `401` | No valid client certificate | `unauthorized` |
| `404` | The row does not exist, or is not yours | `not_found` |
| `413` | The body is larger than any endpoint accepts (34 MiB: the 30 MiB ephemeris ceiling plus its JSON envelope) | `payload_too_large` |
| `503` | Rate limit exceeded | `rate_limited` |

`metadata` carries detail that belongs with the message: validation issues are
there as `{"issues":[{"field":"file","reason":"…"}]}`, and the offending parameter
name is there as `{"parameter":"upload_type"}`.

## Rate limits

Requests are metered per operator with a token bucket. **A read costs 1 token and
a write costs 10**, so one budget covers both polling and publishing: a polling
client never notices it, and an upload loop is throttled to a tenth of it.

When the bucket is empty the response is `503` with `Retry-After`:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 60
```

Honour `Retry-After`. A 503 without it would be an instruction to retry
immediately, which turns a limit into a self-inflicted outage.

The budget is read from `SPACE_SAFETY_RATE_LIMIT_PER_MINUTE` (default 600 reads
per minute) at call time, so it can be changed without a restart.

## Time

| Where | Format |
|---|---|
| `created_at`, `uploaded_at`, `start_at`, … | RFC 3339 UTC, e.g. `2026-11-02T05:00:07.000Z` |
| `tca_gps_nanos`, `first_cdm_tca_gps_nanos` | GPS nanoseconds as a **string** |

Nanoseconds are a string because 2⁶³ does not survive a JavaScript number: the
value would round, and a rounded TCA is a different conjunction. `tca_min` /
`tca_max` filters take **seconds**.

## Filters

Filters are additive (AND) and validated, not ignored:

- A filter with an unknown value is a `400`, never a silent no-op. `upload_type=banana`
  does not return everything; it returns an error naming the parameter.
- A dependency between filters is enforced: `operator2_id` without `operator1_id`
  is a `400`, because the pair has no meaning on its own.
- A list endpoint that would return the whole system requires at least one scoping
  filter (`/v2/cdm` needs one of `operator1_id`, `trajectory_id`, `object1_id`).

## Requests

- `Accept: application/json` unless the endpoint returns a file.
- `Content-Type: application/json` for `POST` / `PATCH`.
- Unknown body fields are ignored; a known field with a wrong type is a `400`.
