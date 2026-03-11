#!/usr/bin/env python3
"""
Preprocess DIGGS XML into SQLite database.

Single .db file replaces:
  - Large .db.json (no need to load entire file for one borehole)
  - borehole_dataset/*.json (no per-borehole files)

Usage:
  python tools/preprocess_diggs_to_sqlite.py <input.xml> [output.db]
  - input: DIGGS XML file
  - output: SQLite path (default: .diggs_cache/<xml_base>.db)

After running, the app uses SQLite automatically. No reorganize step needed.
"""
import sys
import os
import json
import sqlite3
import argparse
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.preprocess_diggs_to_db import preprocess_diggs_to_db


def _create_schema(conn: sqlite3.Connection):
    """Create SQLite schema with indexes for fast location_id lookups."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value_text TEXT,
            value_real REAL,
            value_int INTEGER
        );
        CREATE TABLE IF NOT EXISTS locations (
            id TEXT PRIMARY KEY,
            name TEXT,
            feature_type TEXT,
            latitude REAL,
            longitude REAL,
            elevation REAL,
            total_depth TEXT,
            total_depth_uom TEXT,
            project_ref TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_locations_id ON locations(id);

        CREATE TABLE IF NOT EXISTS project_info (
            id TEXT PRIMARY KEY,
            info_json TEXT
        );

        CREATE TABLE IF NOT EXISTS lithology_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id TEXT NOT NULL,
            depth_from REAL,
            depth_to REAL,
            legend_code TEXT,
            classification_name TEXT,
            description TEXT,
            pi TEXT,
            fc REAL,
            FOREIGN KEY (location_id) REFERENCES locations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_lithology_location ON lithology_intervals(location_id);

        CREATE TABLE IF NOT EXISTS spt_activity_data (
            activity_id TEXT PRIMARY KEY,
            location_id TEXT NOT NULL,
            depth_from REAL,
            depth_to REAL,
            name TEXT,
            background_json TEXT,
            FOREIGN KEY (location_id) REFERENCES locations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_spt_location ON spt_activity_data(location_id);

        CREATE TABLE IF NOT EXISTS cpt_test_data (
            test_id TEXT PRIMARY KEY,
            location_id TEXT NOT NULL,
            depths_json TEXT,
            qc_json TEXT,
            fs_json TEXT,
            u2_json TEXT,
            units_json TEXT,
            background_json TEXT,
            FOREIGN KEY (location_id) REFERENCES locations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_cpt_location ON cpt_test_data(location_id);

        CREATE TABLE IF NOT EXISTS location_tests (
            location_id TEXT PRIMARY KEY,
            spt_tests_json TEXT,
            cpt_tests_json TEXT,
            FOREIGN KEY (location_id) REFERENCES locations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_location_tests_id ON location_tests(location_id);

        CREATE TABLE IF NOT EXISTS location_stats (
            location_id TEXT PRIMARY KEY,
            spt_count INTEGER,
            cpt_count INTEGER,
            vs_count INTEGER,
            FOREIGN KEY (location_id) REFERENCES locations(id)
        );
    """)


