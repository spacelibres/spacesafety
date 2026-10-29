<!-- source: https://space-safety.starlink.com/docs/tutorial-basics/stargaze -->

# Stargaze

## Overview ​

[Stargaze](https://starlink.com/updates/stargaze) is Starlink's Space Situational Awareness (SSA) system that leverages the tens of thousands of star trackers on Starlink satellites to make optical observations of nearby objects.

Users of our Space Traffic Coordination APIs will start receiving CDMs based on Stargaze observations in April 2026, starting in the staging environment.

## Limitations ​

Stargaze processes over 30 million transits per day, and is capable of observing many objects far more frequently than ground-based radars. However, Stargaze still does not track every object in public radar catalogs.

Furthermore, while Stargaze can detect maneuvers more quickly than any other system in use today, the most definitive source of satellite trajectories should be provided by operators themselves, who can inform others of their intent to maneuver before maneuvers occur.
