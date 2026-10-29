<!-- source: https://space-safety.starlink.com/docs/api/create-an-operator -->

# Create an operator

```
POST https://space-safety.starlink.com/api/v1/operator
```

Create an operator. Only available internally to system administrators.

## Request ​

- application/json

### Body
**required**

Object

- email string
- max_objects integer required Required on create and update. Only a system administrator may change this from the operator's current value.
- name string
- phone string

## Responses ​

- 201
- 400

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

- curl
- python

- CURL

```
curl --key client.key --cert client.crt -L -X POST 'https://space-safety.starlink.com/api/v1/operator' \-H 'Content-Type: application/json' \-H 'Accept: application/json' \--data-raw '{  "email": "string",  "max_objects": 0,  "name": "string",  "phone": "string"}'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Body required

```
{
  "email": "string",
  "max_objects": 0,
  "name": "string",
  "phone": "string"
}
```
