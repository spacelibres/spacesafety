# Operators

An operator is the account that owns objects. It is the unit of identity, of
quota, and of what a certificate may read.

## Fields

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Referenced by every object and trajectory |
| `name` | string | Display name |
| `email` | string | Contact for coordination |
| `phone` | string | Contact for coordination |
| `max_objects` | integer | Object quota |

`email` and `phone` are not decoration: conjunction coordination is people
agreeing with people, and the event stream lists both operators so it is clear who
to call.

## Create and update

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/operator' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Example Operator","email":"ops@example.test","max_objects":500}'

curl --key client.key --cert client.crt -X PATCH 'https://<host>/api/v1/operator/<uuid>' \
  -H 'Content-Type: application/json' -d '{"max_objects":800}'
```

`PATCH` is partial: omitted fields keep their value. An empty body is a valid
`PATCH` and changes nothing — it is not an error.

## What an operator does not control

| Claim | Reality |
|---|---|
| "I can read any CDM involving my objects" | Yes — but you must name yourself in the filter |
| "My quota applies per request" | No — it is a count of objects, checked on creation |
| "Creating an operator gives me credentials" | No — credentials are certificates, issued out of band |

## Two operators in one event

A conjunction is symmetric, and the event record keeps both sides with their own
claim status. Neither side's claim is inferred from the other's, and neither is
inferred from the satellite's behaviour.
