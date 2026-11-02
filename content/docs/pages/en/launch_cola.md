# Launch and early mission

The first hours of a mission are the least predictable and the most crowded in
consequence: objects are released into a shell that already contains thousands of
tracked pieces, before the operator's own ephemerides are published.

## The problem, stated plainly

| Phase | What is known | What is not |
|---|---|---|
| Ascent | Launch window, target orbit | Nothing about the actual state until tracking begins |
| Deployment | Object count and rough separation | Individual states; manoeuvre authority |
| Early orbit | First element sets arrive | Whether the satellite can still manoeuvre |
| Normal operations | Published ephemerides | — |

Screening an object that has no ephemeris is not possible; what a service can do is
say when the first elements arrive and what they imply.

## What this deployment offers

The catalogue pages carry the tracked population, including the 60-day and decay
feeds that show what is coming down. Upcoming launches and their statistics are on
**Launches & break-ups**, sourced from KeepTrack rather than computed here.

```bash
# Objects that re-entered recently — the other end of the object life cycle
curl -s 'http://127.0.0.1:3000/api/v1/catalogue/choice?regime=LEO' | head -c 200
```

## Why early-mission avoidance is different

A satellite still able to manoeuvre can avoid almost anything, given warning. The
binding constraint in early mission is not delta-v but **authority**: whether the team
is allowed to act on a warning before the satellite has been declared operational.
That is a process question, and no amount of data solves it — which is why the API
records claim status rather than inventing it.
