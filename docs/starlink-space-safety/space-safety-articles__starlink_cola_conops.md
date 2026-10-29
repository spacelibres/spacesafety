<!-- source: https://space-safety.starlink.com/docs/space-safety-articles/starlink_cola_conops -->

# Starlink Collision Avoidance CONOPS

## Overview ​

Starlink satellites utilize an automated collision avoidance system to assess and react to upcoming conjunctions, enabling them to plan risk-mitigating collision avoidance maneuvers without humans in the loop. Starlink typically executes over 1,000 collision avoidance maneuvers per day using this system.

## High-Level Workflow ​

Starlink's collision avoidance pipeline can be thought of as a cyclical process consisting of three steps:

1. Ephemeris Generation - Sharing of multi-day, high-accuracy trajectory predictions, which start from a filtered global navigation satellite system (GNSS) state, and are propagated forward incorporating the effect of upcoming maneuvers.
2. Conjunction Screening - Trajectories are screened against other objects' ephemerides to identify close approaches and generate conjunction data messages.
3. Maneuver Planning - Conjunction data messages are distributed to satellites, which use them to assess high-risk conjunctions and plan corresponding collision avoidance maneuvers.

### Ephemeris Generation ​

All Starlink satellites are equipped with GNSS receivers, enabling them to generate an instantaneous position and velocity estimate without relying on third-party tracking. An orbit filter is applied to raw GNSS receiver outputs, refining them into a high-accuracy instantaneous state estimate. This state estimate is propagated forward for multiple days, accounting for satellite maneuvers and major perturbations such as drag and a high-order gravity model. Starlink uses a real-time on-orbit density estimate when generating predictions, enabling it to account for daily/hourly density fluctuations that are pronounced during adverse solar storms. In addition to propagated position and velocity, Starlink's ephemeris exports also contain covariance information representing the uncertainty associated with each prediction. This covariance can be used in downstream steps to compute collision probability (Pc) for potential close approaches.

#### Ephemeris Sharing ​

Starlink ephemerides are hosted at various locations:

|  | space-safety.com | starlink.com (OCM) | starlink.com (Modified ITC) | space-track.org |
| --- | --- | --- | --- | --- |
| Update Cadence | Approximately Hourly | Approximately hourly | Every 8 hours | Every 8 hours |
| Format | Multiple supported formats | CCSDS OCM | Modified ITC | Modified ITC |
| Location | Requires space-safety.com operator account | Static URLs like https://www.starlink.com/public-files/ephemerides/STARLINK-35000.txt | https://www.starlink.com/public-files/ephemerides/MANIFEST.txt contains a list of files, each hosted under /public-files/ephemerides/ < filename.txt > | For those with operator accounts, Modified ITC ephemerides are still available under /Ephemeris/SpaceX/. CDMs against owner/operator ephemerides available via the CDM endpoint at https://www.space-track.org/operator#/cdm |
| Notes | Best source for real-time collision avoidance screening | Contains explicit maneuver plan | Generally intended for legacy users of ephemeris files previously hosted on Space-Track | Per Space-Track configuration, owner/operator ephemeris screening results are only available if the secondary operator is also publishing ephemeris. Otherwise, only radar-based screening results are available. |

Space-Safety.com is the recommended source for Starlink ephemerides due to the fastest cadence of ephemeris updates, which is important given possible changes in satellite predictions from updated maneuver plans and atmospheric density fluctuations, among other sources of perturbations.

#### Other sources of Starlink ephemeris ​

While external parties such as Space-Track may generate their own ephemerides using radar-based observations of Starlink satellites, relying on external tracking for collision avoidance screenings against maneuverable Starlink satellites is ill-advised. Passive tracking cannot account for the frequent maneuvers performed by Starlink satellites and therefore produces discrepant and inaccurate screening results for maneuverable satellites. Furthermore, while radar tracking can be valid for non-maneuverable Starlink satellites, onboard GNSS-derived predictions are typically more accurate and are able to account for real-time and forecasted changes in the satellite's operational state.

As such, Starlink recommends operators primarily use Starlink owner/operator ephemerides for screening where available. Using radar-based screening results may be warranted situationally at the operator's discretion — for example, where fresh owner/operator ephemerides are unavailable, where the Starlink satellite is dead on-orbit, or as a supplementary source if the Starlink satellite is non-maneuverable — but generally should not be a default source for collision avoidance screening.

#### Prediction Accuracy Monitoring ​

