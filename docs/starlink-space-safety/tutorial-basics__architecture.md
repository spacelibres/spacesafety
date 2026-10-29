<!-- source: https://space-safety.starlink.com/docs/tutorial-basics/architecture -->

# Architecture and Internals

## Top-level objects ​

The diagram above shows the relationships between different entities in the system:

- An Operator is an entity that operates satellites in orbit, and is assigned an account in the system. Operators are assigned keys during onboarding, which gives them permissions to take actions within the system.
- An Object represents a satellite in orbit. Operators manage zero or more objects.
- A Trajectory is a series of state vectors (position, velocity, time and covariance) related to a single object.
- A Conjunction Data Message (CDM) is a representation of a close approach between two satellites (see the CCSDS spec ). The screening system generates a CDM for every pair of trajectories that fall within the screening box , even if probability of collision evaluates to zero.
- A Conjunction Event or simply "event" describes a point in time where two objects have a close approach, where a close approach is defined as a local minimum in relative distance that falls within our screening box . There is a many-to-one relationship of CDMs to conjunction events; a CDMs is generated for every pair of trajectories that have a close approach, while a conjunction event describes the evolution of a conjunction as (potentially multiple) trajectories are submitted for two objects. Properties like miss distance and collision probability are inherited from an event's "active" CDM.

Subsequent articles in this tutorial discuss each of these objects in detail.

## Screening internals ​

### Catalog ​

The screening system maintains a "catalog" of the most-recently-submitted definitive trajectories, one for each [State source](https://space-safety.starlink.com/docs/tutorial-basics/trajectories#trajectory-state-sources) for each object. See [Trajectory Submission Types](https://space-safety.starlink.com/docs/tutorial-basics/trajectories#trajectory-submission-types) to learn about definitive vs. hypothetical trajectories.

### Screening Cycle ​

The screening system operates based on a queueing model: When new trajectories are submitted via the [POST /api/v1/trajectory](https://space-safety.starlink.com/docs/api/upload-a-trajectory) API, they are added to a queue. The screening pipeline periodically fetches a batch of "not_screened" trajectories, and screens them against the existing catalog. It then generates CDMs, updates conjunction events, updates the status of trajectories, and updates the catalog in preparation for the next cycle.

### Close Approach Finding ​

A close approach is determined by one trajectory entering the screening box of another trajectory.

The half-widths of the screening box are currently set to 2 km radially, 44 km along track, and 51 km out of plane in RTN with respect to the states specified in trajectory files. Note, the rotation of the screening box based on the velocity of each object determines the orientation of the screening box.

The close approach calculation compares the intersection of this screening box against a point on the secondary object's trajectory. This calculation is done in both directions (object1's screening box intersects the trajectory of object2 or object2's screening box intersects the trajectory of object1).

### Collision Probability ​

The screening currently uses the two-dimensional Alfano collision probability method: ['A Numerical Implementation of Spherical Object Collision Probability' by S. Alfano.](https://doi.org/10.1007/BF03546397)
