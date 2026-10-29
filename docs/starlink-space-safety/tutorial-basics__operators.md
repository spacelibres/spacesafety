<!-- source: https://space-safety.starlink.com/docs/tutorial-basics/operators -->

# Operators

An operator is an entity that operates satellites in orbit. Operators in our system may be populated based on users that are submitting ephemerides to the platform, or publicly-available information we have synchronized from other sources.

An operator is identified by a UUID as well as a unique human-readable name. You can view information about your "operator" account on the operator details page:

The top panel contains contact information for an organization if they are using our platform. For your organization, we recommend that you include an email and a phone number so that other operators can contact you for conjunction coordination.

If it is blank, you can update it using the "Edit" button in the upper right corner, or by using the [PATCH /api/v1/operator/:id](https://space-safety.starlink.com/docs/api/update-operator-information) API.

Below that, there is a table containing the objects ([docs](https://space-safety.starlink.com/docs/tutorial-basics/objects)) associated with your account, and upcoming conjunction events ([docs](https://space-safety.starlink.com/docs/tutorial-basics/events)) involving those objects.

Below that there is a list of users and API keys associated with your organization.

## Users ​

Users are individuals within an organization that have access to the Space Safety Platform via the web interface. Typically, we allow administrators from an organization to add more users. The total number of users belonging to an organization is capped, contact us if you need that limit to be increased.

## API Keys ​

See the [API keys](https://space-safety.starlink.com/docs/api-keys) page or your original onboarding email for instructions on creating a new API credential.
