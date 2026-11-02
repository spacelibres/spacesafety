# Objects

An object is the satellite a trajectory belongs to. Everything in the API hangs
off one.

## Fields

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Assigned on creation |
| `object_name` | string | Display name; used by filters and the event stream |
| `norad_id` | integer | Optional. Present when the object has a catalogue number |
| `operator_id` | uuid | Who owns it. Set by the certificate, not by the body |
| `hard_body_radius` | number (km) | **Required, must be > 0** |
| `maneuverability` | boolean | Whether it can be manoeuvred |
| `alive` | boolean | Whether it is still operating |

## Hard-body radius is not decoration

The radius is what turns a miss distance into a probability: Pc is the chance that
the two hard bodies overlap, so a zero radius makes Pc identically zero and a
wrong radius scales every probability. Report the real cross-sectional extent of
the object, in kilometres — the same unit the screening kernel uses.

## Using the filters

```bash
# All objects of one operator, paged by offset
curl --key client.key --cert client.crt \
  'https://<host>/api/v1/object?operator_id=<uuid>&limit=50&offset=0'

# One object by catalogue number
curl --key client.key --cert client.crt 'https://<host>/api/v1/object?norad_id=45414'
```

`object_name` matches the whole value (ASCII case-insensitively); it is not a
substring search. A filter value that is not a valid integer, e.g.
`norad_id=abc`, is a `400`, not a silently empty list.

## Quota

Each operator has `max_objects`. Creating beyond it fails with `400`. The quota
exists because object count is what drives screening cost.

## Common mistakes

| Mistake | What happens |
|---|---|
| `hard_body_radius: 0` | Accepted, and every Pc against it is 0 forever |
| Creating a second object for the same satellite | Allowed — two objects are two identities; screening treats them independently |
| Expecting `object_name` to search substrings | It does not; whole value only |
| Reading another operator's object | `404`, not `403` — existence is not disclosed |
