"""
DIGGS database access layer - SQLite only.

Usage:
  - Preprocess XML to SQLite: python tools/preprocess_diggs_to_sqlite.py <input.xml>
  - App reads only from .diggs_cache/<xml_base>.db (no JSON backend).
"""
import os
import json
import sqlite3
from typing import Optional, Dict, Any, List

# In-memory cache: {db_path: (mtime, conn_or_db)}
_diggs_cache = {}


def _get_cache_dir():
    """Return .diggs_cache directory path."""
    base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, ".diggs_cache")


def get_db_path(xml_path: str, prefer_sqlite: bool = True) -> Optional[str]:
    """
    Resolve SQLite database path for a given XML file.
    Returns path to .diggs_cache/<xml_base>.db only. No JSON fallback.
    """
    if not xml_path or not os.path.isfile(xml_path):
        return None
    base_dir = os.path.dirname(os.path.abspath(__file__))
    cache_dir = os.path.join(base_dir, ".diggs_cache")
    xml_base = os.path.splitext(os.path.basename(xml_path))[0]
    sqlite_path = os.path.join(cache_dir, f"{xml_base}.db")
    return sqlite_path if os.path.isfile(sqlite_path) else None


def _get_sqlite_conn(db_path: str):
    """Get SQLite connection (cached by path)."""
    try:
        mtime = os.path.getmtime(db_path)
        cached = _diggs_cache.get(db_path)
        if cached and cached[0] == mtime and cached[1] is not None:
            return cached[1]
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        _diggs_cache[db_path] = (mtime, conn)
        return conn
    except Exception:
        return None


def _is_sqlite(path: str) -> bool:
    return path.lower().endswith(".db") and not path.lower().endswith(".db.json")


# --- SQLite query helpers ---

def _sqlite_get_location(conn, location_id: str) -> Optional[Dict]:
    row = conn.execute(
        "SELECT id, name, feature_type, latitude, longitude, elevation, total_depth, total_depth_uom, project_ref FROM locations WHERE id = ?",
        (location_id,),
    ).fetchone()
    if not row:
        return None
    return dict(row)


def _sqlite_get_lithology_from_cpt_ic(conn, location_id: str) -> List[Dict]:
    """For CPT/Sounding (no LithologySystem in XML): derive lithology from CPT Ic (2-5 ft intervals, mode soil class)."""
    from utils.cpt_ic_lithology import derive_lithology_from_cpt

    cpt_list = _sqlite_get_cpt_for_location(conn, location_id)
    if not cpt_list:
        return []
    # Use first CPT test
    cpt = cpt_list[0]
    depths = cpt.get("depths") or []
    qc = cpt.get("qc") or []
    fs = cpt.get("fs") or []
    u2 = cpt.get("u2") or []
    if not depths or not qc or not fs:
        return []
    units = cpt.get("units") or {}
    depth_uom = (units.get("depth") or units.get("Depth") or "ft").strip().lower()
    depth_unit = "m" if depth_uom.startswith("m") else "ft"
    qc_fs_raw = (units.get("qc") or units.get("fs") or units.get("cone_resistance") or units.get("sleeve_friction") or "kPa").strip().lower()
    qc_fs_unit = "MPa" if "mpa" in qc_fs_raw else ("tsf" if any(x in qc_fs_raw for x in ("tsf", "tonf", "ton/f", "ft2")) else "kPa")
    ic_layers = derive_lithology_from_cpt(
        depths=depths, qc=qc, fs=fs, u2=u2 if u2 else None,
        interval_ft=3.0, depth_unit=depth_unit, qc_fs_unit=qc_fs_unit
    )
    out = []
    for lit in ic_layers:
        sc = lit.get("soil_class") or lit.get("legend_code") or "SM"
        out.append({
            "from": lit["from"],
            "to": lit["to"],
            "legend_code": sc,
            "legendCode": sc,
            "classification_name": sc,
            "classificationName": sc,
            "soil_class": sc,
            "description": "",
        })
    return out


