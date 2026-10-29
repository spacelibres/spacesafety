<!-- source: https://space-safety.starlink.com/docs/api/update-an-object -->

# Update an object

```
PATCH https://space-safety.starlink.com/api/v1/object/:id
```

Update an object's properties.

## Request ​

### Path Parameters

**id**  stringrequired

Object UUID

- application/json

### Body
**required**

Object

- alive boolean The object is actively communicating with a ground service
- hard_body_radius number Hard body radius of the object in meters
- maneuverability boolean
- norad_id int nullable
- object_name string

## Responses ​

- 200
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
curl --key client.key --cert client.crt -L -X PATCH 'https://space-safety.starlink.com/api/v1/object/:id' \-H 'Content-Type: application/json' \-H 'Accept: application/json' \--data-raw '{  "alive": true,  "hard_body_radius": 0,  "maneuverability": true,  "norad_id": 0,  "object_name": "string"}'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired

Body required

```
{
  "alive": true,
  "hard_body_radius": 0,
  "maneuverability": true,
  "norad_id": 0,
  "object_name": "string"
}
```
