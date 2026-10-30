/**
 * The complete schema, as one idempotent script.
 *
 * Exported because tests kept hand-copying these tables into `:memory:` fixtures
 * and then silently drifted: a column added here was missing there, and the suite
 * failed with `no such column` only at runtime. A fixture that imports this file
 * cannot disagree with the real database.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS stream_seq (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  max_objects INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  common_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  pem TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS credentials_fingerprint_idx ON credentials(fingerprint);
CREATE INDEX IF NOT EXISTS credentials_operator_idx ON credentials(operator_id);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  object_name TEXT NOT NULL,
  norad_id INTEGER,
  hard_body_radius REAL NOT NULL,
  maneuverability INTEGER NOT NULL,
  alive INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_operator_idx ON objects(operator_id);
CREATE INDEX IF NOT EXISTS objects_norad_idx ON objects(norad_id);
CREATE INDEX IF NOT EXISTS objects_name_idx ON objects(object_name);

CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  upload_type TEXT NOT NULL,
  state_source TEXT NOT NULL,
  screened_status TEXT NOT NULL DEFAULT 'not_screened',
  file_format TEXT NOT NULL,
  start_at TEXT,
  end_at TEXT,
  point_count INTEGER NOT NULL DEFAULT 0,
  screened_at TEXT,
  uploaded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  auto_relinquish_pc_threshold REAL,
  seq INTEGER NOT NULL,
  has_covariance INTEGER NOT NULL DEFAULT 0,
  companion_id TEXT
);
CREATE TABLE IF NOT EXISTS trajectory_files (
  trajectory_id TEXT PRIMARY KEY,
  file_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trajectories_object_idx ON trajectories(object_id);
CREATE INDEX IF NOT EXISTS trajectories_operator_idx ON trajectories(operator_id);
CREATE INDEX IF NOT EXISTS trajectories_status_idx ON trajectories(screened_status);
CREATE INDEX IF NOT EXISTS trajectories_seq_idx ON trajectories(seq);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  object1_id TEXT NOT NULL,
  object1_name TEXT NOT NULL,
  object1_maneuverable INTEGER NOT NULL,
  operator1_id TEXT NOT NULL,
  operator1_name TEXT NOT NULL,
  object2_id TEXT NOT NULL,
  object2_name TEXT NOT NULL,
  object2_maneuverable INTEGER NOT NULL,
  operator2_id TEXT NOT NULL,
  operator2_name TEXT NOT NULL,
  claim_status_operator1 TEXT NOT NULL DEFAULT 'none',
  claim_status_operator2 TEXT NOT NULL DEFAULT 'none',
  last_status_update_operator1 TEXT,
  last_status_update_operator2 TEXT,
  first_cdm_tca_gps_nanos TEXT,
  creation_time TEXT NOT NULL,
  updated_time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_obj1_idx ON events(object1_id);
CREATE INDEX IF NOT EXISTS events_obj2_idx ON events(object2_id);
CREATE INDEX IF NOT EXISTS events_op1_idx ON events(operator1_id);
CREATE INDEX IF NOT EXISTS events_op2_idx ON events(operator2_id);

CREATE TABLE IF NOT EXISTS cdms (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  trajectory1_id TEXT NOT NULL,
  trajectory1_source TEXT NOT NULL,
  trajectory1_created_at TEXT,
  object1_id TEXT NOT NULL,
  object1_name TEXT NOT NULL,
  object1_maneuverable INTEGER,
  operator1_id TEXT NOT NULL,
  operator1_name TEXT NOT NULL,
  trajectory2_id TEXT NOT NULL,
  trajectory2_source TEXT NOT NULL,
  trajectory2_created_at TEXT,
  object2_id TEXT NOT NULL,
  object2_name TEXT NOT NULL,
  object2_maneuverable INTEGER,
  operator2_id TEXT NOT NULL,
  operator2_name TEXT NOT NULL,
  probability_of_collision REAL,
  tca_gps_nanos TEXT NOT NULL,
  miss_distance_km REAL,
  total_miss_distance_km REAL,
  relative_speed_km_s REAL,
  rtn_r REAL,
  rtn_t REAL,
  rtn_n REAL,
  cov_xx REAL,
  cov_xy REAL,
  cov_yy REAL,
  file_json TEXT NOT NULL,
  is_hypothetical INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cdms_event_idx ON cdms(event_id);
CREATE INDEX IF NOT EXISTS cdms_traj1_idx ON cdms(trajectory1_id);
CREATE INDEX IF NOT EXISTS cdms_traj2_idx ON cdms(trajectory2_id);
CREATE INDEX IF NOT EXISTS cdms_obj1_idx ON cdms(object1_id);
CREATE INDEX IF NOT EXISTS cdms_obj2_idx ON cdms(object2_id);
CREATE INDEX IF NOT EXISTS cdms_op1_idx ON cdms(operator1_id);
CREATE INDEX IF NOT EXISTS cdms_op2_idx ON cdms(operator2_id);
CREATE INDEX IF NOT EXISTS cdms_tca_idx ON cdms(tca_gps_nanos);
CREATE INDEX IF NOT EXISTS cdms_seq_idx ON cdms(seq);

CREATE TABLE IF NOT EXISTS catalog (
  object_id TEXT NOT NULL,
  state_source TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_id, state_source)
);

CREATE TABLE IF NOT EXISTS screening_jobs (
  id TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL,
  against_trajectory_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  dispatched_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON screening_jobs(status);
CREATE INDEX IF NOT EXISTS jobs_traj_idx ON screening_jobs(trajectory_id);

CREATE TABLE IF NOT EXISTS pagination_tokens (
  token TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  filter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_stream_idx ON pagination_tokens(stream);

CREATE TABLE IF NOT EXISTS satcat (
  norad_id INTEGER PRIMARY KEY,
  entity_id TEXT,
  intl_id TEXT,
  name TEXT NOT NULL,
  object_type TEXT,
  owner TEXT,
  launch_site TEXT,
  launch_date TEXT,
  decay_date TEXT,
  period REAL,
  inclination REAL,
  apogee REAL,
  perigee REAL,
  rcs_size TEXT,
  source_snapshot TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS satcat_name_idx ON satcat(name);
CREATE INDEX IF NOT EXISTS satcat_type_idx ON satcat(object_type);

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  format TEXT NOT NULL,
  credential_env TEXT,
  refresh_minutes INTEGER NOT NULL DEFAULT 120,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_fetches (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- 'ok' (downloaded) | 'unchanged' (304 or identical hash) | 'failed' | 'running'
  status TEXT NOT NULL DEFAULT 'running',
  bytes INTEGER,
  records INTEGER,
  path TEXT,
  sha256 TEXT,
  error TEXT,
  seq INTEGER NOT NULL,
  -- Conditional-request validators, so the next poll can ask "has this changed?"
  -- instead of transferring the body again.
  etag TEXT,
  last_modified TEXT
);
CREATE INDEX IF NOT EXISTS source_fetches_source_idx ON source_fetches(source_id, started_at);
CREATE INDEX IF NOT EXISTS source_fetches_seq_idx ON source_fetches(seq);

CREATE TABLE IF NOT EXISTS object_sources (
  norad_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  epoch TEXT,
  inclination REAL,
  raan REAL,
  eccentricity REAL,
  arg_perigee REAL,
  mean_anomaly REAL,
  mean_motion REAL,
  bstar REAL,
  pos_x REAL,
  pos_y REAL,
  pos_z REAL,
  delta_km REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (norad_id, source_id)
);
CREATE INDEX IF NOT EXISTS object_sources_source_idx ON object_sources(source_id, norad_id);
CREATE INDEX IF NOT EXISTS object_sources_norad_idx ON object_sources(norad_id);

CREATE TABLE IF NOT EXISTS discos_objects (
  discos_id TEXT PRIMARY KEY,
  norad_id INTEGER,
  cospar_id TEXT,
  name TEXT,
  object_class TEXT,
  mission TEXT,
  mass REAL,
  shape TEXT,
  width REAL,
  height REAL,
  depth REAL,
  diameter REAL,
  span REAL,
  x_sect_max REAL,
  x_sect_min REAL,
  x_sect_avg REAL,
  first_epoch TEXT,
  pred_decay_date TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discos_objects_norad_idx ON discos_objects(norad_id);
CREATE INDEX IF NOT EXISTS discos_objects_name_idx ON discos_objects(name);

-- L1: observed, merged. One row per physical object.
CREATE TABLE IF NOT EXISTS master_object (
  norad_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  alias_names TEXT,
  cospar_id TEXT,
  object_class TEXT,
  satcat_type TEXT,
  owner TEXT,
  launch_date TEXT,
  decay_date TEXT,
  mass_kg REAL,
  cross_section_avg_m2 REAL,
  cross_section_max_m2 REAL,
  cross_section_min_m2 REAL,
  shape TEXT,
  status TEXT,
  maneuverable INTEGER NOT NULL DEFAULT 0,
  sources TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  covariance_start TEXT,
  covariance_stop TEXT,
  /* Physical model. mass_kg and cross_section_avg_m2 above are the merged
     best values; these keep the parts that only one source provides. */
  hard_body_radius_m REAL,
  span_m REAL,
  diameter_m REAL,
  dry_mass_kg REAL,
  length_m REAL,
  ballistic_coefficient REAL,
  shape_number INTEGER,
  /* Launch record (McDowell): who built it and what bus it flies on. */
  manufacturer TEXT,
  bus TEXT,
  orbit_type TEXT,
  motor TEXT,
  /* Which source each contested value came from, as JSON: {"mass_kg":"discos",...}.
     A merged value without its provenance cannot be defended against an operator
     who says otherwise. */
  value_sources TEXT,
  merged_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS master_object_name_idx ON master_object(name);
