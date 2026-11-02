# Space safety best practices

What follows is about using the service so that its answers are worth acting on.

## Poll the stream, do not crawl the world

`GET /api/v2/cdm` requires a scoping filter. That is deliberate: a client that polls
"everything" puts load on the service and receives a data set it cannot act on.
Poll what you own.

```bash
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?operator1_id=<uuid>&only_active=true&token=<cursor>'
```

Keep the cursor and continue from where you stopped. Restarting from the first page
every time re-reads history and will eventually hit the cursor's age limit.

## A cadence, not a spin

| Data | Sensible cadence | Why |
|---|---|---|
| CDMs for your trajectories | minutes | TCA moves on the scale of the ephemeris update, not of seconds |
| Trajectory metadata after upload | once, with backoff | Screening is queued; polling every second just burns quota |
| Raw CDM file | once per message you actually need | It is the largest representation of the same facts |

Honour `Retry-After` on `503`. Retrying immediately after a rate-limit response is
how a client turns a limit into an outage for itself.

## Distinguish "no conjunction" from "no data"

Three very different situations look alike in a UI and must not be treated alike:

| State | How it looks | What to do |
|---|---|---|
| No CDMs returned | Empty `result` | Nothing is close, given the data the service has |
| `probability_of_collision: null` | A CDM with no Pc | Real conjunction, unknown probability — the miss distance still matters |
| `screened_status: not_screened` | Trajectory exists, no CDMs | Screening has not happened yet; absence of warnings means nothing |

## Report the identifiers

When something looks wrong, quote `correlation_id` (for one failed request) and the
CDM `id` (for one suspicious result). Without them the report is a description of a
symptom nobody can trace.

## Keep the raw material

Store what you uploaded and what you were told. A conjunction discussion between two
operators is settled by comparing the inputs and the computed outputs, and neither
side can do that later if only conclusions were kept.
