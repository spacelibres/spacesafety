<!-- source: https://space-safety.starlink.com/docs/api/update-operator-information -->

# Update operator information

```
PATCH https://space-safety.starlink.com/api/v1/operator/:id
```

Update operator information. Name, email, and phone are replaced with the values in the request (omitted fields are written as empty). max_objects is required; only a system administrator may change it from the operator's current value.

## Request ​

### Path Parameters

**id**  stringrequired

operator UUID

- application/json

### Body
**required**

Object

- email string
- max_objects integer required Required on create and update. Only a system administrator may change this from the operator's current value.
- name string
- phone string

## Responses ​

- 200
- 400
- 404

Operator UUID

- application/json

- Schema

**Schema**

string

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
curl --key client.key --cert client.crt -L -X PATCH 'https://space-safety.starlink.com/api/v1/operator/:id' \-H 'Content-Type: application/json' \-H 'Accept: application/json' \--data-raw '{  "email": "string",  "max_objects": 0,  "name": "string",  "phone": "string"}'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired

Body required

```
{
  "email": "string",
  "max_objects": 0,
  "name": "string",
  "phone": "string"
}
```
