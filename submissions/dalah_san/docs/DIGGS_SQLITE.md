# DIGGS XML → SQLite

How DIGGS XML is cached as SQLite for fast queries. Single source of truth for structure and pipeline.

## Why SQLite

- Avoid re-parsing XML on every request.
- Fast per-borehole lookups by `location_id`.
- Cache path: `.diggs_cache/<xml_stem>.db`.

## Pipeline (2 steps)

```
XML file → preprocess_diggs_to_db() → in-memory db dict
       → _write_db_to_sqlite(db, path) → .diggs_cache/<xml_stem>.db
```

1. **preprocess_diggs_to_db** (`tools/preprocess_diggs_to_db.py`): Multi-pass parse of XML → dict with `metadata`, `locations`, `lithology_uscs`, `spt_activity_data_by_id`, `cpt_test_data_by_id`, `location_tests`, `location_stats`, `project_info`.
2. **_write_db_to_sqlite** (`tools/preprocess_diggs_to_sqlite.py`): Creates schema, then writes each dict key into the matching table.

If lithology is missing after step 2 (e.g. upload/stream), call **write_lithology_to_sqlite(xml_path, sqlite_path)** to refill only `lithology_intervals` from XML.

## Tables (actual schema)

| Table | Content |
|-------|--------|
| metadata | key/value: source_file, generated_at_utc, source_mtime |
| locations | id, name, feature_type, lat, lon, elevation, total_depth, project_ref |
| project_info | id, info_json |
| lithology_intervals | location_id, depth_from, depth_to, legend_code, classification_name, description, pi, fc, unit_weight |
| spt_activity_data | activity_id, location_id, depth_from, depth_to, name, background_json |
| cpt_test_data | test_id, location_id, depths_json, qc_json, fs_json, u2_json, units_json, background_json |
| location_tests | location_id, spt_tests_json, cpt_tests_json |
| location_stats | location_id, spt_count, cpt_count, vs_count |

Indexes on `locations(id)`, `lithology_intervals(location_id)`, `spt_activity_data(location_id)`, `cpt_test_data(location_id)` for fast lookups.

## Mapping (XML → db key → table)

| Source | db key | Table |
|--------|--------|--------|
| Project, roles | project_info | project_info |
| Borehole/Sounding | locations | locations |
| LithologySystem (USCS) | lithology_uscs | lithology_intervals |
| SPT SamplingActivity + Test | spt_activity_data_by_id | spt_activity_data |
| CPT Test | cpt_test_data_by_id | cpt_test_data |
| Per-location test lists | location_tests | location_tests |
| Per-location counts | location_stats | location_stats |
| File/mtime/counts | metadata | metadata |