Starlink ephemeris accuracy is monitored continuously on a per-satellite basis as well as in aggregate across the fleet. Ephemeris accuracy is derived by a ground-side analysis comparing real-time instantaneous GNSS solutions as "truth states" against prior predictions from onboard propagations.

Distributions of Starlink owner/operator ephemeris prediction error on various time horizons.

Covariance realism for Starlink owner/operator ephemeris prediction error on various time horizons. Starlink errs on the side of mildly oversized covariance, which, at these covariance magnitudes, is generally more conservative than undersized covariance.

### Orbit Control Maneuvers ​

Most Starlink satellites perform maneuvers daily or even more frequently:

- Satellites that are station-keeping in user-serving shells will perform approximately daily station-keeping burns, but these can be even more frequent at lower altitudes.
- Orbit-transferring satellites—raising their orbit at beginning of life or lowering it at end of life—can perform maneuvers approximately hourly.

Starlink satellites plan orbit control burns autonomously, introducing them into the burn plan up to 48 hours in the future. The high-accuracy propagation incorporates the effect of these maneuvers, ensuring accurate trajectory predictions even over multiple consecutive maneuvers.

### Reference Trajectories ​

Starlink's autonomous orbit control maneuver planning is achieved using closed-loop control towards a prescribed "reference" trajectory. Satellites introduce maneuvers into their burn plan to remain close to their prescribed reference, both while orbit-transferring and while station-keeping within user-serving shells. Because maneuvers are only planned out to 48 hours, trajectory predictions beyond that point are "blended" to the idealized reference trajectory itself. Past this point, the covariance published alongside the ephemeris represents an empirically-derived reference tracking accuracy rather than open-loop propagations.

Starlink reference trajectories are stable on long time horizons. As such, Starlink is able to passively deconflict Starlink satellite reference trajectories from each other far into the future. This method provides multiple layers of safety by avoiding the introduction of intra-Starlink conjunctions to be handled by the real-time collision avoidance system in the first place, described further in sections below. While this reference-based planning strategy is also situationally extended to enable passive deconfliction of orbit-transferring Starlink satellites from non-Starlink objects, the instability of secondary object predictions on multi-day/multi-week horizons hinders the efficacy of this method. Moreover, on-station satellites must adhere to their station-keeping "slots" as dictated by constellation shell design, and thus cannot be rerouted on a broad scale for singular secondary objects. Therefore, any remaining conjunctions are passed to the real-time conjunction screening and collision avoidance process.

## Conjunction Screening ​

For Starlink's real-time collision avoidance system, secondary object predictions are ingested from a variety of sources to perform conjunction screening. Where secondary ephemerides are available directly — such as those uploaded to Space-Safety.com by other operators, or those produced via Stargaze — they are screened within the Space-Safety.com coordination system to produce conjunction data messages. Conjunction data messages and third-party ephemerides are also ingested directly from other platforms such as Space-Track as applicable. All of these resulting CDMs are then stored in Starlink ground services for uplink to satellites.

In general, the most recent CDM from each secondary object state source is uplinked to the satellite to evaluate potential maneuvers. Here, a unique state source means a given observation method along with the originator from which it was provided: for example, Starlink optical (Stargaze), Space-Track radar, or owner/operator ephemerides. If a given operator were to submit multiple ephemeris files in quick succession, only the most recent is considered for collision avoidance. However, satellites consider all secondary state sources when evaluating collision avoidance maneuvers; if a satellite has Stargaze, radar, and owner/operator ephemerides for a given secondary, the satellite will plan a maneuver that dodges all three predictions.

Once CDMs are uplinked to the primary satellite, the satellite constantly recomputes collision probability and relative miss distance onboard against its own latest GNSS filter propagations. Therefore in all cases, Starlink satellites use only their own GNSS-based predictions to evaluate maneuver decisions against all secondary state sources. Any time the collision avoidance maneuver criteria are exceeded, the satellite plans (or modifies or cancels) a maneuver within its burn plan. This strategy enables quick reactions to changes in either secondary or primary predictions.

## Maneuver Response ​

### Maneuver Criteria ​

Starlink satellites that are designated maneuverable take maneuver responsibility for all conjunctions by default (with the exception of non-maneuverable or dead Starlinks, described in further detail below). Starlink satellites consider both a collision probability (Pc) and miss distance threshold for collision avoidance. A maneuver is planned if either the Pc or miss distance criteria are met for any conjunction within the time horizon of consideration and for which the Starlink satellite has maneuver responsibility. When a collision avoidance maneuver is planned, it is planned in a manner that dodges all conjunctions within the time horizon regardless of responsibility assignment.

