#!/usr/bin/env python3
"""
Reorganize DIGGS XML into a borehole-based dataset.

Output format per borehole:
  - layers: [{depth_from, depth_to, soil_class, spt_n, pi, fc, unit_weight}]
    - If only one CPT: CPT data represents whole depth (depths, qc, fs, u2)
    - If multiple SPT-N: layers defined by soil type; SPT-N assigned per layer
      (find SPT overlapping layer mid-depth; if multiple, use nearest or average)
  - cpt: {depths, qc, fs, u2} or null
  - spt_raw: original sparse SPT points (for reference)

Usage:
  python tools/reorganize_diggs_to_boreholes.py [input.db.json] [output_dir]
  - input: preprocessed .db.json (default: .diggs_cache/DIGGS_Student_Hackathon_large.db.json)
  - output: directory for per-borehole JSON files (default: ./borehole_dataset/)
"""

import sys
import os
import json
import argparse
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.cpt_ic_lithology import derive_lithology_from_cpt

# Typical unit weight (tf/m³) by USCS - from app.py
_TYPICAL_UNIT_WEIGHT_TF_M3 = {
    "CL": 1.9, "CH": 1.8, "ML": 1.85, "MH": 1.75, "OL": 1.6, "OH": 1.65,
    "SM": 1.9, "SC": 1.95, "SP": 1.7, "SW": 1.8, "SP-SM": 1.8, "SP-SC": 1.85,
    "ML-CL": 1.85, "CL-ML": 1.9, "GP": 1.75, "GW": 1.85, "GM": 1.9, "GC": 1.95,
    "TOPSOIL": 1.7, "SF": 1.85, "GM-GC": 1.9, "GC-GM": 1.95,
}


def _unit_weight_for_uscs(code):
    if not code:
        return None
    c = str(code).strip().upper()
    return _TYPICAL_UNIT_WEIGHT_TF_M3.get(c)


def _find_spt_for_layer(layer_from, layer_to, spt_list):
    """
    Find SPT-N for a lithology layer. Use SPT whose depth range overlaps the layer mid-depth.
    If multiple overlap, return the one whose mid-depth is closest to layer mid.
    Returns: (spt_n, pi, fc) or (None, None, None)
    """
    mid = (layer_from + layer_to) / 2.0
    best = None
    best_dist = 1e9
    for s in spt_list:
        df = s.get("depth_from")
        dt = s.get("depth_to")
        if df is None or dt is None:
            continue
        spt_mid = (float(df) + float(dt)) / 2.0
        # Overlap: layer mid falls within SPT interval, or SPT overlaps layer
        if (layer_from <= spt_mid <= layer_to) or (df <= mid <= dt) or (
            not (layer_to <= df or dt <= layer_from)
        ):
            dist = abs(spt_mid - mid)
            if dist < best_dist:
                best_dist = dist
                nval = (s.get("background") or {}).get("nValue") or s.get("nValue")
                pi = (s.get("background") or {}).get("pi", "NP")
                fc = (s.get("background") or {}).get("fc")
                best = (nval, pi, fc)
    return best if best else (None, None, None)


