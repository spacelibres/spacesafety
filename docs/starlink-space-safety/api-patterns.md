<!-- source: https://space-safety.starlink.com/docs/api-patterns -->

# API Patterns

While the user interface is useful for manually inspecting API data, we encourage all satellite operators to automate their processes for uploading ephemerides and processing CDMs. Fluctuations in atmospheric density are difficult to predict and can cause large changes in a spacecraft's trajectory, even if it is not maneuvering. The easiest way to protect against this risk is to publish ephemerides frequently—ideally, every time a satellite is able to make contact with a ground station and can share an updated estimate of its current position. This is laborious and error-prone if that process requires manual intervention, but automation can reduce this burden and allow operators to focus on their mission.

This section provides code snippets and resources to get started with automated ephemeris submission and conjunction data queries via the API.

## Prerequisites ​

This section assumes you have set up mTLS credentials for your organization, generating a `client.key` and `client.crt` file.

The examples below show how to call the API endpoints using the [curl](https://curl.se/) command-line utility with the `--key` and `--cert` arguments, or the Python [requests](https://requests.readthedocs.io/en/latest/user/advanced/#client-side-certificates) library with client certs.

## Your First API Calls ​

### Get Operator Information ​

The [GET /api/v1/operator](https://space-safety.starlink.com/docs/api/get-all-operators) endpoint allows you to see the contact information of all the operators in the system.

- Python
- cURL

```
import requestss = requests.Session()s.cert = ('path/to/client.crt', 'path/to/client.key')response = s.get('https://staging.space-safety.starlink.com/api/v1/operator', timeout=10.0)
```

```
$ curl --key client.key --cert client.crt -X 'GET' 'https://staging.space-safety.starlink.com/api/v1/operator' -H 'accept: text/plain'
```

### Create an Object ​

The [POST /api/v1/object](https://space-safety.starlink.com/docs/api/create-an-object) endpoint can be used to create a new object associated with your account. You'll need the UUID that is your `operator_id` to create a new object. (in the examples below, `3fa85f64-5717-4562-b3fc-2c963f66afa6`) You'll also have to specify the object's hard-body radius (in meters), maneuverability, its NORAD ID, and a unique name:

- Python
- cURL

```
import requestss = requests.Session()s.cert = ('path/to/client.crt', 'path/to/client.key')params = {  "hard_body_radius": 10,  "maneuverability": True,  "object_name": "MYSAT-1",  "operator_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"}response = s.post('https://staging.space-safety.starlink.com/api/v1/object', json=params, timeout=10.0)
```

```
curl --key client.key --cert client.crt -X 'POST' \  'https://staging.space-safety.starlink.com/api/v1/object' \  -H 'accept: application/json' \  -H 'Content-Type: application/json' \  -d '{  "hard_body_radius": 10,  "maneuverability": true,  "object_name": "MYSAT-1",  "operator_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"}'
```

The response will contain the UUID corresponding to the newly-created object. You can query objects associated with your account using the [GET /api/v1/object](https://space-safety.starlink.com/docs/api/get-all-objects) endpoint.

### Upload a Trajectory ​

Now that you've created an object associated with your account, you can upload a trajectory associated with that object via the [POST /api/v1/trajectory](https://space-safety.starlink.com/docs/api/upload-a-trajectory) endpoint. You'll need a trajectory file in OEM format, the object ID from the previous step (we'll use `4411f40a-6153-4b0b-97d4-fe9e4f59b102` below), and a trajectory type (we'll use "hypothetical" for now, see ["Trajectory Submission Types"](https://space-safety.starlink.com/docs/tutorial-basics/trajectories#trajectory-submission-types) for more information).

Below is a sample OEM file in the proper format. Modify the object name to match your newly-created object, and the timestamps to be in the future:

Sample OEM File

```
CCSDS_OEM_VERS = 3.0CREATION_DATE = 2023-11-06T02:08:15.481374ZORIGINATOR = SPACEX/USA META_STARTOBJECT_NAME = STARLINK-3179OBJECT_ID = 31790CENTER_NAME = EARTHREF_FRAME = ITRFTIME_SYSTEM = UTCSTART_TIME = 2023-11-06T02:09:42.000000ZSTOP_TIME = 2023-11-06T02:15:42.000000ZMETA_STOP 2023-11-06T02:09:42.000000Z -4.542752e+03 -3.316417e+03 3.877276e+03 4.819418e+00 9.779460e-02 5.717377e+002023-11-06T02:10:42.000000Z -4.243593e+03 -3.304426e+03 4.211322e+03 5.149116e+00 3.012760e-01 5.413318e+002023-11-06T02:11:42.000000Z -3.925285e+03 -3.280348e+03 4.526387e+03 5.457463e+00 5.005622e-01 5.084935e+002023-11-06T02:12:42.000000Z -3.589152e+03 -3.244456e+03 4.821057e+03 5.743052e+00 6.949538e-01 4.733722e+002023-11-06T02:13:42.000000Z -3.236600e+03 -3.197065e+03 5.094009e+03 6.004573e+00 8.837872e-01 4.361276e+002023-11-06T02:14:42.000000Z -2.869109e+03 -3.138526e+03 5.344019e+03 6.240812e+00 1.066436e+00 3.969275e+002023-11-06T02:15:42.000000Z -2.488230e+03 -3.069228e+03 5.569967e+03 6.450669e+00 1.242312e+00 3.559489e+00  COVARIANCE_STARTEPOCH = 2023-11-06T02:09:42.000000ZCOV_REF_FRAME = RTN1.000000e+000.000000e+00 1.000000e+020.000000e+00 0.000000e+00 6.400000e-010.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-08EPOCH = 2023-11-06T02:10:42.000000ZCOV_REF_FRAME = RTN1.000000e+000.000000e+00 1.000000e+020.000000e+00 0.000000e+00 6.400000e-010.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-08EPOCH = 2023-11-06T02:11:42.000000ZCOV_REF_FRAME = RTN1.000000e+000.000000e+00 1.000000e+020.000000e+00 0.000000e+00 6.400000e-010.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-08EPOCH = 2023-11-06T02:12:42.000000ZCOV_REF_FRAME = RTN1.000000e+000.000000e+00 1.000000e+020.000000e+00 0.000000e+00 6.400000e-010.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-08EPOCH = 2023-11-06T02:13:42.000000ZCOV_REF_FRAME = RTN1.000000e+000.000000e+00 1.000000e+020.000000e+00 0.000000e+00 6.400000e-010.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-08EPOCH = 2023-11-06T02:14:42.000000ZCOV_REF_FRAME = RTN1.000000e+000.000000e+00 1.000000e+020.000000e+00 0.000000e+00 6.400000e-010.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-08EPOCH = 2023-11-06T02:15:42.000000ZCOV_REF_FRAME = RTN1.000000e+000.000000e+00 1.000000e+020.000000e+00 0.000000e+00 6.400000e-010.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-080.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 0.000000e+00 1.000000e-08COVARIANCE_STOP
```

- Python
- cURL

```
import requestss = requests.Session()s.cert = ('path/to/client.crt', 'path/to/client.key')params = {    'object_id': '4411f40a-6153-4b0b-97d4-fe9e4f59b102',    'file': open(OEM_PATH, 'r').read(),    'upload_type': 'definitive'} response = s.post('https://staging.space-safety.starlink.com/api/v1/trajectory', json=params, timeout=10.0)
```

```
curl \  --cert /path/to/client.crt \  --key /path/to/client.key -X 'POST' 'https://staging.space-safety.starlink.com/api/v1/trajectory' \  -H 'accept: application/json' -H 'Content-Type: application/json' \  -d "{\"file\": \"$(awk '{printf "%s\\n", $0}' /path/to/oem.txt)\", \"object_id\": \"4411f40a-6153-4b0b-97d4-fe9e4f59b102\", \"upload_type\": \"hypothetical\"}"
```

If you receive a `200` or `201` response, that means the system accepted your trajectory!

For more on trajectory requirements, trajectory types, and other optional parameters, see the [Trajectories](https://space-safety.starlink.com/docs/tutorial-basics/trajectories#trajectory-requirements) page

### Query CDMs ​

The [GET /api/v1/trajectory/:id/metadata](https://space-safety.starlink.com/docs/api/show-metadata-for-a-trajectory) API allows you to query the status of your trajectory submission. The `screened_status` field is set to `screened` when your trajectory is screened, typically within a minute or two of submission.

The [GET /api/v1/trajectory/:id/cdms](https://space-safety.starlink.com/docs/api/get-all-cd-ms-related-to-a-trajectory) API allows you to query for any CDMs that have been generated against your trajectory. Note, for a "definitive" trajectory submission, the CDMs returned by this endpoint may change even after your trajectory is screened, because other operators' trajectories are screened against yours in subsequent screening cycles.

Alternatively, you can use the [GET /api/v2/cdm](https://space-safety.starlink.com/docs/api/get-cd-ms) endpoint to continuously query for all the CDMs against your operator. This API, like many of the bulk APIs, uses a "token" that allows you to continuously poll for updates, paginating based on the creation time of the CDM. By re-using the pagination token, even when there are no results, this script will be able retrieve near-real time (<1 minute) any newly created CDMs since the last request. It is recommended to run a stand-alone CDM downloading service, as other operators may update new trajectories even after your trajectory is screened.

```
import requests, times = requests.Session()s.cert = ('path/to/client.crt', 'path/to/client.key')params = {    'operator1_id': 'a39c32fe-0cf0-4593-939e-6b490a7067b3', # NASA CARA    'only_active': True,}while True:  try:      response = s.get('https://staging.space-safety.starlink.com/api/v2/cdm', params=params, timeout=10.0)      response.raise_for_status()      json = response.json()      params['token'] = json['token'] # Paginate based on the CDM creation time      results = json['result'] or []      print(f'Total results found: {len(results)}')      if len(results) < 1000:        print('Sleeping for a minute. Waiting for more CDMs.')        time.sleep(60)  except Exception as e:      print(f'Call to retrieve CDMs returned an exception: {e}')      params.pop('token', None)      time.sleep(60)
```

## Next Steps ​

The next section will give a more in-depth overview into the architecture of the screening service.

The full API specification is available via the [API Reference](https://space-safety.starlink.com/docs/category/api/)