| Category | Probability of Collision (Pc) Criteria | Probability of Collision (Pc) Target (Maneuver is only planned if Pc can be reduced to this value) | Time Horizon (Time before TCA when a maneuver is planned) |
| --- | --- | --- | --- |
| Healthy and on-station satellites (vast majority of Starlink satellites) | 3e-7 | 1e-7 | 12 hours |
| Orbit-transferring satellites | 1e-6 | 3e-7 | 6 hours |
| Certain hardware-degraded satellites (as long as they are marked "maneuverable" in the CDM) | Ranges from 3e-7 to 1e-5, depending on the hardware failure | Half an order of magnitude below the Pc Criteria | 6 to 18 hours, depending on the failure |
| Non-maneuverable or dead satellites | N/A | N/A | N/A |

Separately, Starlink uses a miss distance criterion of ±100 m radial, ±1500 m along-track, ±1500 m cross-track in the Radial-Tangential-Normal (RTN) frame of the secondary object. A maneuver is planned if the Starlink satellite is predicted to be within that region of the secondary object at the time of closest approach (TCA), if the TCA is within the time horizon. An even greater miss distance criterion may be used for some secondary objects based on assessed prediction quality and risk.

### Maneuver Planning ​

Collision avoidance maneuvers are planned only within a certain time horizon (a specific timespan until TCA), but may be planned any time within that range. This includes the possibility of successive maneuvers or replans in the event that the latest estimates indicate the maneuver criteria are once again met. This enables Starlink satellites to react at very short time horizons as warranted. When a maneuver is planned, the satellite ensures the maneuver will dodge all conjunctions within the horizon, and will attempt to avoid conjunctions for a limited duration immediately beyond the time horizon as well. When the satellite decides to plan a maneuver, the maneuver may occur at any time between that moment in time and TCA, though is preferentially planned for earlier rather than later. The specific time horizons chosen balance sufficient lead time to respond to off-nominal maneuver execution issues against orbit control performance and the rate of false-positive maneuvers.

Conjunctions are constantly reevaluated within this "collision avoidance time horizon" to determine if the maneuver criteria are met. Prior to the collision avoidance time horizon, the satellite only plans maneuvers to track to its reference trajectory in a closed-loop fashion. Within the collision avoidance time horizon, the orbit control burn plan becomes static, and collision avoidance maneuver planning takes over. With the exception of late-notice changes to predictions, collision avoidance maneuvers are generally planned at or shortly after the collision avoidance time horizon. Collision avoidance maneuvers may consist of one of several types: new maneuvers that are added to the maneuver plan, modifications to existing planned maneuvers (including existing orbit control maneuvers or previously-planned collision avoidance maneuvers), or cancellations of existing planned maneuvers.

### Ducking ​

In addition to collision avoidance maneuvers, satellites slew to reduce their exposed cross-sectional area at the time of closest approach. These "ducking" slews are planned at more conservative thresholds than collision avoidance maneuvers — generally one order of magnitude lower in Pc than the typical maneuver planning threshold, with expanded miss-distance-based criteria — and require even less lead time to execute if necessary. Collision avoidance maneuvers are planned entirely separately from ducking slews; the maneuvers are planned as if the ducking slew will not occur, and then the slew is planned and executed as an additional layer of risk mitigation.

Ducking slews present a powerful means of residual risk reduction for Starlink satellites owing to their flat form factor, which achieves a significant reduction in exposed area, and therefore a comparable reduction in collision probability. These are especially important in the presence of large secondary positional uncertainty or inaccurate secondary predictions — even if it is impractical or impossible to dodge the secondary's true state owing to degraded external prediction accuracy, ducking slews are able to reduce residual collision likelihood.

Illustration of a Starlink satellite "duck," in which it lowers its solar array and yaws to reduce exposed area in the conjunction plane.

## Off-Nominal Considerations ​

### Non-Maneuverable Satellites ​

Some Starlink satellites may be non-maneuverable and unable to mitigate conjunctions. The maneuverability status of Starlink satellites is updated publicly every hour both on Space-Safety.com and on Space-Track.org. If a Starlink is marked non-maneuverable, it is not capable of taking maneuver responsibility and its automated collision avoidance is not active. Starlink asks that operators take responsibility for conjunctions with non-maneuverable Starlink satellites, but a Starlink operator will also reach out to coordinate for such conjunctions directly. Because the relevant satellites are non-maneuverable, radar-based predictions may be used for collision avoidance in these cases — but where available, Starlink still recommends using Starlink owner/operator ephemerides instead as they are more accurate in essentially all circumstances.