def build_borehole_dataset(db):
    """
    Build reorganized dataset from preprocessed db.
    Returns: {borehole_id: {layers, cpt, spt_raw, location_info}}
    """
    locations = db.get("locations", {})
    lithology_uscs = db.get("lithology_uscs", {}) or {}
    spt_activity_data_by_id = db.get("spt_activity_data_by_id", {}) or {}
    cpt_test_data_by_id = db.get("cpt_test_data_by_id", {}) or {}
    location_tests = db.get("location_tests", {}) or {}

    result = {}

    for loc_id, loc_info in locations.items():
        loc_name = loc_info.get("name", loc_id)
        spt_ids = (location_tests.get(loc_id) or {}).get("spt_tests", [])
        cpt_ids = (location_tests.get(loc_id) or {}).get("cpt_tests", [])

        spt_list = [spt_activity_data_by_id[a] for a in spt_ids if a in spt_activity_data_by_id]
        spt_list = [s for s in spt_list if s and s.get("depth_from") is not None]

        cpt_list = [cpt_test_data_by_id[t] for t in cpt_ids if t in cpt_test_data_by_id]
        cpt_list = [c for c in cpt_list if c and (c.get("depths") or c.get("qc"))]

        lithology = lithology_uscs.get(loc_id, [])
        if not isinstance(lithology, list):
            lithology = []

        bh_out = {
            "borehole_id": loc_id,
            "borehole_name": loc_name,
            "location": {
                "latitude": loc_info.get("latitude"),
                "longitude": loc_info.get("longitude"),
                "elevation": loc_info.get("elevation"),
                "total_depth": loc_info.get("total_depth"),
                "total_depth_uom": loc_info.get("total_depth_uom", "ft"),
            },
            "layers": [],
            "cpt": None,
            "spt_raw": [],
        }

        # ---- Single CPT: use as whole-depth representation ----
        if len(cpt_list) == 1 and len(spt_list) == 0:
            cpt = cpt_list[0]
            depths = cpt.get("depths") or []
            qc = cpt.get("qc") or []
            fs = cpt.get("fs") or []
            u2 = cpt.get("u2") or []
            bh_out["cpt"] = {
                "test_id": cpt.get("test_id"),
                "depths": depths,
                "qc": qc,
                "fs": fs,
                "u2": u2,
                "units": cpt.get("units", {}),
                "note": "Single CPT - represents whole borehole depth",
            }
            # Derive layers from CPT Ic (2-5 ft intervals, mode soil class)
            units = cpt.get("units") or {}
            depth_uom = (units.get("depth") or units.get("Depth") or "ft").strip().lower()
            depth_unit = "m" if depth_uom.startswith("m") else "ft"
            # CPT qc/fs may be in kPa or tsf; Ic formula expects consistent units - assume kPa
            ic_layers = derive_lithology_from_cpt(
                depths=depths, qc=qc, fs=fs, u2=u2 if u2 else None,
                interval_ft=3.0, depth_unit=depth_unit
            )
            for lit in ic_layers:
                sc = lit.get("soil_class") or lit.get("legend_code") or "SM"
                bh_out["layers"].append({
                    "depth_from": lit["from"],
                    "depth_to": lit["to"],
                    "soil_class": sc,
                    "soil_type": sc,
                    "spt_n": None,
                    "pi": "NP",
                    "fc": None,
                    "unit_weight_tf_m3": _unit_weight_for_uscs(sc),
                })
            bh_out["spt_raw"] = []

        # ---- Multiple SPT (with or without lithology): define layers by soil type ----
        elif spt_list:
            for s in spt_list:
                nval = (s.get("background") or {}).get("nValue") or s.get("nValue")
                pi = (s.get("background") or {}).get("pi", "NP")
                fc = (s.get("background") or {}).get("fc")
                bh_out["spt_raw"].append({
                    "depth_from": s.get("depth_from"),
                    "depth_to": s.get("depth_to"),
                    "spt_n": nval,
                    "pi": pi,
                    "fc": fc,
                })

            if lithology:
                # Use lithology as layer base; assign SPT-N per layer
                for lit in lithology:
                    d_from = lit.get("from")
                    d_to = lit.get("to")
                    if d_from is None or d_to is None:
                        continue
                    try:
                        d_from = float(d_from)
                        d_to = float(d_to)
                    except (TypeError, ValueError):
                        continue
                    soil_class = (lit.get("legend_code") or lit.get("legendCode") or "").strip()
                    soil_type = (lit.get("classification_name") or lit.get("classificationName") or "").strip()
                    unit_w = _unit_weight_for_uscs(soil_class)
                    spt_n, pi_from_spt, fc_from_spt = _find_spt_for_layer(d_from, d_to, spt_list)
                    # Prefer pi, fc from lithology (filled per soil class interval)
                    pi = lit.get("pi") if lit.get("pi") is not None else pi_from_spt
                    fc = lit.get("fc") if lit.get("fc") is not None else fc_from_spt
                    bh_out["layers"].append({
                        "depth_from": d_from,
                        "depth_to": d_to,
                        "soil_class": soil_class or soil_type,
                        "soil_type": soil_type,
                        "spt_n": spt_n,
                        "pi": pi if pi is not None else "NP",
                        "fc": fc,
                        "unit_weight_tf_m3": unit_w,
                    })
            else:
                # No lithology: use SPT intervals as layers (SPT may not be continuous)
                for s in spt_list:
                    df = s.get("depth_from")
                    dt = s.get("depth_to")
                    if df is None or dt is None:
                        continue
                    nval = (s.get("background") or {}).get("nValue") or s.get("nValue")
                    pi = (s.get("background") or {}).get("pi", "NP")
                    fc = (s.get("background") or {}).get("fc")
                    bh_out["layers"].append({
                        "depth_from": float(df),
                        "depth_to": float(dt),
                        "soil_class": "",
                        "soil_type": "",
                        "spt_n": nval,
                        "pi": pi,
                        "fc": fc,
                        "unit_weight_tf_m3": None,
                    })
                bh_out["layers"].sort(key=lambda r: (r["depth_from"], r["depth_to"]))

            # Include CPT if present (supplementary)
            if cpt_list:
                cpt = cpt_list[0]
                bh_out["cpt"] = {
                    "test_id": cpt.get("test_id"),
                    "depths": cpt.get("depths", []),
                    "qc": cpt.get("qc", []),
                    "fs": cpt.get("fs", []),
                    "u2": cpt.get("u2", []),
                    "units": cpt.get("units", {}),
                }

        # ---- CPT-only with multiple CPT tests: use first as representative ----
        elif cpt_list:
            cpt = cpt_list[0]
            bh_out["cpt"] = {
                "test_id": cpt.get("test_id"),
                "depths": cpt.get("depths", []),
                "qc": cpt.get("qc", []),
                "fs": cpt.get("fs", []),
                "u2": cpt.get("u2", []),
                "units": cpt.get("units", {}),
                "note": "First of multiple CPT tests - represents borehole",
            }

        # ---- No SPT/CPT: layers from lithology only (no SPT-N) ----
        elif lithology:
            for lit in lithology:
                d_from = lit.get("from")
                d_to = lit.get("to")
                if d_from is None or d_to is None:
                    continue
                try:
                    d_from = float(d_from)
                    d_to = float(d_to)
                except (TypeError, ValueError):
                    continue
                soil_class = (lit.get("legend_code") or lit.get("legendCode") or "").strip()
                soil_type = (lit.get("classification_name") or lit.get("classificationName") or "").strip()
                unit_w = _unit_weight_for_uscs(soil_class)
                bh_out["layers"].append({
                    "depth_from": d_from,
                    "depth_to": d_to,
                    "soil_class": soil_class or soil_type,
                    "soil_type": soil_type,
                    "spt_n": None,
                    "pi": lit.get("pi", "NP"),
                    "fc": lit.get("fc"),
                    "unit_weight_tf_m3": unit_w,
                })

        result[loc_id] = bh_out

    return result