def write_lithology_to_sqlite(xml_path: str, sqlite_path: str) -> int:
    """
    Extract lithology from XML and write ONLY to lithology_intervals.
    Use when main preprocess has 0 lithology (upload/stream issues).
    Returns count of intervals written.
    """
    from tools.preprocess_diggs_to_db import extract_uscs_lithology
    lithology_uscs = extract_uscs_lithology(xml_path, xml_source=None)
    if not lithology_uscs:
        return 0
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    for col, ctype in [("pi", "TEXT"), ("fc", "REAL"), ("unit_weight", "REAL")]:
        try:
            conn.execute(f"ALTER TABLE lithology_intervals ADD COLUMN {col} {ctype}")
        except sqlite3.OperationalError:
            pass
    conn.execute("DELETE FROM lithology_intervals")
    count = 0
    for loc_id, intervals in lithology_uscs.items():
        if not isinstance(intervals, list):
            continue
        for it in intervals:
            conn.execute(
                """INSERT INTO lithology_intervals (location_id, depth_from, depth_to, legend_code, classification_name, description, pi, fc, unit_weight)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    loc_id,
                    it.get("from"),
                    it.get("to"),
                    it.get("legend_code") or it.get("legendCode"),
                    it.get("classification_name") or it.get("classificationName"),
                    it.get("description"),
                    it.get("pi", "NP"),
                    it.get("fc"),
                    it.get("unit_weight"),
                ),
            )
            count += 1
    conn.commit()
    conn.close()
    return count


def _write_db_to_sqlite(db: dict, sqlite_path: str):
    """Write preprocessed db dict to SQLite."""
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    _create_schema(conn)

    meta = db.get("metadata", {})
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value_text, value_real, value_int) VALUES (?, ?, ?, ?)",
        ("source_file", meta.get("source_file"), None, None),
    )
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value_text, value_real, value_int) VALUES (?, ?, ?, ?)",
        ("generated_at_utc", meta.get("generated_at_utc"), None, None),
    )
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value_text, value_real, value_int) VALUES (?, ?, ?, ?)",
        ("source_mtime", None, meta.get("source_mtime"), None),
    )

    for loc_id, loc in db.get("locations", {}).items():
        conn.execute(
            """INSERT OR REPLACE INTO locations
               (id, name, feature_type, latitude, longitude, elevation, total_depth, total_depth_uom, project_ref)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                loc.get("id") or loc_id,
                loc.get("name"),
                loc.get("feature_type"),
                loc.get("latitude"),
                loc.get("longitude"),
                loc.get("elevation"),
                loc.get("total_depth"),
                loc.get("total_depth_uom"),
                loc.get("project_ref"),
            ),
        )

    for proj_id, proj in db.get("project_info", {}).items():
        conn.execute(
            "INSERT OR REPLACE INTO project_info (id, info_json) VALUES (?, ?)",
            (proj_id, json.dumps(proj, ensure_ascii=False)),
        )

    # Ensure pi, fc, unit_weight columns exist (for DBs created before this change)
    for col, ctype in [("pi", "TEXT"), ("fc", "REAL"), ("unit_weight", "REAL")]:
        try:
            conn.execute(f"ALTER TABLE lithology_intervals ADD COLUMN {col} {ctype}")
        except sqlite3.OperationalError:
            pass
    # Only overwrite lithology when db has it; otherwise leave for write_lithology_to_sqlite (avoids empty overwrite)
    lithology_uscs = db.get("lithology_uscs", {})
    if lithology_uscs:
        conn.execute("DELETE FROM lithology_intervals")
        for loc_id, intervals in lithology_uscs.items():
            if not isinstance(intervals, list):
                continue
            for it in intervals:
                conn.execute(
                    """INSERT INTO lithology_intervals (location_id, depth_from, depth_to, legend_code, classification_name, description, pi, fc, unit_weight)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        loc_id,
                        it.get("from"),
                        it.get("to"),
                        it.get("legend_code") or it.get("legendCode"),
                        it.get("classification_name") or it.get("classificationName"),
                        it.get("description"),
                        it.get("pi", "NP"),
                        it.get("fc"),
                        it.get("unit_weight"),
                    ),
                )

    for aid, spt in db.get("spt_activity_data_by_id", {}).items():
        bg = spt.get("background") or {}
        conn.execute(
            """INSERT OR REPLACE INTO spt_activity_data (activity_id, location_id, depth_from, depth_to, name, background_json)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                aid,
                spt.get("location_id"),
                spt.get("depth_from"),
                spt.get("depth_to"),
                spt.get("name"),
                json.dumps(bg, ensure_ascii=False) if bg else None,
            ),
        )

    for tid, cpt in db.get("cpt_test_data_by_id", {}).items():
        conn.execute(
            """INSERT OR REPLACE INTO cpt_test_data
               (test_id, location_id, depths_json, qc_json, fs_json, u2_json, units_json, background_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                tid,
                cpt.get("location_id"),
                json.dumps(cpt.get("depths") or [], ensure_ascii=False),
                json.dumps(cpt.get("qc") or [], ensure_ascii=False),
                json.dumps(cpt.get("fs") or [], ensure_ascii=False),
                json.dumps(cpt.get("u2") or [], ensure_ascii=False),
                json.dumps(cpt.get("units") or {}, ensure_ascii=False),
                json.dumps(cpt.get("background") or {}, ensure_ascii=False),
            ),
        )

    for loc_id, tests in db.get("location_tests", {}).items():
        conn.execute(
            """INSERT OR REPLACE INTO location_tests (location_id, spt_tests_json, cpt_tests_json)
               VALUES (?, ?, ?)""",
            (
                loc_id,
                json.dumps(tests.get("spt_tests", []), ensure_ascii=False),
                json.dumps(tests.get("cpt_tests", []), ensure_ascii=False),
            ),
        )

    for loc_id, stats in db.get("location_stats", {}).items():
        conn.execute(
            """INSERT OR REPLACE INTO location_stats (location_id, spt_count, cpt_count, vs_count)
               VALUES (?, ?, ?, ?)""",
            (
                loc_id,
                stats.get("spt_count", 0),
                stats.get("cpt_count", 0),
                stats.get("vs_count", 0),
            ),
        )

    conn.commit()
    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Preprocess DIGGS XML to SQLite (single file, fast per-borehole queries)"
    )
    base = Path(__file__).resolve().parent.parent
    cache_dir = base / ".diggs_cache"
    parser.add_argument("input", help="DIGGS XML file path")
    parser.add_argument("output", nargs="?", default=None, help="Output SQLite path (default: .diggs_cache/<xml_base>.db)")
    args = parser.parse_args()

    xml_path = Path(args.input)
    if not xml_path.exists():
        print(f"Error: XML file not found: {xml_path}")
        sys.exit(1)

    cache_dir.mkdir(parents=True, exist_ok=True)
    xml_base = xml_path.stem
    sqlite_path = args.output or str(cache_dir / f"{xml_base}.db")

    print(f"Preprocessing {xml_path.name} -> SQLite")
    db = preprocess_diggs_to_db(
        str(xml_path),
        output_path=None,
        save_json=False,
    )

    print(f"  Writing SQLite to {sqlite_path}...")
    _write_db_to_sqlite(db, sqlite_path)
    size_mb = os.path.getsize(sqlite_path) / 1024 / 1024
    print(f"  Done! SQLite size: {size_mb:.2f} MB")
    print(f"\nSummary:")
    print(f"  Locations: {db['metadata']['total_locations']}")
    print(f"  SPT activities: {db['metadata']['total_spt_activities']}")
    print(f"  CPT tests: {db['metadata']['total_cpt_tests']}")
    print(f"\nNo borehole_dataset/*.json needed. App will use SQLite for fast queries.")


if __name__ == "__main__":
    main()
