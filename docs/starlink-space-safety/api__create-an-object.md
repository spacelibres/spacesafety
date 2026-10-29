<!-- source: https://space-safety.starlink.com/docs/api/create-an-object -->

# Create an object

```
POST https://space-safety.starlink.com/api/v1/object
```

Create an object. Once an object is created, new trajectories for this object may be created.

## Request ​

- application/json

### Body
**required**

Object

- hard_body_radius number required Possible values: <= 512 Hard body radius of the object in meters
- maneuverability boolean
- norad_id int nullable
- object_name string required Possible values: <= 256 characters
- operator_id uuid required

## Responses ​

- 201
- 400
- 404

Object UUID

- application/json

- Schema
- Example (from schema)

**Schema**

- id uuid

```
{  "id": "550e8400-e29b-41d4-a716-446655440000"}
```

Bad Request

- application/json

- Schema
- Example (from schema)

**Schema**

- correlation_id string
- error string
- error_type string
- metadata

```
{  "correlation_id": "string",  "error": "string",  "error_type": "string",  "metadata": {}}
```

Not Found

- application/json

- Schema
- Example (from schema)

**Schema**

- correlation_id string
- error string
- error_type string
- metadata

```
{  "correlation_id": "string",  "error": "string",  "error_type": "string",  "metadata": {}}
```

- curl
- python

- CURL

```
curl --key client.key --cert client.crt -L -X POST 'https://space-safety.starlink.com/api/v1/object' \-H 'Content-Type: application/json' \-H 'Accept: application/json' \--data-raw '{  "hard_body_radius": 0,  "maneuverability": true,  "norad_id": 0,  "object_name": "string",  "operator_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"}'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Body required

```
{
  "hard_body_radius": 0,
  "maneuverability": true,
  "norad_id": 0,
  "object_name": "string",
  "operator_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"
}
```
