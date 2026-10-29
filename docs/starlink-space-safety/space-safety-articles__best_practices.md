<!-- source: https://space-safety.starlink.com/docs/space-safety-articles/best_practices -->

# Space Safety Best Practices

### Satellite Design ​

- Equip satellites with propulsion such that they can perform collision avoidance maneuvers to minimize risk of collision with other objects
- Equip satellites with GNSS receivers so that you are capable of producing high-accuracy state estimates without relying on third-party observations of your satellite.
- Design satellites and your mission to ensure safe end-of-life disposal (see below)

### Ephemeris Sharing ​

- Generate and publish propagated ephemeris and share it with other satellite operators,
- Publish ephemeris frequently, ideally updating them with every ground contact. In LEO, drag is the dominant external source of trajectory uncertainty, and drag fluctuations are difficult to predict.
- Publish covariance with your ephemeris to convey your degree of confidence in your predictions.
- Monitor the quality of your predictions, both in terms of absolute error and in covariance realism (using metrics such as Mahalanobis distance).

### Maneuver Planning ​

- Incorporate upcoming maneuvers into your ephemeris exports, to inform other operators of them before they are executed.
- Continuously monitor predicted vs. executed thrust to ensure that your maneuver predictions align with actual performance.
- Do not tolerate burn failures, which make your ephemeris exports inaccurate. Do not continue to attempt burns using a faulty thruster to compound the error; pause operational burns to troubleshoot if necessary.

### Coordination ​

- Provide accurate contact information for your organization for conjunction coordination on a public platform, such as space-track.org, this platform, or both.
- Provide accurate size and maneuverability status for objects that you own on a public platform.
- Ensure that ephemeris is available on a public platform. It should not be treated as proprietary information, it is critical for safe flight.

### Launch and Early Mission ​

- After launch, work with the US Space Force to accelerate object cataloging, ideally by sharing ephemeris.
- Be cognizant of the Launch COLA GAP . Work with launch providers to launch into low-density altitudes, and plan to share ephemeris as soon as the satellite establishes contact.

### End-of-Life Disposal ​

- Proactively deorbit satellites at end-of-life. Do not leave dead satellites in space.
- Proactively deorbit unhealthy satellites that risk dying on orbit.