def main():
    parser = argparse.ArgumentParser(description="Reorganize DIGGS into borehole-based dataset")
    base = Path(__file__).resolve().parent.parent
    default_db = base / ".diggs_cache" / "DIGGS_Student_Hackathon_large.db.json"
    default_out = base / "borehole_dataset"
    parser.add_argument("input", nargs="?", default=str(default_db), help="Input .db.json path")
    parser.add_argument("output", nargs="?", default=str(default_out), help="Output directory")
    parser.add_argument("--single-file", action="store_true", help="Also write one combined JSON file")
    args = parser.parse_args()

    db_path = Path(args.input)
    out_dir = Path(args.output)

    if not db_path.exists():
        print(f"Error: Input not found: {db_path}")
        print("Run: python tools/preprocess_diggs_to_db.py <xml_path> first")
        sys.exit(1)

    print(f"Loading {db_path}...")
    with open(db_path, "r", encoding="utf-8") as f:
        db = json.load(f)

    print("Building borehole dataset...")
    dataset = build_borehole_dataset(db)

    out_dir.mkdir(parents=True, exist_ok=True)

    for loc_id, bh in dataset.items():
        name = bh.get("borehole_name", loc_id).replace("/", "-")
        fpath = out_dir / f"{loc_id}.json"
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(bh, f, ensure_ascii=False, indent=2)
        print(f"  Wrote {fpath.name} ({len(bh.get('layers', []))} layers)")

    if args.single_file:
        combined = {
            "metadata": {
                "source": str(db_path),
                "borehole_count": len(dataset),
            },
            "boreholes": dataset,
        }
        combined_path = out_dir / "all_boreholes.json"
        with open(combined_path, "w", encoding="utf-8") as f:
            json.dump(combined, f, ensure_ascii=False, indent=2)
        print(f"  Wrote {combined_path.name}")

    print(f"\nDone. {len(dataset)} boreholes in {out_dir}")


if __name__ == "__main__":
    main()
