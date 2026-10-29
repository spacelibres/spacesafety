<!-- source: https://space-safety.starlink.com/docs/api/get-a-trajectory-file -->

# Get a trajectory file

```
GET https://space-safety.starlink.com/api/v1/trajectory/:id
```

Get trajectory file by ID.

By default (reference_frame=original), the file is returned in the same format as uploaded by the operator.

If reference_frame is itrf or eme2000, position/velocity and covariance are converted and the output is an OEM file. File comments, and some metadata fields, may be lost in the process.

## Request ​

### Path Parameters

**id**  stringrequired

Trajectory UUID

### Query Parameters

**reference_frame**  string

**Possible values:** [`original`, `itrf`, `eme2000`]

The reference frame the file should be in. Default: original.

## Responses ​

- 200
- 400
- 404

OK

- text/plain

- Schema

**Schema**

string

Bad Request

- text/plain

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

- text/plain

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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/trajectory/:id' \-H 'Accept: text/plain'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired

reference_frame — query
---originalitrfeme2000