def _sqlite_get_lithology(conn, location_id: str) -> List[Dict]:
    try:
        rows = conn.execute(
            "SELECT depth_from, depth_to, legend_code, classification_name, description, pi, fc, unit_weight FROM lithology_intervals WHERE location_id = ? ORDER BY depth_from",
            (location_id,),
        ).fetchall()
    except sqlite3.OperationalError:
        try:
            rows = conn.execute(
                "SELECT depth_from, depth_to, legend_code, classification_name, description, pi, fc FROM lithology_intervals WHERE location_id = ? ORDER BY depth_from",
                (location_id,),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = conn.execute(
                "SELECT depth_from, depth_to, legend_code, classification_name, description FROM lithology_intervals WHERE location_id = ? ORDER BY depth_from",
                (location_id,),
            ).fetchall()
    out = []
    col_names = list(rows[0].keys()) if rows and len(rows) > 0 else []
    has_pi = "pi" in col_names
    has_fc = "fc" in col_names
    has_unit_weight = "unit_weight" in col_names
    for r in rows:
        d = {
            "from": r["depth_from"],
            "to": r["depth_to"],
            "legend_code": r["legend_code"] or "",
            "legendCode": r["legend_code"] or "",
            "classification_name": r["classification_name"] or "",
            "classificationName": r["classification_name"] or "",
            "description": r["description"] or "",
        }
        if has_pi and r["pi"] is not None:
            d["pi"] = r["pi"]
        if has_fc and r["fc"] is not None:
            d["fc"] = r["fc"]
        if has_unit_weight and r["unit_weight"] is not None:
            d["unit_weight"] = r["unit_weight"]
        out.append(d)
    return out


def _sqlite_get_spt_for_location(conn, location_id: str) -> List[Dict]:
    rows = conn.execute(
        "SELECT activity_id, location_id, depth_from, depth_to, name, background_json FROM spt_activity_data WHERE location_id = ? ORDER BY depth_from",
        (location_id,),
    ).fetchall()
    out = []
    for r in rows:
        bg = {}
        if r["background_json"]:
            try:
                bg = json.loads(r["background_json"])
            except Exception:
                pass
        out.append({
            "activity_id": r["activity_id"],
            "location_id": r["location_id"],
            "depth_from": r["depth_from"],
            "depth_to": r["depth_to"],
            "name": r["name"] or "",
            "background": bg,
        })
    return out


def _sqlite_get_cpt_for_location(conn, location_id: str) -> List[Dict]:
    rows = conn.execute(
        "SELECT test_id, location_id, depths_json, qc_json, fs_json, u2_json, units_json, background_json FROM cpt_test_data WHERE location_id = ?",
        (location_id,),
    ).fetchall()
    out = []
    for r in rows:
        def _parse_json(s):
            if not s:
                return [] if "depths" in str(r.keys()) else {}
            try:
                return json.loads(s)
            except Exception:
                return [] if "depths" in str(r.keys()) else {}

        out.append({
            "test_id": r["test_id"],
            "location_id": r["location_id"],
            "depths": _parse_json(r["depths_json"]),
            "qc": _parse_json(r["qc_json"]),
            "fs": _parse_json(r["fs_json"]),
            "u2": _parse_json(r["u2_json"]),
            "units": _parse_json(r["units_json"]) if r["units_json"] else {},
            "background": _parse_json(r["background_json"]) if r["background_json"] else {},
        })
    return out


def _sqlite_get_location_tests(conn, location_id: str) -> Dict:
    row = conn.execute(
        "SELECT spt_tests_json, cpt_tests_json FROM location_tests WHERE location_id = ?",
        (location_id,),
    ).fetchone()
    if not row:
        return {"spt_tests": [], "cpt_tests": []}
    spt = []
    cpt = []
    if row["spt_tests_json"]:
        try:
            spt = json.loads(row["spt_tests_json"])
        except Exception:
            pass
    if row["cpt_tests_json"]:
        try:
            cpt = json.loads(row["cpt_tests_json"])
        except Exception:
            pass
    return {"spt_tests": spt, "cpt_tests": cpt}


def _sqlite_get_all_location_ids(conn) -> List[str]:
    rows = conn.execute("SELECT id FROM locations ORDER BY id").fetchall()
    return [r["id"] for r in rows]


def _sqlite_get_locations_for_geojson(conn) -> List[Dict]:
    """Get all locations with coordinates for map."""
    rows = conn.execute(
        "SELECT id, name, feature_type, latitude, longitude, elevation, total_depth, total_depth_uom, project_ref FROM locations WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
    ).fetchall()
    return [dict(r) for r in rows]


def _sqlite_get_project_info(conn) -> Dict:
    rows = conn.execute("SELECT id, info_json FROM project_info").fetchall()
    return {r["id"]: json.loads(r["info_json"]) if r["info_json"] else {} for r in rows}


# --- Public API ---

def load_diggs_db(xml_path: str, prefer_sqlite: bool = True):
    """
    Load DIGGS database (SQLite only). Returns (conn, True) or (None, False).
    """
    db_path = get_db_path(xml_path, prefer_sqlite=prefer_sqlite)
    if not db_path:
        return None, False
    conn = _get_sqlite_conn(db_path)
    return (conn, True) if conn else (None, False)


def _resolve_location_id(conn, location_id: str) -> Optional[str]:
    """
    Resolve location_id to the actual id stored in locations table.
    Handles both "B-01" and "Location_B-01" formats (DIGGS XML may use either).
    """
    loc = _sqlite_get_location(conn, location_id)
    if loc:
        return location_id
    if not location_id.startswith("Location_"):
        loc = _sqlite_get_location(conn, f"Location_{location_id}")
        if loc:
            return f"Location_{location_id}"
    else:
        alt = location_id[9:]  # strip "Location_"
        loc = _sqlite_get_location(conn, alt)
        if loc:
            return alt
    return None


def get_borehole_detail_from_db(db_or_conn, feature_id: str, is_sqlite: bool) -> Optional[Dict]:
    """
    Get borehole detail for borehole_detail API.
    Returns dict with all_spt_tests, all_cpt_tests, lithology_uscs, preprocessed_spt_data, preprocessed_cpt_data, etc.
    """
    if is_sqlite:
        conn = db_or_conn
        resolved_id = _resolve_location_id(conn, feature_id)
        if not resolved_id:
            return None
        loc = _sqlite_get_location(conn, resolved_id)
        if not loc:
            return None
        lithology = _sqlite_get_lithology(conn, resolved_id)
        if not lithology:
            alt_id = f"Location_{resolved_id}" if not resolved_id.startswith("Location_") else resolved_id[9:]
            lithology = _sqlite_get_lithology(conn, alt_id)
        if not lithology and loc.get("feature_type") == "Sounding":
            lithology = _sqlite_get_lithology_from_cpt_ic(conn, resolved_id)
        tests = _sqlite_get_location_tests(conn, resolved_id)
        project_info = _sqlite_get_project_info(conn)
        project_ref = loc.get("project_ref", "")
        project_id = project_ref[1:] if project_ref.startswith("#") else project_ref
        project = project_info.get(project_id, {})
        spt_ids = tests.get("spt_tests", [])
        cpt_ids = tests.get("cpt_tests", [])
        spt_list = _sqlite_get_spt_for_location(conn, resolved_id)
        cpt_list = _sqlite_get_cpt_for_location(conn, resolved_id)
        spt_by_id = {s["activity_id"]: s for s in spt_list}
        cpt_by_id = {c["test_id"]: c for c in cpt_list}
        return {
            "description": "",
            "location_description": "",
            "purpose": "",
            "project_info": project,
            "all_cpt_tests": cpt_ids,
            "all_spt_tests": spt_ids,
            "lithology_uscs": lithology,
            "preprocessed_spt_data": [spt_by_id[i] for i in spt_ids if i in spt_by_id],
            "preprocessed_cpt_data": [cpt_by_id[i] for i in cpt_ids if i in cpt_by_id],
        }
    else:
        return None


def get_borehole_dataset_from_db(db_or_conn, location_id: str, is_sqlite: bool) -> Optional[Dict]:
    """
    Get borehole dataset (layers, spt_raw, cpt) for borehole-from-dataset API.
    SQLite only.
    """
    def _try_float(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def _parse_n_value(raw):
        if raw is None:
            return None
        if isinstance(raw, (int, float)):
            return float(raw)
        s = str(raw).strip()
        if not s:
            return None
        if "-" in s:
            parts = [p.strip() for p in s.split("-", 1)]
            try:
                return (float(parts[0]) + float(parts[1])) / 2.0
            except (TypeError, ValueError):
                return None
        s = s.replace(">", "").replace("<", "").strip()
        try:
            return float(s)
        except (TypeError, ValueError):
            return None

    def _match_spt_n_for_layer(layer_from, layer_to, spt_rows):
        mid = (layer_from + layer_to) / 2.0
        best = None
        best_dist = 1e18
        for s in spt_rows:
            df = _try_float(s.get("depth_from"))
            dt = _try_float(s.get("depth_to"))
            if df is None or dt is None:
                continue
            s_mid = (df + dt) / 2.0
            overlaps = (layer_from <= s_mid <= layer_to) or (df <= mid <= dt) or (not (layer_to <= df or dt <= layer_from))
            if not overlaps:
                continue
            dist = abs(s_mid - mid)
            if dist < best_dist:
                best_dist = dist
                best = _parse_n_value((s.get("background") or {}).get("nValue") or s.get("nValue"))
        return best

    if not (is_sqlite and db_or_conn):
        return None

    conn = db_or_conn
    resolved_id = _resolve_location_id(conn, location_id)
    if not resolved_id:
        return None

    loc = _sqlite_get_location(conn, resolved_id)
    if not loc:
        return None

    tests = _sqlite_get_location_tests(conn, resolved_id)
    spt_ids = tests.get("spt_tests", []) or []
    cpt_ids = tests.get("cpt_tests", []) or []

    spt_list = _sqlite_get_spt_for_location(conn, resolved_id)
    cpt_list = _sqlite_get_cpt_for_location(conn, resolved_id)
    spt_by_id = {s.get("activity_id"): s for s in spt_list if s.get("activity_id")}
    cpt_by_id = {c.get("test_id"): c for c in cpt_list if c.get("test_id")}

    ordered_spt = [spt_by_id[i] for i in spt_ids if i in spt_by_id]
    ordered_spt += [s for s in spt_list if s.get("activity_id") not in set(spt_ids)]
    ordered_cpt = [cpt_by_id[i] for i in cpt_ids if i in cpt_by_id]
    ordered_cpt += [c for c in cpt_list if c.get("test_id") not in set(cpt_ids)]

    lithology = _sqlite_get_lithology(conn, resolved_id)
    if not lithology:
        alt_id = f"Location_{resolved_id}" if not resolved_id.startswith("Location_") else resolved_id[9:]
        lithology = _sqlite_get_lithology(conn, alt_id)
    if not lithology and loc.get("feature_type") == "Sounding":
        lithology = _sqlite_get_lithology_from_cpt_ic(conn, resolved_id)

    layers = []
    if lithology:
        for lit in lithology:
            d_from = _try_float(lit.get("from"))
            d_to = _try_float(lit.get("to"))
            if d_from is None or d_to is None:
                continue
            soil_class = (lit.get("legend_code") or lit.get("legendCode") or lit.get("classification_name") or "").strip()
            n_value = _match_spt_n_for_layer(d_from, d_to, ordered_spt)
            layers.append({
                "depth_from": d_from,
                "depth_to": d_to,
                "soil_class": soil_class,
                "soil_type": (lit.get("classification_name") or lit.get("classificationName") or soil_class).strip(),
                "spt_n": n_value,
                "pi": lit.get("pi", "NP") if lit.get("pi", "NP") is not None else "NP",
                "fc": lit.get("fc"),
                "unit_weight_tf_m3": lit.get("unit_weight"),
            })
        layers.sort(key=lambda r: (r.get("depth_from", 0.0), r.get("depth_to", 0.0)))
    elif ordered_spt:
        for s in ordered_spt:
            d_from = _try_float(s.get("depth_from"))
            d_to = _try_float(s.get("depth_to"))
            if d_from is None or d_to is None:
                continue
            layers.append({
                "depth_from": d_from,
                "depth_to": d_to,
                "soil_class": "",
                "soil_type": "",
                "spt_n": _parse_n_value((s.get("background") or {}).get("nValue") or s.get("nValue")),
                "pi": (s.get("background") or {}).get("pi", "NP"),
                "fc": (s.get("background") or {}).get("fc"),
                "unit_weight_tf_m3": None,
            })
        layers.sort(key=lambda r: (r.get("depth_from", 0.0), r.get("depth_to", 0.0)))

    spt_raw = []
    for s in ordered_spt:
        spt_raw.append({
            "depth_from": s.get("depth_from"),
            "depth_to": s.get("depth_to"),
            "spt_n": _parse_n_value((s.get("background") or {}).get("nValue") or s.get("nValue")),
            "pi": (s.get("background") or {}).get("pi", "NP"),
            "fc": (s.get("background") or {}).get("fc"),
        })

    cpt = None
    if ordered_cpt:
        first = ordered_cpt[0]
        cpt = {
            "test_id": first.get("test_id"),
            "depths": first.get("depths", []),
            "qc": first.get("qc", []),
            "fs": first.get("fs", []),
            "u2": first.get("u2", []),
            "units": first.get("units", {}),
        }
        if len(ordered_cpt) > 1:
            cpt["note"] = "First of multiple CPT tests - ordered by location_tests table."

    return {
        "borehole_id": resolved_id,
        "borehole_name": loc.get("name", resolved_id),
        "location": {
            "latitude": loc.get("latitude"),
            "longitude": loc.get("longitude"),
            "elevation": loc.get("elevation"),
            "total_depth": loc.get("total_depth"),
            "total_depth_uom": loc.get("total_depth_uom", "ft"),
        },
        "layers": layers,
        "cpt": cpt,
        "spt_raw": spt_raw,
    }


def get_full_db_for_convert(db_or_conn, is_sqlite: bool) -> Optional[Dict]:
    """
    Get full db dict for _convert_db_to_map_format (GeoJSON, detail_index).
    For SQLite we build a minimal dict; for JSON we return as-is.
    """
    if not is_sqlite:
        return db_or_conn
    conn = db_or_conn
    locations = {}
    for row in conn.execute("SELECT * FROM locations").fetchall():
        locations[row["id"]] = dict(row)
    lithology_uscs = {}
    try:
        lith_rows = conn.execute(
            "SELECT location_id, depth_from, depth_to, legend_code, classification_name, description, pi, fc, unit_weight FROM lithology_intervals"
        ).fetchall()
    except sqlite3.OperationalError:
        try:
            lith_rows = conn.execute(
                "SELECT location_id, depth_from, depth_to, legend_code, classification_name, description, pi, fc FROM lithology_intervals"
            ).fetchall()
        except sqlite3.OperationalError:
            lith_rows = conn.execute(
                "SELECT location_id, depth_from, depth_to, legend_code, classification_name, description FROM lithology_intervals"
            ).fetchall()
    for row in lith_rows:
        lid = row["location_id"]
        if lid not in lithology_uscs:
            lithology_uscs[lid] = []
        d = {
            "from": row["depth_from"],
            "to": row["depth_to"],
            "legend_code": row["legend_code"] or "",
            "classification_name": row["classification_name"] or "",
        }
        if "pi" in row.keys() and row["pi"] is not None:
            d["pi"] = row["pi"]
        if "fc" in row.keys() and row["fc"] is not None:
            d["fc"] = row["fc"]
        if "unit_weight" in row.keys() and row["unit_weight"] is not None:
            d["unit_weight"] = row["unit_weight"]
        lithology_uscs[lid].append(d)

    # CPT/Sounding locations have no LithologySystem in XML; derive from CPT Ic (2-5 ft intervals, mode soil class)
    for lid, loc in locations.items():
        if lithology_uscs.get(lid):
            continue
        if loc.get("feature_type") != "Sounding":
            continue
        lithology_uscs[lid] = _sqlite_get_lithology_from_cpt_ic(conn, lid)

    location_tests = {}
    for row in conn.execute("SELECT location_id, spt_tests_json, cpt_tests_json FROM location_tests").fetchall():
        spt = json.loads(row["spt_tests_json"]) if row["spt_tests_json"] else []
        cpt = json.loads(row["cpt_tests_json"]) if row["cpt_tests_json"] else []
        location_tests[row["location_id"]] = {"spt_tests": spt, "cpt_tests": cpt}
    location_stats = {}
    for lid in locations:
        lt = location_tests.get(lid, {})
        location_stats[lid] = {
            "spt_count": len(lt.get("spt_tests", [])),
            "cpt_count": len(lt.get("cpt_tests", [])),
            "vs_count": 0,
        }
    spt_data = []
    cpt_data = []
    for row in conn.execute("SELECT activity_id, location_id, name FROM spt_activity_data").fetchall():
        spt_data.append({"activity_id": row["activity_id"], "location_id": row["location_id"], "name": row["name"] or ""})
    for row in conn.execute("SELECT test_id, location_id FROM cpt_test_data").fetchall():
        cpt_data.append({"test_id": row["test_id"], "location_id": row["location_id"], "name": ""})
    spt_by_id = {}
    for row in conn.execute("SELECT activity_id, location_id, depth_from, depth_to, name, background_json FROM spt_activity_data").fetchall():
        bg = json.loads(row["background_json"]) if row["background_json"] else {}
        spt_by_id[row["activity_id"]] = {
            "activity_id": row["activity_id"],
            "location_id": row["location_id"],
            "depth_from": row["depth_from"],
            "depth_to": row["depth_to"],
            "name": row["name"] or "",
            "background": bg,
        }
    cpt_by_id = {}
    for row in conn.execute("SELECT test_id, location_id, depths_json, qc_json, fs_json, u2_json, units_json, background_json FROM cpt_test_data").fetchall():
        cpt_by_id[row["test_id"]] = {
            "test_id": row["test_id"],
            "location_id": row["location_id"],
            "depths": json.loads(row["depths_json"]) if row["depths_json"] else [],
            "qc": json.loads(row["qc_json"]) if row["qc_json"] else [],
            "fs": json.loads(row["fs_json"]) if row["fs_json"] else [],
            "u2": json.loads(row["u2_json"]) if row["u2_json"] else [],
            "units": json.loads(row["units_json"]) if row["units_json"] else {},
            "background": json.loads(row["background_json"]) if row["background_json"] else {},
        }
    project_info = _sqlite_get_project_info(conn)
    return {
        "metadata": {
            "total_locations": len(locations),
            "total_spt_activities": len(spt_data),
            "total_cpt_tests": len(cpt_data),
            "total_vs_tests": 0,
        },
        "locations": locations,
        "lithology_uscs": lithology_uscs,
        "location_tests": location_tests,
        "location_stats": location_stats,
        "spt_data": spt_data,
        "cpt_data": cpt_data,
        "spt_activity_data_by_id": spt_by_id,
        "cpt_test_data_by_id": cpt_by_id,
        "project_info": project_info,
    }