CREATE INDEX IF NOT EXISTS master_object_class_idx ON master_object(object_class);
CREATE INDEX IF NOT EXISTS master_object_status_idx ON master_object(status);

-- L1: which source's element set is canonical for each object.
CREATE TABLE IF NOT EXISTS master_element_set (
  norad_id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  epoch TEXT,
  arc_hours REAL,
  sigma_km REAL,
  alternatives TEXT,
  selected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS master_element_source_idx ON master_element_set(source_id);

-- L2: computed numbers. Never an input.
CREATE TABLE IF NOT EXISTS derived_state (
  norad_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  field TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  method TEXT NOT NULL,
  input_hash TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (norad_id, kind, source_id, field)
);
CREATE INDEX IF NOT EXISTS derived_norad_idx ON derived_state(norad_id, kind);

-- L3: unresolved disagreements.
CREATE TABLE IF NOT EXISTS master_conflict (
  id TEXT PRIMARY KEY,
  norad_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  chosen_value TEXT,
  resolution TEXT NOT NULL,
  reason TEXT,
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conflict_norad_idx ON master_conflict(norad_id);
CREATE INDEX IF NOT EXISTS conflict_field_idx ON master_conflict(field);

-- L0: every value every source gave, whether we chose it or not.
-- Unconditional, unlike master_conflict which records only disagreements we
-- happened to notice. This is what lets a merged value name its origin.
CREATE TABLE IF NOT EXISTS object_field_claim (
  norad_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  source_id TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  source_field TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (norad_id, field, source_id)
);
CREATE INDEX IF NOT EXISTS claim_field_source_idx ON object_field_claim(field, source_id);
CREATE INDEX IF NOT EXISTS claim_source_idx ON object_field_claim(source_id);

-- Physical model from Spacebook's satcat/details feed. 99.98% coverage.
CREATE TABLE IF NOT EXISTS object_physics (
  norad_id INTEGER PRIMARY KEY,
  adopted_mass_kg REAL,
  adopted_span_m REAL,
  adopted_diameter_m REAL,
  ballistic_coefficient REAL,
  hbr_mean_m REAL,
  hbr_median_m REAL,
  hbr_lo_m REAL,
  hbr_hi_m REAL,
  hbr_encap_m REAL,
  cross_section_median_m2 REAL,
  solar_radiation_pressure REAL,
  shape_number INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS object_physics_hbr_idx ON object_physics(hbr_mean_m);

-- Launch and identity metadata (McDowell).
CREATE TABLE IF NOT EXISTS object_launch_info (
  norad_id INTEGER PRIMARY KEY,
  jcat TEXT,
  launch_tag TEXT,
  piece TEXT,
  object_type TEXT,
  payload_name TEXT,
  launch_date TEXT,
  separation_date TEXT,
  decay_date TEXT,
  owner TEXT,
  state TEXT,
  manufacturer TEXT,
  bus TEXT,
  mass_kg REAL,
  dry_mass_kg REAL,
  length_m REAL,
  diameter_m REAL,
  span_m REAL,
  shape TEXT,
  perigee_km REAL,
  apogee_km REAL,
  inclination_deg REAL,
  orbit_type TEXT,
  motor TEXT,
  alt_names TEXT,
  updated_at TEXT NOT NULL
);

-- Space-Track satellite catalogue: the only 100%-complete identity source, and
-- the source of the catalogue orbit summary and launch country.
CREATE TABLE IF NOT EXISTS space_track_satcat (
  norad_id INTEGER PRIMARY KEY,
  intl_des TEXT,
  object_type TEXT,
  sat_name TEXT,
  country TEXT,
  launch TEXT,
  site TEXT,
  decay TEXT,
  period_min REAL,
  inclination_deg REAL,
  apogee_km REAL,
  perigee_km REAL,
  rcs_value REAL,
  rcs_size TEXT,
  current TEXT,
  comment TEXT,
  comment_code TEXT,
  file_ref TEXT,
  launch_year INTEGER,
  launch_num INTEGER,
  launch_piece TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS st_satcat_country_idx ON space_track_satcat(country);
CREATE INDEX IF NOT EXISTS st_satcat_type_idx ON space_track_satcat(object_type);
`;
