# CDMs

A Conjunction Data Message is one screening result: two objects, a time of closest
approach, a miss distance, and — when the inputs allow it — a probability of
collision.

## What one contains

| Field | Meaning |
|---|---|
| `id` | This message |
| `event_id` | The conjunction it belongs to. Several CDMs share one |
| `creation_time` | When this run produced it |
| `tca_gps_nanos` | Time of closest approach, GPS nanoseconds as a string |
| `probability_of_collision` | Pc, or `null` |
| `trajectory1_id` / `trajectory2_id` | The two trajectories screened |
| `object1_*` / `object2_*` | The two objects, denormalised so a row is readable alone |
| `is_active` | Whether a later message has superseded this one |

## Pc is `null` more often than you would like

Pc needs covariance on both sides. When it is missing, the field is `null` — never
`0`. The distinction matters: `0` means "computed and negligible", `null` means "not
computed". A client that treats them alike will sort a real unknown threat below
every measured one.

The miss distance is still reported in that case, and it is still actionable: 71 m
is 71 m whether or not anyone can put a probability on it.

## Revisions

One conjunction produces a CDM every time the estimate moves. The stream returns
all of them, oldest first, because that history is the point:

```
05:32  Pc 0.0028698   miss 85 km
00:23  Pc 0.0032998   miss 71 km
05:37  Pc 0.0032998   miss 71 km   ← current
```

Reading that as four independent warnings is the classic mistake. It is one
conjunction whose estimate improved.

| You want | Ask for |
|---|---|
| Every message, to see how the estimate moved | `/api/v2/cdm?trajectory_id=…` |
| Only the current estimate | add `only_active=true` |
| One conjunction's whole history | `/api/v2/event/:id` |

## Fetching

```bash
# Current CDMs involving one trajectory
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?trajectory_id=<uuid>&only_active=true'

# The serialised CDM itself, as KVN
curl --key client.key --cert client.crt 'https://<host>/api/v1/cdm/<uuid>?format=kvn'
```

## What a CDM is not

- Not a manoeuvre recommendation. It says two objects will be close; what to do
  about it belongs to the operators.
- Not symmetric in ownership. Both sides see the same event with their own claim
  status, which is a coordination signal, not a computed quantity.
- Not a catalogue notice. A CDM is about trajectories; the catalogue's own
  conjunctions are a different dataset (see **Conjunctions** in the app).

## How this deployment computes a CDM

The numbers below are the screening configuration, published because a probability
you cannot interrogate is not evidence:

| Parameter | Value |
|---|---|
| Screening box, radial | ± 2 km |
| Screening box, along-track | ± 44 km |
| Screening box, cross-track | ± 51 km |
| Event grouping window | 20 minutes |
| Collision probability | 2-D Alfano, projected onto the encounter plane |
| Minimum trajectory span | 6 state vectors, 42 s, no more than 21 days |

The box is deliberately anisotropic: along-track uncertainty dominates by an order
of magnitude, so a symmetric box would either miss real conjunctions or drown them
in candidates. The grouping window is what makes one approach one event.
