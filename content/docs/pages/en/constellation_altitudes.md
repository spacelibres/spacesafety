# Constellation altitudes

Altitude decides the environment a constellation operates in, and the differences
are not gradual.

| Shell | Character | What it means for avoidance |
|---|---|---|
| LEO below ~600 km | Dense with debris; decays in years | Collisions are frequent events, but objects leave on their own |
| LEO 540–570 km | The Starlink shell | High conjunction rate, high manoeuvre budget |
| Polar / sun-synchronous ~500–800 km | Shared by many operators | Persistent crossing traffic, mostly short-warning |
| MEO ~20 000 km | Navigation constellations | Fewer objects, no drag help: debris stays for millennia |
| GEO ~35 786 km | Fixed longitudes, station-keeping | Conjunctions are rare but geometrically special (co-located slots) |

## Why this matters to an API client

A conjunction rate is a property of the shell, not of the software. An operator with
a few hundred satellites at 550 km will see more CDMs in a day than a GEO operator
sees in a year, and a polling cadence that works for one is wrong for the other.

The catalogue this deployment shows carries a `regime` classification per object,
derived from the elements rather than asserted by anyone, so "how much traffic is in
my shell" is a question the data can answer.

## Two consequences worth internalising

**Debris is local.** A break-up at 780 km pollutes that band for decades; the same
break-up at 300 km is gone within a couple of years. Screening the two identically
is arithmetically correct and operationally misleading.

**Crossing geometry is not uniform.** Co-planar neighbours drift slowly and produce
long, well-observed conjunctions; a polar satellite crossing the same shell produces
short-warning ones. The number of CDMs you receive says nothing about which kind you
are looking at.

## Using the catalogue for context

```bash
# Objects in one regime, from the catalogue
curl -s 'http://127.0.0.1:3000/api/v1/catalogue/choice?regime=LEO' | head -c 400
```

The count per regime changes slowly; a sudden change in your own shell is worth
investigating, since it usually means a break-up rather than a launch.