### Dead Satellites ​

A small number of Starlink satellites are dead on-orbit and permanently unable to communicate with the ground. Even for these satellites, Starlink publishes owner/operator ephemeris using the Stargaze tracking system, which is often more reliable than radar predictions for these satellites on short horizons. These satellites fall into the same triage scheme described below. An operator monitors dead Starlink conjunctions and reaches out to initiate maneuver coordination by third parties where applicable.

### Unmitigated conjunction triage ​

In the event that a Starlink satellite will be unable to reduce collision probability below 1e-5 — or increase miss distance beyond the  [±100, ±1500, ±1500]  m RTN threshold — for any reason, a Starlink operator is alerted and subsequently triages all such cases with a human in the loop. Most frequently this applies to non-maneuverable satellites without automatic onboard collision avoidance. As such, assuming an actionable conjunction exists and is sufficiently near in the future so as to be considered for real-time collision avoidance, one of the following will always be true: either the Starlink in question will autonomously perform a collision avoidance maneuver for the conjunction, or a Starlink operator will be alerted to take action manually. Triage for non-maneuverable or otherwise hindered satellites begins 48 hours prior to the conjunction (or as soon as the data indicates an event will be high-risk), not at Starlink's typical 6-12 hour collision avoidance maneuver time horizons.

In such cases, the Starlink operator will coordinate with the operator of the secondary satellite, but also is able to employ one or more methods to address the conjunction on the Starlink side. In the event that the satellite underwent a transient off-nominal event (e.g., a radiation upset), the operator will take steps to restore the satellite to nominal operation so as to enable an autonomous collision avoidance maneuver to be performed. In the event that the satellite is in a permanently degraded state, the operator can resolve the conjunction via other means, such as a differential drag maneuver. In the rare event that a Starlink satellite is entirely unable to mitigate risk for a conjunction, Starlink will ask that the other operator take maneuver responsibility during the process of coordination.

## FAQ ​

### I have a conjunction with a Starlink satellite. What should I do? ​

Starlink collision avoidance is autonomous and Starlink satellites assume maneuver responsibility by default. As such, considerations for maneuver coordination are different from what may be typical for other operators.

Please note that Starlink will receive screening for ephemeris files submitted to Space-Track as long as your screening results are not configured to be private and the submissions are "operational" rather than "special". Furthermore, submitting your ephemerides directly to Space-Safety.com allows for even lower-latency real-time screening. Ephemerides with realistic covariance information are preferred, but Starlink satellites are able to maneuver against ephemerides submitted without covariance information by using miss distance criteria.

In the absence of a specific coordination agreement, a Starlink operator will reach out to coordinate conjunctions with non-maneuverable Starlink satellites as long as your contact information is available.

### When will Starlink satellites take action to mitigate upcoming conjunctions? ​

Starlink satellites mitigate conjunctions starting at 12 hours prior to TCA (station-keeping satellites) or 6 hours prior to TCA (orbit-raising or orbit-lowering satellites). Starlink satellites will continuously evaluate the need to maneuver for conjunctions within that time span prior to TCA if state estimates from either the Starlink or the secondary object change. When the Starlink satellite plans a collision avoidance maneuver (or modifies/cancels an existing maneuver), it will do so taking into account all upcoming conjunctions, using all secondary state sources evaluated against its own propagations from its onboard GNSS filter. Starlink satellites generally mitigate conjunctions above 3e-7 Pc or within a  [±100, ±1500, ±1500]  m RTN volume of the secondary object at TCA.

It is possible to confirm that a maneuver has been planned to avoid a conjunction by checking published predictions once within the applicable time horizon. Operators should add some margin to allow the predictions to percolate from the satellite through to Space-Safety.com — 2-3 hours should generally suffice. Note that Space-Track only screens Starlink ephemerides every 8 hours, so an interested party should look to Space-Safety.com or publicly-hosted ephemerides at starlink.com for maneuver confirmation instead of Space-Track screening results, particularly given Starlink's 6-12 hour collision avoidance maneuver planning time horizon. Specifically, for a Starlink satellite using a 12-hour horizon, it will typically be possible to confirm it planned a collision avoidance maneuver (for example, by checking updated Pc estimates or for any new maneuvers or maneuver modifications in Starlink OCMs) around 9-10 hours prior to TCA. For a Starlink satellite using a 6-hour horizon, confirmation is typically possible around 3-4 hours prior to TCA.
