"""
DIGGS borehole/sounding API routes.
"""
import os
import re
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify

from utils.diggs_helpers import (
    safe_xml_path,
    load_diggs_db,
    load_diggs_db_raw,
    convert_db_to_map_format,
    build_lithology_rows_for_import,
)

diggs_bp = Blueprint('diggs', __name__, url_prefix='/api/diggs')


def _is_visible_xml_name(name: str) -> bool:
    """Hide macOS sidecar/resource XML files such as ._foo.xml."""
    if not name:
        return False
    n = os.path.basename(str(name).strip())
    if not n:
        return False
    if not n.lower().endswith(".xml"):
        return False
    if n.startswith(".") or n.startswith("._"):
        return False
    if "/._" in n or "\\._" in n:
        return False
    return True


@diggs_bp.route('/preload-db', methods=['POST'])
def diggs_preload_db():
    """Preload DIGGS db into memory so borehole_detail is instant."""
    try:
        data = request.json or {}
        xml_file = data.get("xml_file", "DIGGS_Student_Hackathon_large.XML")
        xml_path = safe_xml_path(xml_file)
        if not xml_path:
            return jsonify({"status": "error", "message": f"XML not found: {xml_file}"}), 404
        db = load_diggs_db(xml_path)
        return jsonify({
            "status": "success",
            "data": {"loaded": db is not None, "message": "DB ready" if db else "No .db cache"},
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@diggs_bp.route('/cache-status', methods=['GET'])
def diggs_cache_status():
    """Check if DIGGS cache is ready for fast borehole detail loading."""
    try:
        xml_file = request.args.get("xml_file", "DIGGS_Student_Hackathon_large.XML")
        xml_path = safe_xml_path(xml_file)
        if not xml_path:
            return jsonify({
                "status": "success",
                "data": {
                    "ready": False,
                    "db_exists": False,
                    "xml_exists": False,
                    "message": f"XML file not found: {xml_file}",
                },
            })
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cache_dir = os.path.join(base_dir, ".diggs_cache")
        xml_base = os.path.splitext(os.path.basename(xml_path))[0]
        db_path = os.path.join(cache_dir, f"{xml_base}.db")
        db_exists = os.path.isfile(db_path)
        ready = db_exists
        msg = "Cache ready for fast import" if ready else "Run: python setup_diggs_cache.py (recommended for large XML)"
        return jsonify({
            "status": "success",
            "data": {
                "ready": ready,
                "db_exists": db_exists,
                "xml_exists": True,
                "message": msg,
            },
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@diggs_bp.route('/clear-uploads', methods=['POST'])
def diggs_clear_uploads():
    """Clear all user-uploaded XML files and their SQLite caches. Call on page refresh."""
    try:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        uploads_dir = os.path.join(base_dir, ".diggs_cache", "uploads")
        cache_dir = os.path.join(base_dir, ".diggs_cache")
        removed = 0
        if os.path.isdir(uploads_dir):
            for f in os.listdir(uploads_dir):
                if f.lower().endswith(".xml"):
                    try:
                        os.remove(os.path.join(uploads_dir, f))
                        removed += 1
                    except OSError:
                        pass
        # Remove corresponding .db files (upload_*.db)
        if os.path.isdir(cache_dir):
            for f in os.listdir(cache_dir):
                if f.startswith("upload_") and f.endswith(".db"):
                    try:
                        os.remove(os.path.join(cache_dir, f))
                        removed += 1
                    except OSError:
                        pass
        # Invalidate in-memory caches for removed upload DBs
        try:
            from utils.diggs_helpers import _diggs_db_memory_cache
            keys_to_del = [k for k in _diggs_db_memory_cache if k and "upload_" in os.path.basename(k)]
            for k in keys_to_del:
                del _diggs_db_memory_cache[k]
        except Exception:
            pass
        try:
            import diggs_db
            cache = getattr(diggs_db, "_diggs_cache", {})
            for k in list(cache.keys()):
                if k and "upload_" in os.path.basename(k):
                    del cache[k]
        except Exception:
            pass
        return jsonify({
            "status": "success",
            "data": {"removed": removed, "message": "Uploads cleared"},
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@diggs_bp.route('/list-xml', methods=['GET'])
def diggs_list_xml():
    """Return list of available DIGGS XML files (preset + user uploads)."""
    try:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        preset = [
            "DIGGS_Student_Hackathon_large.XML",
            "2026-DIGGS-Student-Hackathon-V1.XML",
        ]
        result = []
        for name in preset:
            path = os.path.join(base_dir, name)
            if os.path.isfile(path):
                result.append({"name": name, "source": "preset"})
        uploads_dir = os.path.join(base_dir, ".diggs_cache", "uploads")
        if os.path.isdir(uploads_dir):
            for f in sorted(os.listdir(uploads_dir)):
                if _is_visible_xml_name(f):
                    display_name = f
                    m = re.match(r'^upload_\d{8}_\d{6}_(.+)$', f)
                    if m:
                        display_name = m.group(1)
                    result.append({"name": f, "source": "upload", "display_name": display_name})
        return jsonify({"status": "success", "data": {"files": result}})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@diggs_bp.route('/upload-xml', methods=['POST'])
def diggs_upload_xml():
    """Accept multipart DIGGS XML upload, preprocess to SQLite."""
    try:
        if "file" not in request.files:
            return jsonify({"status": "error", "message": "No file in request"}), 400
        f = request.files["file"]
        if not f or not f.filename:
            return jsonify({"status": "error", "message": "No file selected"}), 400
        orig = f.filename
        if not orig.lower().endswith(".xml"):
            return jsonify({"status": "error", "message": "File must be .xml"}), 400
        if not _is_visible_xml_name(orig):
            return jsonify({"status": "error", "message": "Hidden/system XML files (e.g., ._*.xml) are not supported."}), 400
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        uploads_dir = os.path.join(base_dir, ".diggs_cache", "uploads")
        os.makedirs(uploads_dir, exist_ok=True)
        safe_base = re.sub(r"[^\w\-.]", "_", os.path.splitext(orig)[0])[:80]
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        save_name = f"upload_{ts}_{safe_base}.xml"
        xml_path = os.path.abspath(os.path.join(uploads_dir, save_name))
        f.save(xml_path)
        try:
            if hasattr(os, 'sync'):
                os.sync()  # Ensure file is flushed before preprocess
        except OSError:
            pass
        from tools.preprocess_diggs_to_db import preprocess_diggs_to_db
        from tools.preprocess_diggs_to_sqlite import _write_db_to_sqlite, write_lithology_to_sqlite, _create_schema
        import sqlite3
        cache_dir = os.path.join(base_dir, ".diggs_cache")
        xml_base = os.path.splitext(save_name)[0]
        sqlite_path = os.path.abspath(os.path.join(cache_dir, f"{xml_base}.db"))
        # Write lithology FIRST (before preprocess) so it's never missed - preprocess can fail/timeout
        try:
            conn = sqlite3.connect(sqlite_path)
            _create_schema(conn)
            conn.close()
            n = write_lithology_to_sqlite(xml_path, sqlite_path)
            if n > 0:
                print(f"[DIGGS] Upload lithology: wrote {n} intervals")
        except Exception as e:
            print(f"[DIGGS] Upload lithology (pre): {e}")
        db = preprocess_diggs_to_db(xml_path, output_path=None, save_json=False)
        _write_db_to_sqlite(db, sqlite_path)
        return jsonify({
            "status": "success",
            "data": {"filename": save_name, "message": "XML imported. CPT/SPT data ready for Liquefaction and Deep Excavation."},
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@diggs_bp.route('/boreholes', methods=['POST'])
def diggs_boreholes_map():
    """Return map-ready GeoJSON from preprocessed SQLite/DB."""
    try:
        data = request.json or {}
        xml_file = data.get("xml_file", "DIGGS_Student_Hackathon_large.XML")
        xml_path = safe_xml_path(xml_file)
        if not xml_path:
            return jsonify({
                "status": "error",
                "message": f"XML file not found: {xml_file}"
            }), 404

        # For uploads: ALWAYS run write_lithology_to_sqlite (upload flow often misses it; guarantees lithology)
        import diggs_db
        import sqlite3
        if xml_file and xml_file.startswith("upload_") and os.path.isfile(xml_path):
            db_path = diggs_db.get_db_path(xml_path, prefer_sqlite=True)
            if db_path:
                try:
                    conn = sqlite3.connect(db_path)
                    rows = conn.execute("SELECT COUNT(*) FROM lithology_intervals").fetchone()[0]
                    conn.close()
                    # Run lithology write when empty OR when < 10 (likely partial/corrupt)
                    if rows < 10:
                        from tools.preprocess_diggs_to_sqlite import write_lithology_to_sqlite
                        n = write_lithology_to_sqlite(xml_path, db_path)
                        if n > 0:
                            print(f"[DIGGS] Boreholes lithology: wrote {n} intervals")
                            try:
                                from utils import diggs_helpers
                                diggs_helpers._diggs_db_memory_cache.pop(db_path, None)
                            except Exception:
                                pass
                            try:
                                diggs_db._diggs_cache.pop(db_path, None)
                            except Exception:
                                pass
                except Exception as e:
                    print(f"[DIGGS] Lithology rebuild on load failed: {e}")

        db = load_diggs_db(xml_path)
        if not db:
            return jsonify({
                "status": "error",
                "message": "DIGGS database not found. Run: python setup_diggs_cache.py",
            }), 404

        parsed = convert_db_to_map_format(db)
        n = db.get("metadata", {}).get("total_locations", len(db.get("locations", {})))
        print(f"[DIGGS] Loaded from database: {n} locations")

        return jsonify({
            "status": "success",
            "data": {
                "xml_file": os.path.basename(xml_path),
                "geojson": parsed["geojson"],
                "detail_index": parsed.get("detail_index", {}),
                "summary": parsed["summary"],
                "preprocessed": True,
                "from_cache": True,
                "cache_meta": parsed.get("cache_meta", {}),
            }
        })
    except Exception as e:
        return jsonify({"status": "error", "message": f"DIGGS failed: {str(e)}"}), 500


@diggs_bp.route('/test_data', methods=['POST'])
def diggs_test_data():
    """Return detailed test data (CPT or SPT) from preprocessed DB."""
    try:
        data = request.json or {}
        xml_file = data.get("xml_file", "DIGGS_Student_Hackathon_large.XML")
        test_type = data.get("test_type", "").lower()
        test_id = str(data.get("test_id", "")).strip()

        if not test_id:
            return jsonify({"status": "error", "message": "test_id is required"}), 400
        if test_type not in ("cpt", "spt"):
            return jsonify({"status": "error", "message": "test_type must be 'cpt' or 'spt'"}), 400

        xml_path = safe_xml_path(xml_file)
        if not xml_path:
            return jsonify({"status": "error", "message": f"XML file not found: {xml_file}"}), 404

        db = load_diggs_db(xml_path)
        if not db:
            return jsonify({
                "status": "error",
                "message": "DIGGS database not found. Run: python setup_diggs_cache.py",
            }), 404

        if test_type == "cpt":
            cpt_by_id = db.get("cpt_test_data_by_id") or {}
            result = cpt_by_id.get(test_id)
        else:
            spt_by_id = db.get("spt_activity_data_by_id") or {}
            result = spt_by_id.get(test_id)

        if result:
            return jsonify({"status": "success", "data": result})
        return jsonify({"status": "error", "message": f"Test data not found: {test_id}"}), 404
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@diggs_bp.route('/borehole-from-dataset/<borehole_id>')
def diggs_borehole_from_dataset(borehole_id):
    """Serve borehole data from SQLite only."""
    borehole_id = str(borehole_id or "").strip()
    if not borehole_id:
        return jsonify({"status": "error", "message": "borehole_id is required"}), 400
    safe = "".join(c for c in borehole_id if c.isalnum() or c in "_-")
    if safe != borehole_id:
        return jsonify({"status": "error", "message": "Invalid borehole_id"}), 400
    xml_file = request.args.get("xml_file", "DIGGS_Student_Hackathon_large.XML")
    xml_path = safe_xml_path(xml_file)
    if not xml_path:
        return jsonify({"status": "error", "message": f"XML not found: {xml_file}"}), 404
    import diggs_db
    db_path = diggs_db.get_db_path(xml_path, prefer_sqlite=True)
    if db_path:
        db_raw, is_sqlite = load_diggs_db_raw(xml_path)
        if db_raw:
            data = diggs_db.get_borehole_dataset_from_db(db_raw, borehole_id, is_sqlite)
            if data:
                return jsonify({"status": "success", "data": data})
            print(f"[DIGGS] borehole-from-dataset: {borehole_id} not found in db")
    hint = "Run: python setup_diggs_cache.py or python tools/preprocess_diggs_to_sqlite.py <xml>"
    if db_path:
        hint = "Borehole ID may not match. Ensure selected XML matches the preprocessed SQLite file."
    return jsonify({"status": "error", "message": f"Borehole not found: {borehole_id}. {hint}"}), 404


@diggs_bp.route('/borehole_detail', methods=['POST'])
def diggs_borehole_detail():
    """Return preprocessed detail for one DIGGS borehole/sounding ID."""
    try:
        data = request.json or {}
        xml_file = data.get("xml_file", "DIGGS_Student_Hackathon_large.XML")
        feature_id = str(data.get("feature_id", "")).strip()
        if not feature_id:
            return jsonify({"status": "error", "message": "feature_id is required"}), 400

        xml_path = safe_xml_path(xml_file)
        if not xml_path:
            return jsonify({
                "status": "error",
                "message": f"XML file not found: {xml_file}"
            }), 404

        import diggs_db
        db_raw, is_sqlite = load_diggs_db_raw(xml_path)
        if not db_raw:
            return jsonify({
                "status": "error",
                "message": "DIGGS database not found. Run: python setup_diggs_cache.py",
            }), 404

        detail = None
        from_cache = True
        if is_sqlite:
            detail = diggs_db.get_borehole_detail_from_db(db_raw, feature_id, True)
            # If no lithology for this borehole, rebuild (handles upload + preset with missing lithology)
            needs_rebuild = (
                detail
                and not (detail.get("lithology_uscs") or [])
                and xml_path
                and os.path.isfile(xml_path)
            )
            if needs_rebuild:
                try:
                    from tools.preprocess_diggs_to_sqlite import write_lithology_to_sqlite
                    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                    cache_dir = os.path.join(base_dir, ".diggs_cache")
                    xml_base = os.path.splitext(xml_file)[0]
                    sqlite_path = os.path.abspath(os.path.join(cache_dir, f"{xml_base}.db"))
                    if xml_path and os.path.isfile(xml_path) and os.path.isfile(sqlite_path):
                        n = write_lithology_to_sqlite(xml_path, sqlite_path)
                        if n > 0:
                            # Invalidate caches and refetch
                            try:
                                from utils import diggs_helpers
                                for k in list(getattr(diggs_helpers, "_diggs_db_memory_cache", {}).keys()):
                                    if k and "upload_" in os.path.basename(str(k)):
                                        del diggs_helpers._diggs_db_memory_cache[k]
                            except Exception:
                                pass
                            try:
                                for k in list(getattr(diggs_db, "_diggs_cache", {}).keys()):
                                    if k and "upload_" in os.path.basename(str(k)):
                                        del diggs_db._diggs_cache[k]
                            except Exception:
                                pass
                            db_raw, _ = load_diggs_db_raw(xml_path)
                            if db_raw:
                                detail = diggs_db.get_borehole_detail_from_db(db_raw, feature_id, True)
                except Exception as e:
                    print(f"[DIGGS] Rebuild lithology failed: {e}")
        else:
            converted = convert_db_to_map_format(db_raw)
            detail_index = converted.get("detail_index") or {}
            detail = detail_index.get(feature_id)
        if not detail:
            return jsonify({
                "status": "error",
                "message": f"feature_id not found: {feature_id}"
            }), 404

        detail["lithology_uscs"] = detail.get("lithology_uscs") or []

        try:
            detail["lithology_rows_for_import"] = build_lithology_rows_for_import(
                None, feature_id, detail.get("lithology_uscs") or []
            )
        except Exception:
            detail["lithology_rows_for_import"] = []

        try:
            if not is_sqlite and db_raw:
                spt_by_id = db_raw.get("spt_activity_data_by_id") or {}
                cpt_by_id = db_raw.get("cpt_test_data_by_id") or {}
                spt_ids = [x if isinstance(x, str) else (x.get("activity_id") or x.get("id")) for x in (detail.get("all_spt_tests") or [])]
                cpt_ids = [x if isinstance(x, str) else (x.get("test_id") or x.get("id")) for x in (detail.get("all_cpt_tests") or [])]
                detail["preprocessed_spt_data"] = [spt_by_id[i] for i in spt_ids if i and i in spt_by_id]
                detail["preprocessed_cpt_data"] = [cpt_by_id[i] for i in cpt_ids if i and i in cpt_by_id]
        except Exception:
            pass

        if is_sqlite:
            pre = detail.get("preprocessed_spt_data") or []
            spt_by_id = {s.get("activity_id") or s.get("id"): s for s in pre if s}
        else:
            spt_by_id = (db_raw or {}).get("spt_activity_data_by_id") or {}
        if is_sqlite:
            pre = detail.get("preprocessed_cpt_data") or []
            cpt_by_id = {c.get("test_id") or c.get("id"): c for c in pre if c}
        else:
            cpt_by_id = (db_raw or {}).get("cpt_test_data_by_id") or {}
        spt_tests_with_background = []
        cpt_tests_with_background = []

        all_spt_tests = detail.get("all_spt_tests", [])
        for spt_test in all_spt_tests:
            if isinstance(spt_test, str):
                test_id = spt_test
                test_obj = {"activity_id": test_id, "id": test_id}
            else:
                test_id = spt_test.get("activity_id") or spt_test.get("id") if isinstance(spt_test, dict) else None
                test_obj = spt_test if isinstance(spt_test, dict) else {"activity_id": str(spt_test), "id": str(spt_test)}
            if test_id:
                spt_data = spt_by_id.get(str(test_id)) if spt_by_id else None
                spt_test_with_bg = {
                    **test_obj,
                    "background": (spt_data or {}).get("background", {})
                }
                spt_tests_with_background.append(spt_test_with_bg)
            else:
                spt_tests_with_background.append(test_obj)

        all_cpt_tests = detail.get("all_cpt_tests", [])
        for cpt_test in all_cpt_tests:
            if isinstance(cpt_test, str):
                test_id = cpt_test
                test_obj = {"test_id": test_id, "id": test_id}
            else:
                test_id = cpt_test.get("test_id") or cpt_test.get("id") if isinstance(cpt_test, dict) else None
                test_obj = cpt_test if isinstance(cpt_test, dict) else {"test_id": str(cpt_test), "id": str(cpt_test)}
            if test_id:
                cpt_data = cpt_by_id.get(str(test_id)) if cpt_by_id else None
                cpt_test_with_bg = {
                    **test_obj,
                    "background": (cpt_data or {}).get("background", {})
                }
                cpt_tests_with_background.append(cpt_test_with_bg)
            else:
                cpt_tests_with_background.append(test_obj)

        detail["all_spt_tests"] = spt_tests_with_background
        detail["all_cpt_tests"] = cpt_tests_with_background

        return jsonify({
            "status": "success",
            "data": {
                "xml_file": os.path.basename(xml_path),
                "feature_id": feature_id,
                "from_cache": from_cache,
                "detail": detail
            }
        })
    except Exception as e:
        return jsonify({"status": "error", "message": f"DIGGS detail failed: {str(e)}"}), 500
