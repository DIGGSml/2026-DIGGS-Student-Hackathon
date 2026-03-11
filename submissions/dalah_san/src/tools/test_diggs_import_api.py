#!/usr/bin/env python3
"""
Test DIGGS import APIs to verify they return data.
Run: python tools/test_diggs_import_api.py

Or with Flask app running: curl the endpoints and inspect.
"""
import os
import sys
import json

# Add parent to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def main():
    from diggs_db import get_db_path
    from tools.reorganize_diggs_to_boreholes import build_borehole_dataset

    xml_name = "DIGGS_Student_Hackathon_large.XML"
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    xml_path = os.path.join(base, xml_name)
    if not os.path.isfile(xml_path):
        print(f"XML not found: {xml_path}")
        return 1

    db_path = get_db_path(xml_path)
    if not db_path:
        print("No .db cache found. Run: python tools/preprocess_diggs_to_sqlite.py <xml>")
        return 1

    is_sqlite = db_path.lower().endswith(".db")
    print(f"Using: {db_path} (SQLite={is_sqlite})")

    if is_sqlite:
        import sqlite3
        conn = __import__("diggs_db")._get_sqlite_conn(db_path)
        if not conn:
            print("Failed to open SQLite")
            return 1
        loc_ids = [r[0] for r in conn.execute("SELECT id FROM locations LIMIT 5").fetchall()]
    else:
        with open(db_path, "r", encoding="utf-8") as f:
            db = json.load(f)
        loc_ids = list(db.get("locations", {}).keys())[:5]

    print(f"\nSample location IDs: {loc_ids}")

    # Test get_borehole_dataset_from_db
    from diggs_db import get_borehole_dataset_from_db, load_diggs_db
    db_raw, is_sqlite = load_diggs_db(xml_path, prefer_sqlite=True)
    if not db_raw:
        print("Failed to load db")
        return 1

    for loc_id in loc_ids:
        data = get_borehole_dataset_from_db(db_raw, loc_id, is_sqlite)
        if data:
            layers = data.get("layers", [])
            spt_raw = data.get("spt_raw", [])
            cpt = data.get("cpt")
            print(f"\n{loc_id}: layers={len(layers)}, spt_raw={len(spt_raw)}, cpt={'yes' if cpt else 'no'}")
            if layers:
                print(f"  First layer: depth {layers[0].get('depth_from')}-{layers[0].get('depth_to')}, spt_n={layers[0].get('spt_n')}")
            if spt_raw:
                print(f"  First SPT: depth {spt_raw[0].get('depth_from')}-{spt_raw[0].get('depth_to')}, spt_n={spt_raw[0].get('spt_n')}")
            if cpt:
                print(f"  CPT: depths={len(cpt.get('depths', []))}, qc={len(cpt.get('qc', []))}")
        else:
            print(f"\n{loc_id}: NO DATA")

    print("\nDone. If layers/spt_raw/cpt are empty, the import will have nothing to show.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
