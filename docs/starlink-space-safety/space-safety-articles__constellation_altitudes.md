<!-- source: https://space-safety.starlink.com/docs/space-safety-articles/constellation_altitudes -->

# Starlink Constellation Altitudes

This document is intended to provide information and context to satellite operators about Starlink constellation design. Altitude-based deconfliction is the strongest lever to avoid risk between two constellations, so knowledge of Starlink constellation altitudes can help support safe and sustainable satellite operations in low-Earth orbit. Starlink strongly encourages other operators to analyze the background object density when choosing altitudes for satellite operations, including insertion orbits, and proactively share ephemeris for conjunction screening. Starlink takes the secondary density of objects in low-Earth orbit into strong consideration when designing shells and selecting altitudes, both for permanent shells as well as for temporary waypoints and insertion orbits. Starlink has pursued altitudes that are deconflicted against the highest-density altitudes for other spacecraft operators and the wide altitude bands inhabited by the crewed stations while still meeting constellation objectives.

This information reflects the current Starlink constellation and near-term constellation management. Starlink regularly refines its constellation management strategy due to changing conditions subject to the limits of our licenses, so the information on this page may be out of date. Please reach out directly to Starlink operators at [starlink-constellation-inquiries@spacex.com](mailto:starlink-constellation-inquiries@spacex.com) for the most up to date understanding of constellation management and future plans.

## Overview ​

The Starlink constellation is organized into multiple orbital shells, with the majority of satellites concentrated at specific altitudes. Within these shells, satellites maintain precise positioning through daily stationkeeping burns that tightly constrain radial offset and along-track spacing under normal conditions. The constellation is deliberately designed to minimize its overall altitude footprint, thereby reducing potential overlap with other operators. By the end of 2026, Starlink satellites will occupy two primary altitude ranges:

1. V1 and V2 broadband satellites occupying altitudes between 450km and 490km
2. V1 direct-to-cell (DTC) and V3 broadband satellites occupying altitudes between 330km and 370km.

These two altitude ranges are visualized below in terms of geocentric altitude versus geocentric latitude. The two crewed stations are not plotted directly, but their historical altitude ranges can be found publicly. Note that future Starlink altitude ranges and visualization of the 330km - 370km range are subject to change.

## Detailed Shell Information ​

To operate dense constellations in self-consistent, deconflicted geometries, Starlink organizes its satellites into distinct shells differentiated primarily by altitude and inclination. A constellation shell is defined as a fixed set of passively deconflicted orbits at a common altitude and inclination, providing a long-term home for satellites while they deliver user service. The full list of operational constellation shells planned by the end of 2026 appears below.

In addition, Starlink uses a variety of lower-density temporary waypoints to support constellation operations. A waypoint is a transient orbit employed during satellite transfers to establish broad deconfliction with crewed stations and other Starlink satellites, while also aligning the orbital elements required to target a precise slot in the satellite’s final destination shell.

Note that Starlink shells have varying degrees of eccentricity such that the mean semi-major axis altitude corresponds to a range of altitudes. The distance in mean semi-major axis is not a good indicator of radial spacing between shells when two different inclinations are compared.

| Description | Mean semi-major axis altitude (km) | Inclination (deg) |
| --- | --- | --- |
| V1 + V2 Broadband | 485km | 43deg |
| 472.5km | 70deg |  |
| 462.5km | 97.3deg |  |
| 463km | 53deg |  |
| V1 DTC | 360km | 53deg |
| 358.5km | 43deg |  |
| V3 Broadband | 330km-360km | TBD |

Starlink is currently in the process of lowering its satellites from their initial operational altitudes above 500km mean semi-major axis altitude. Starlink's current plan is to complete shell lowering by end-of-year 2026, so the shells related to the remaining satellites above 500km are not listed for clarity.

Through late 2026 and 2027, Starlink plans to launch future vehicles to the region from 330km to 360km. Starlink will adjust the designs of new shells in these altitudes over time as more satellites are launched to integrate within the existing direct-to-cell constellation.

## Starlink Lifecycle Overview ​

The overall lifecycle of a Starlink satellite can be split into many distinct segments:

- Within days after insertion from the launch vehicle, Starlink satellites begin raising their altitude - the raise timing and raise rate is heavily dependent on the current atmospheric density
- As they raise, Starlink satellites utilize multiple waypoints at different altitudes to enable deconfliction against the crewed stations and to align to their final shell destinations
- Upon reaching their operational altitudes, Starlink satellites are designed to serve for 5+ years
- Starlink satellites are triggered for deorbit on a per-satellite basis based on vehicle health metrics
- Each satellite has a different deorbit trajectory based on the unique capability of that satellite - some deorbit faster or slower than others
- Upon reaching a prescribed low altitude, Starlink satellites target their re-entry location over open ocean ( link )

## Starlink Shell Lowering Through 2026 ​

Starlink is in the process of lowering all of its satellites to below 500km altitude. Operating at a lower altitude will enable a higher degree of safety - enabling a >80% reduction in ballistic decay time in solar minimum, reducing 4+ years to a few months. While the vast majority of Starlink satellites deorbit propulsively, there are rare hardware degradations that may prevent propulsive deorbit. The image below depicts the difference in predicted ballistic demise time beginning in 2028 in a p50 atmosphere for a sun-synchronous (~97deg inclination) satellite from the altitude as of May 2026 versus the final altitude that will be achieved by end-of-year 2026.

The above constellation design reflects the final outcome after shell lowering at end-of-year 2026, but Starlink expects to continue lowering satellites from previous orbits >500km to populate these constellation shells through the year. Please reach out to Starlink operators at [starlink-constellation-inquiries@spacex.com](mailto:starlink-constellation-inquiries@spacex.com) for additional details and information about ongoing lowering efforts.
