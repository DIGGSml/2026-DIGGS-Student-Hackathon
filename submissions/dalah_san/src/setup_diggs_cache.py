#!/usr/bin/env python3
"""
One-click setup for DIGGS pre-built cache (SQLite).
Borehole/SPT/CPT loading reads from .db only; no XML parsing.
Creates .diggs_cache/*.db; subsequent refresh uses SQL only.
"""
import os
import sys

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base_dir)
    
    xml_files = [
        "DIGGS_Student_Hackathon_large.XML",
        "2026-DIGGS-Student-Hackathon-V1.XML",
    ]
    
    sys.path.insert(0, base_dir)
    from tools.preprocess_diggs_to_db import preprocess_diggs_to_db
    from tools.preprocess_diggs_to_sqlite import _write_db_to_sqlite
    
    cache_dir = os.path.join(base_dir, ".diggs_cache")
    os.makedirs(cache_dir, exist_ok=True)
    
    for xml_name in xml_files:
        xml_path = os.path.join(base_dir, xml_name)
        if not os.path.exists(xml_path):
            print(f"  Skip (file not found): {xml_name}")
            continue
        xml_base = os.path.splitext(xml_name)[0]
        sqlite_path = os.path.join(cache_dir, f"{xml_base}.db")
        print(f"  Building SQLite cache: {xml_name} -> .diggs_cache/{xml_base}.db ...")
        try:
            db = preprocess_diggs_to_db(xml_path, output_path=None, save_json=False)
            _write_db_to_sqlite(db, sqlite_path)
            size_mb = os.path.getsize(sqlite_path) / 1024 / 1024
            print(f"  Done: {xml_name} ({size_mb:.2f} MB)")
        except Exception as e:
            print(f"  Failed: {xml_name} - {e}")
    
    print("\nDIGGS SQLite cache setup complete. Refresh will read from .db only.")

if __name__ == "__main__":
    main()
