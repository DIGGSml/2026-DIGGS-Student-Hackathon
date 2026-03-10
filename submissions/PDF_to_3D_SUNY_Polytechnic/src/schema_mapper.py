
from datetime import datetime


def _parse_iso_date(raw_date):
    """Convert various date formats to ISO 8601 (YYYY-MM-DD)."""
    if not raw_date:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y", "%m-%d-%Y"):
        try:
            return datetime.strptime(raw_date.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None  # return None if unparseable so caller can fall back to today's date


def map_to_diggs_structure(extracted_data):
    """
    Transforms extracted JSON data into a structure ready for XML generation.
    """
    metadata = extracted_data.get("metadata", {})
    stratigraphy = extracted_data.get("stratigraphy", [])
    tests = extracted_data.get("tests", [])

    # 1. Borehole Object
    borehole_uid = f"Borehole_{metadata.get('borehole_id', 'Unknown')}"
    project_uid = "Project_Generated"

    # Prefer total_depth_ft from metadata (explicitly stated in PDF)
    # Fall back to computing from layer/test depths
    total_depth_ft = metadata.get("total_depth_ft")
    if total_depth_ft is None:
        all_bottoms = [l.get("bottom_ft") for l in stratigraphy if l.get("bottom_ft") is not None]
        all_bottoms += [t.get("depth_bottom_ft") for t in tests if t.get("depth_bottom_ft") is not None]
        total_depth_ft = max(all_bottoms) if all_bottoms else None

    iso_date = _parse_iso_date(metadata.get("date"))

    loc = metadata.get("location", {})
    lat = loc.get("lat")
    lon = loc.get("lon")
    elev = loc.get("elevation_ft") or 0.0

    if lat is None or lon is None:
        import logging
        logging.getLogger(__name__).warning(
            f"Missing coordinates for borehole '{metadata.get('borehole_id')}' "
            f"— defaulting to 0.0 0.0. XML may fail schema validation."
        )
        lat = lat or 0.0
        lon = lon or 0.0

    diggs_data = {
        "borehole": {
            "gml_id": borehole_uid,
            "name": metadata.get("borehole_id"),
            "total_depth_ft": total_depth_ft,
            "drill_date": iso_date,
            "location": {
                "pos": f"{lat} {lon} {elev}",
                "srs": loc.get("srs", "EPSG:4326"),
                "gml_id": f"Point_{borehole_uid}"
            }
        },
        "project": {
            "gml_id": project_uid,
            "name": metadata.get("project_name", "Unknown Project"),
            "date": iso_date,
        },
        "observations": []
    }

    # 2. Stratigraphy (Lithology)
    for i, layer in enumerate(stratigraphy):
        obs_id = f"LithObs_{i}"
        uscs = layer.get("uscs_code", "")
        obs = {
            "type": "lithology",
            "gml_id": obs_id,
            "top": layer.get("top_ft"),
            "bottom": layer.get("bottom_ft"),
            "description": layer.get("description"),
            "lith_class_symbol": uscs,
            "lith_class_type": "USCS"
        }
        diggs_data["observations"].append(obs)

    # 3. Tests (SPT and Lab)
    for i, test in enumerate(tests):
        test_type = test.get("type")
        test_id = f"Test_{i}"

        if test_type == "SPT":
            spt_data = {
                "type": "spt",
                "gml_id": test_id,
                "top": test.get("depth_top_ft"),
                "bottom": test.get("depth_bottom_ft"),
                "n_value": test.get("n_value"),
                "blow_counts": test.get("blow_counts", [])
            }
            diggs_data["observations"].append(spt_data)

        elif test_type == "Lab":
            lab_data = {
                "type": "lab",
                "gml_id": test_id,
                "top": test.get("depth_ft"),
                "bottom": test.get("depth_ft"),
                "test_name": test.get("test_name"),
                "result": test.get("result_value"),
                "unit": test.get("unit")
            }
            diggs_data["observations"].append(lab_data)

    return diggs_data
