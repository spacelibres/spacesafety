# Conjunction events

An event is a *conjunction*: two objects, one approach, and the whole CDM history
between them. It is the unit humans coordinate on; a CDM is the unit a machine
computes.

## Grouping

Two CDMs become one event when they describe the same pair approaching at the same
time. Issuing a fresh message does not create a new event — that is the entire
point, otherwise a single conjunction that was updated six times would look like
six problems.

The pairing is order-insensitive: the same conjunction also arrives with the two
objects swapped, and counting that as a second event would double every warning.

## Fields

| Field | Meaning |
|---|---|
| `id` | The event |
| `created_at` | When the event was first opened |
| `updated_time` | Last time a CDM changed it |
| `first_cdm_tca_gps_nanos` | TCA from the first message — how the estimate has moved since |
| `object1_*` / `object2_*` | Participants, with `maneuverable` |
| `operator1_id` / `operator2_id` | Who owns each side |
| `claim_status_operator1/2` | Who says they will manoeuvre |
| `last_status_update_time_operator1/2` | When each side last said anything |
| `cdms` | The message history, newest last |

## Claim status

`claim_status_*` is the coordination layer, and it is worth being precise about what
it means:

| Value | Meaning |
|---|---|
| `none` | No claim recorded |
| `assumed` | This side is assumed to manoeuvre |
| `claimed` | This side says it will manoeuvre |

It is **recorded**, never inferred. Inferring a claim from the satellite's recent
behaviour would be guessing about someone else's operations and then acting on the
guess.

## Fetching

```bash
curl --key client.key --cert client.crt 'https://<host>/api/v2/event/<uuid>'
```

The response includes `cdms`, so one request gives the current risk *and* how it
got there. For a long-running conjunction, prefer this over re-reading the stream:
it is one row instead of hundreds.

## The deprecated v1 view

`GET /api/v1/event` still exists because clients written against the old tutorial
call it. It is scoped to the caller's operator and carries a subset of the fields.
New work should use `/api/v2/event/:id`.
