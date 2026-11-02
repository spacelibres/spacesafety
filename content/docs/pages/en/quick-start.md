# Quick-start guide

The API answers over HTTPS and identifies you by **client certificate**. Every
request needs the same pair of files; there is no bearer token to fetch first.

```bash
curl --key client.key --cert client.crt \
  -H 'Accept: application/json' \
  'https://<host>/api/v1/operator'
```

Until a certificate is presented, every endpoint answers `401 RBAC: access denied`.
See [API keys and identity](/docs/api-keys).

## 1 · Find the operator you write under

```bash
curl --key client.key --cert client.crt 'https://<host>/api/v1/operator'
```

`id` is what every object and trajectory is scoped to. On this deployment the
list is short — it holds what operators have registered here, not a public
registry.

## 2 · Create an object

An object is the satellite a trajectory belongs to. `hard_body_radius` is
required and must be greater than zero: it is the radius used to compute
collision probability, and a zero radius makes Pc identically zero.

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/object' \
  -H 'Content-Type: application/json' \
  -d '{"object_name":"STARLINK-1309","hard_body_radius":0.00413,"norad_id":45414,"maneuverability":true}'
```

The response is `{ "id": "<uuid>" }`.

## 3 · Upload a trajectory

The body is the ephemeris text. CCSDS **OEM**, CCSDS **OCM** and the Starlink
modified **ITC** are accepted; the format is detected from the content, not
declared. `upload_type` decides whether it screens.

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/trajectory' \
  -H 'Content-Type: application/json' \
  -d '{
    "object_id": "<uuid>",
    "upload_type": "definitive",
    "state_source": "operator_ephemeris",
    "file": "<contents of ephemeris.oem>"
  }'
```

Validation is strict and it tells you why: a rejected file returns one entry per
problem, e.g. `{"field":"file","reason":"at least 6 state vectors are required (got 2)"}`.

## 4 · Watch the screening status

```bash
curl --key client.key --cert client.crt 'https://<host>/api/v1/trajectory/<uuid>/metadata'
```

`screened_status` moves from `not_screened` through the screening run. The six
possible values are listed in [Trajectories](/docs/tutorial-basics/trajectories).

## 5 · Read the CDMs

`GET /api/v2/cdm` is the stream to poll. At least one of `operator1_id`,
`trajectory_id`, `object1_id` is required — an unfiltered poll over every CDM in
the system is not offered.

```bash
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?trajectory_id=<uuid>&only_active=true'
```

Responses carry `{ "result": [...], "token": "..." }`. Pass `token` back to get
the next page; a response whose `token` you never use is simply a page you did
not read. See [API patterns](/docs/api-patterns).

## Where to go next

| You want to | Read |
|---|---|
| Understand what a CDM contains | [CDMs](/docs/tutorial-basics/cdms) |
| Know how events are grouped | [Conjunction events](/docs/tutorial-basics/events) |
| Pick a polling cadence | [Best practices](/docs/space-safety-articles/best_practices) |
| Look up one endpoint exactly | [API reference](/docs/api/get-cd-ms) |
