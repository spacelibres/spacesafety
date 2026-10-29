<!-- source: https://space-safety.starlink.com/docs/space-safety-articles/launch_cola -->

# Launch and Early Mission

## The "Launch COLA GAP" ​

The "Launch Collision Avoidance (COLA) Gap" refers to the period of time after a new satellite is launched, but before it can be reliably avoided by other on-orbit satellites. This brief window can contribute a disproportionate amount of lifetime collision risk for a satellite - operators should be mindful of the hazard posed by it and the mitigations available to them.

Launch providers often perform pre-launch "Launch COLA" screenings, either themselves, or through government organizations. However, typical pre-launch COLA screenings only protect against conjunctions for a few hours after orbital insertion. Large launch vehicle orbit insertion uncertainties make it challenging to effectively screen long durations for collision risk. Even in circumstances where providers opt to perform a longer screening, challenges like "Covariance Dilution" can render them ineffective at mitigating post-launch risk.

Newly launched satellites may not able to react to conjunctions for hours or days after insertion, due to early mission activation and checkout sequences. In these circumstances, it is critical that other operators have access to high-quality ephemerides so they can perform effective collision avoidance against newly-launched objects. It can take days, or weeks for reliable radar-based predictions to become available for newly-launched payloads, especially for large rideshare missions, which can dispense dozens of payloads in one launch.

Fortunately, there are opportunities available to operators to proactively mitigate these risks, such as avoiding insertions directly into high density altitudes, as well as post-launch ephemeris sharing.

## Altitude Dependence ​

There is a large variation of object density across different altitudes in low earth orbit (LEO). Most altitudes are comparatively sparse, averaging around ~15 objects per kilometer of altitude. In contrast, altitudes occupied by large satellite constellations can be considerably more dense, with over >1,000 satellites per kilometer of altitude. Intuitively, risk from the Launch COLA Gap scales proportional to the size and quantity of objects in the desired insertion altitudes, and inserting directly into altitudes that overlap with large constellations can face launch COLA risks that are 50x higher than a conventional insertion into a sparsely populated altitude.

Below shows the Low Earth Orbit environment as of early 2026, provided as an approximate visualization. Actual launch COLA planning should reference latest catalog information at the time of launch planning.

It's important to recognize that this large variation as a function of altitude is a relatively new phenomenon that is only a few years old. Prior to 2020 the per-altitude variation was considerably smaller, with prior launches not meaningfully affected by it. Organizations with such past experience may be prone to underestimating the Launch COLA gap risk for these reasons. Moving forward, it's important for both launch providers and satellite operators to be cognizant of launch COLA gap risks, and consider appropriate mitigations accordingly.

## Quantifying Launch COLA Risk ​

As the exact risk faced by a given launch depends on multiple factors such as apogee, perigee, eccentricity, inclination, and precise argument of perigee - any "rule of thumb" risk estimate will be subject to error. However, to ground intuition, we provide an approximate scenario based on Monte Carlo analysis: "A 1-meter diameter payload can experience a collision risk of 5e-5 Pc/object/day if it is inserted directly into an altitude range overlapping a dense constellation shell". Below are some sample scenarios, calculating the total risk for each launch. To put each number in perspective, an "equivalent number of COLA maneuvers" is provided, based on Starlink's current 3e-7 Pc maneuver threshold at the time of this writing:

#### Scenario 1: 1 payload, 520km (sparse) insertion altitude ​

- (1e-6 / payload / day) 2 x (1 payload) x (2 days to catalog) = 2e-6 total collision risk
- Equivalent to ~7 COLA maneuvers 1

#### Scenario 2: 1 payload, 560km (dense) insertion altitude ​

- (5e-5 / payload / day) x (1 payload) x (2 days to catalog) = 1e-4 total collision risk
- Equivalent to ~333 COLA maneuvers 1

#### Scenario 3: 30 payload rideshare mission, 560 km (dense) insertion altitude ​

- (5e-5 / payload / day) x (30 payloads) x (7 days to catalog) 3 = 1e-2 total collision risk
- Equivalent to ~35,000 COLA maneuvers 1

Note how in Scenario 1, the total risk for the launch is estimated to be just 2e-6 (1-in-500,000), in line with the previous historical posture of the "Launch COLA Gap" not being considered a major concern. Scenario 2 considers the same payload, but now inserting into a high-density altitude. Correspondingly, risk goes up by a factor of ~50, yielding a cumulative launch risk of 1e-4 (1-in-10,000). This is actionable even by legacy industry standards. Finally, Scenario 3 considers a rideshare mission to a high-density altitude; reflecting a larger number of payloads, and a considerably longer cataloging time. These two factors increase risk by another two orders of magnitude, yielding a per-launch estimate of 1e-2 (1-in-100), which is extremely hazardous. These examples illustrate the importance of both launch providers and satellite operators booking those missions to be cognizant of these risks.

## Mitigations ​

There are a handful of preemptive actions that operators can take to mitigate early-mission COLA risk:

### Avoid launching directly into high-density altitudes ​

The most effective way to mitigate early-mission risk is to avoid launching directly into a high-density altitude. Note that this approach does not prohibit a satellite operator from operating in that same high-density altitude, it only suggests not to launch directly into it. Today, it is an increasingly common practice for satellites to insert into one altitude, and orbit transfer to their operational altitude. This technique has the fewest caveats, and is extremely effective at mitigating Launch COLA risk. As an example, Starlink satellites insert into a very sparsely populated ~300km orbit, and then orbit raise to their operational altitude of ~480km. This is an extreme example however, as even small offsets of ~10-20km can be sufficient to greatly mitigate Launch COLA risk.

### Immediately publish ephemeris post-insertion ​

If launching into a high-density altitude cannot be avoided, risk can be mitigated by publishing ephemeris immediately after insertion. This can consist of two sequential steps:

1. First, the launch provider can publish GNSS-derived propagated ephemeris immediately after insertion / payload dispense. This eliminates the large amount of uncertainty typically associated with launch, by waiting until after the second stage engine has shut off to generate a new orbital state. A number of launch providers have started submitting post-insertion ephemeris to the Space Traffic Coordination APIs for this purpose.
2. Next, the satellite operator should publish ephemeris immediately after contacting their satellite. As an example, Starlink satellites typically publish ephemeris based on on-board GNSS measurements within 1-2 hours of launch. This step is still useful even if it takes an operator considerably longer to contact their spacecraft (ie: 12 hours), as cataloging delays can typically be considerably longer still.

With these mitigations (and an effective pre-launch COLA screening process), it can be possible to completely close the launch COLA gap, illustrated below.

Nonetheless, operators and launch providers should remain vigilant about the accuracy and timeliness of this data. Significant errors in any of them could result in a COLA Gap timeline that looks good on paper, but provides no real safety in practice. Operators are encouraged to test such processes in advance, to be confident that they can be relied on for day of launch.

---

1. 50x lower than in dense altitudes; note that this may be greater when accounting for satellite size differences ↩
2. Assuming Starlink's current 3e-7 Pc manuever threshold ↩
3. Large rideshare missions can take considerably longer to catalog ↩
