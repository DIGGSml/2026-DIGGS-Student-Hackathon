"""
DIGGS XML parsing and database loading helpers.
Used by routes/diggs_routes.py.
"""
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

GML_NS = "http://www.opengis.net/gml/3.2"
XLINK_NS = "http://www.w3.org/1999/xlink"
GML_ID_ATTR = f"{{{GML_NS}}}id"
XLINK_HREF_ATTR = f"{{{XLINK_NS}}}href"

# In-memory cache for loaded DIGGS db
_diggs_db_memory_cache = {}


def _get_project_root():
    """Project root (parent of utils/)."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _local_tag(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def _parse_pos_text(pos_text):
    if not pos_text:
        return None, None, None
    try:
        vals = [float(x) for x in str(pos_text).strip().split()]
        if len(vals) >= 2:
            lat = vals[0]
            lon = vals[1]
            elev = vals[2] if len(vals) >= 3 else None
            return lat, lon, elev
    except Exception:
        pass
    return None, None, None


def _first_text(elem, xpaths):
    """Return the first non-empty text found by trying multiple xpaths."""
    for xp in xpaths:
        found = elem.find(xp)
        if found is None:
            continue
        txt = "".join(found.itertext()).strip()
        if txt:
            return txt
    return ""


def safe_xml_path(xml_name):
    """Restrict to files under app folder to prevent path traversal."""
    base_dir = _get_project_root()
    if not xml_name:
        xml_name = "DIGGS_Student_Hackathon_large.XML"
    xml_name = os.path.basename(xml_name)
    if not xml_name.lower().endswith(".xml"):
        xml_name += ".XML"
    path = os.path.join(base_dir, xml_name)
    if os.path.exists(path):
        return path
    uploads_dir = os.path.join(base_dir, ".diggs_cache", "uploads")
    path_uploads = os.path.join(uploads_dir, xml_name)
    if os.path.exists(path_uploads):
        return path_uploads
    return None


def extract_feature_info(elem, feature_type):
    gid = elem.attrib.get(GML_ID_ATTR) or elem.attrib.get("gml:id") or elem.attrib.get("id") or ""
    if not gid:
        return None

    name_elem = elem.find(f".//{{{GML_NS}}}name")
    name = (name_elem.text or "").strip() if name_elem is not None and name_elem.text else gid

    pos_elem = elem.find(f".//{{{GML_NS}}}pos")
    lat, lon, elev = _parse_pos_text(pos_elem.text if pos_elem is not None else None)

    td_elem = elem.find(".//{*}totalMeasuredDepth")
    total_depth = (td_elem.text or "").strip() if td_elem is not None and td_elem.text else ""
    total_depth_uom = td_elem.attrib.get("uom", "") if td_elem is not None else ""

    project_ref_elem = elem.find(".//{*}projectRef")
    project_ref = ""
    if project_ref_elem is not None:
        project_ref = (
            project_ref_elem.attrib.get(XLINK_HREF_ATTR)
            or project_ref_elem.attrib.get("xlink:href")
            or ""
        )

    description = _first_text(elem, [
        f".//{{{GML_NS}}}description",
        ".//{*}description",
        ".//{*}remarks",
        ".//{*}remarks//{*}content",
    ])
    location_description = _first_text(elem, [
        ".//{*}locationDescription",
        ".//{*}locationDescription//{*}content",
    ])
    purpose = _first_text(elem, [
        ".//{*}purpose",
        ".//{*}purpose//{*}content",
    ])

    return {
        "id": gid,
        "name": name,
        "feature_type": feature_type,
        "latitude": lat,
        "longitude": lon,
        "elevation": elev,
        "total_depth": total_depth,
        "total_depth_uom": total_depth_uom,
        "project_ref": project_ref,
        "description": description,
        "location_description": location_description,
        "purpose": purpose,
        "spt_count": 0,
        "cpt_count": 0,
        "vs_count": 0,
        "spt_samples": [],
        "cpt_tests": [],
        "vs_tests": [],
    }


def extract_cpt_data_from_xml(xml_path, test_id):
    """Extract CPT test data from XML for a specific test_id using regex."""
    result = {
        "test_id": test_id,
        "location_id": None,
        "depths": [],
        "qc": [],
        "fs": [],
        "u2": [],
        "units": {},
        "background": {}
    }
    with open(xml_path, 'r', encoding='utf-8') as f:
        xml_text = f.read()

    test_pattern = rf'<Test[^>]*gml:id="{re.escape(test_id)}"[^>]*>(.*?)</Test>'
    match = re.search(test_pattern, xml_text, re.DOTALL)
    if not match:
        return None

    test_section = match.group(1)

    loc_match = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', test_section)
    if loc_match:
        result["location_id"] = loc_match.group(1)

    depth_match = re.search(r'<MultiPointLocation[^>]*>.*?<gml:posList[^>]*>(.*?)</gml:posList>', test_section, re.DOTALL)
    if depth_match:
        try:
            depths_text = depth_match.group(1).strip()
            result["depths"] = [float(x) for x in depths_text.split() if x.strip()]
        except Exception:
            pass

    param_matches = re.findall(r'<Property[^>]*index="(\d+)"[^>]*>.*?<propertyName>(.*?)</propertyName>.*?<uom>(.*?)</uom>', test_section, re.DOTALL)
    for idx, name, unit in param_matches:
        try:
            result["units"][name.strip()] = unit.strip()
        except Exception:
            pass

    data_match = re.search(r'<dataValues[^>]*>(.*?)</dataValues>', test_section, re.DOTALL)
    if data_match:
        data_text = data_match.group(1).strip()
        lines = [l.strip() for l in data_text.split('\n') if l.strip()]
        for line in lines:
            try:
                values = [float(x.strip()) for x in line.split(',') if x.strip()]
                if len(values) >= 3:
                    result["qc"].append(values[0] if len(values) > 0 else 0)
                    result["fs"].append(values[1] if len(values) > 1 else 0)
                    result["u2"].append(values[2] if len(values) > 2 else 0)
            except Exception:
                continue

    procedure_match = re.search(r'<diggs:StaticConePenetrationTest[^>]*>(.*?)</diggs:StaticConePenetrationTest>', test_section, re.DOTALL)
    if procedure_match:
        procedure_content = procedure_match.group(1)
        penetrometer_type_match = re.search(r'<diggs:penetrometerType>(.*?)</diggs:penetrometerType>', procedure_content, re.DOTALL)
        if penetrometer_type_match:
            result["background"]["penetrometerType"] = penetrometer_type_match.group(1).strip()
        distance_match = re.search(r'<diggs:distanceTipToSleeve[^>]*uom=["\']([^"\']+)["\'][^>]*>([^<]+)</diggs:distanceTipToSleeve>', procedure_content)
        if distance_match:
            result["background"]["distanceTipToSleeve"] = distance_match.group(2).strip()
            result["background"]["distanceTipToSleeve_uom"] = distance_match.group(1).strip()
        net_area_match = re.search(r'<diggs:netAreaRatioCorrection>([^<]+)</diggs:netAreaRatioCorrection>', procedure_content)
        if net_area_match:
            result["background"]["netAreaRatioCorrection"] = net_area_match.group(1).strip()
        penetration_rate_match = re.search(r'<diggs:penetrationRate[^>]*uom=["\']([^"\']+)["\'][^>]*>([^<]+)</diggs:penetrationRate>', procedure_content)
        if penetration_rate_match:
            result["background"]["penetrationRate"] = penetration_rate_match.group(2).strip()
            result["background"]["penetrationRate_uom"] = penetration_rate_match.group(1).strip()
        tip_area_match = re.search(r'<diggs:tipArea[^>]*uom=["\']([^"\']+)["\'][^>]*>([^<]+)</diggs:tipArea>', procedure_content)
        if tip_area_match:
            result["background"]["tipArea"] = tip_area_match.group(2).strip()
            result["background"]["tipArea_uom"] = tip_area_match.group(1).strip()
        equipment_match = re.search(r'<testProcedureEquipment>.*?<Equipment[^>]*>.*?<serialNumber>([^<]+)</serialNumber>', procedure_content, re.DOTALL)
        if equipment_match:
            result["background"]["serialNumber"] = equipment_match.group(1).strip()

    return result


def extract_pi_fc_lookup(xml_path):
    """Extract PI and FC by (location_id, depth_ft) from XML. Cached per xml_path mtime."""
    mtime = os.path.getmtime(xml_path) if os.path.exists(xml_path) else 0
    cache_key = (xml_path, mtime)
    if not hasattr(extract_pi_fc_lookup, "_cache"):
        extract_pi_fc_lookup._cache = {}
    if cache_key in extract_pi_fc_lookup._cache:
        return extract_pi_fc_lookup._cache[cache_key]

    lookup = {}
    with open(xml_path, 'r', encoding='utf-8') as f:
        xml_text = f.read()

    def _norm_loc(loc):
        if not loc:
            return ""
        s = str(loc).strip()
        if s.startswith("Location_"):
            return s[9:]
        return s

    for block in re.finditer(r'<Test[^>]*>.*?<diggs:AtterbergLimitsTest', xml_text, re.DOTALL):
        test_section = block.group(0)
        loc_m = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', test_section)
        pos_m = re.search(r'<PointLocation[^>]*>.*?<gml:pos>([^<]+)</gml:pos>', test_section, re.DOTALL)
        dv_m = re.search(r'<dataValues[^>]*>([^<]+)</dataValues>', test_section)
        if not (loc_m and pos_m and dv_m):
            continue
        try:
            depth_ft = float(pos_m.group(1).strip())
        except ValueError:
            continue
        loc_key = _norm_loc(loc_m.group(1))
        vals = [x.strip() for x in dv_m.group(1).split(',')]
        pi_val = "NP"
        if len(vals) >= 3:
            try:
                pi_num = float(vals[2])
                pi_val = str(int(pi_num)) if pi_num == int(pi_num) else str(round(pi_num, 1))
            except (ValueError, IndexError):
                pass
        key = (loc_key, round(depth_ft, 2))
        if key not in lookup:
            lookup[key] = {"pi": pi_val, "fc": None}
        lookup[key]["pi"] = pi_val

    for block in re.finditer(
        r'<Test[^>]*>.*?<diggs:sieveAnalysis>.*?<diggs:particleSize[^>]*>0\.075[0-9]*',
        xml_text, re.DOTALL
    ):
        test_section = block.group(0)
        loc_m = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', test_section)
        pos_m = re.search(r'<PointLocation[^>]*>.*?<gml:pos>([^<]+)</gml:pos>', test_section, re.DOTALL)
        pp_m = re.search(r'<diggs:particleSize[^>]*>0\.075[0-9]*[^<]*</diggs:particleSize>.*?<diggs:percentPassing[^>]*>([^<]+)</diggs:percentPassing>', test_section, re.DOTALL)
        if not (loc_m and pos_m and pp_m):
            continue
        try:
            depth_ft = float(pos_m.group(1).strip())
            fc_val = float(pp_m.group(1).strip())
        except ValueError:
            continue
        loc_key = _norm_loc(loc_m.group(1))
        key = (loc_key, round(depth_ft, 2))
        if key not in lookup:
            lookup[key] = {"pi": "NP", "fc": None}
        lookup[key]["fc"] = round(fc_val, 2)

    extract_pi_fc_lookup._cache[cache_key] = lookup
    return lookup


_TYPICAL_UNIT_WEIGHT_TF_M3 = {
    "CL": 1.9, "CH": 1.8, "ML": 1.85, "MH": 1.75, "OL": 1.6, "OH": 1.65,
    "SM": 1.9, "SC": 1.95, "SP": 1.7, "SW": 1.8, "SP-SM": 1.8, "SP-SC": 1.85,
    "ML-CL": 1.85, "CL-ML": 1.9, "GP": 1.75, "GW": 1.85, "GM": 1.9, "GC": 1.95,
}


def typical_unit_weight_by_uscs(legend_code):
    """Return typical unit weight (tf/m³) for USCS code, or None if unknown."""
    if not legend_code:
        return None
    code = str(legend_code).strip().upper()
    return _TYPICAL_UNIT_WEIGHT_TF_M3.get(code)


def find_pi_fc_for_depth(lookup, location_id, depth_from, depth_to, tol_ft=2.0):
    """Find PI and FC for SPT depth range from lookup. Returns {pi, fc}."""
    loc_key = str(location_id or "").replace("Location_", "").strip()
    if not loc_key:
        return {"pi": "NP", "fc": None}
    mid = (float(depth_from or 0) + float(depth_to or 0)) / 2.0 if (depth_from or depth_to) else 0
    best = None
    best_dist = 1e9
    for (loc, d), v in lookup.items():
        if loc != loc_key:
            continue
        dist = abs(d - mid)
        if dist < best_dist and dist <= tol_ft:
            best_dist = dist
            best = v
    return best if best else {"pi": "NP", "fc": None}


def spt_result_empty(r):
    """Check if cached SPT result has no usable rows for import."""
    if not r or not isinstance(r, dict):
        return True
    if r.get("depth_from") is not None and r.get("depth_to") is not None:
        nval = (r.get("background") or {}).get("nValue") or r.get("nValue")
        if nval is not None and str(nval).strip():
            return False
    rows = r.get("rows") or r.get("tests") or r.get("data") or []
    return len(rows) == 0


def extract_spt_data_from_xml(xml_path, activity_id):
    """Extract SPT activity data from XML using regex."""
    result = {
        "activity_id": activity_id,
        "location_id": None,
        "depth_from": None,
        "depth_to": None,
        "name": "",
        "background": {}
    }
    with open(xml_path, 'r', encoding='utf-8') as f:
        xml_text = f.read()

    pattern = rf'<SamplingActivity[^>]*gml:id="{re.escape(activity_id)}"[^>]*>(.*?)</SamplingActivity>'
    match = re.search(pattern, xml_text, re.DOTALL)
    if not match:
        return None

    activity_section = match.group(1)

    loc_match = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', activity_section)
    if loc_match:
        result["location_id"] = loc_match.group(1)

    depth_match = re.search(r'<samplingLocation>.*?<gml:posList[^>]*>(.*?)</gml:posList>', activity_section, re.DOTALL)
    if depth_match:
        try:
            depths_text = depth_match.group(1).strip()
            depths = [float(x) for x in depths_text.split() if x.strip()]
            if len(depths) >= 2:
                result["depth_from"] = depths[0]
                result["depth_to"] = depths[1]
        except Exception:
            pass

    name_match = re.search(r'<gml:name>(.*?)</gml:name>', activity_section)
    if name_match:
        result["name"] = name_match.group(1).strip()

    test_pattern = rf'<Test[^>]*>.*?<samplingFeatureRef[^>]*xlink:href=["\']#?{re.escape(activity_id)}["\'][^>]*>(.*?)</Test>'
    test_match = re.search(test_pattern, xml_text, re.DOTALL)
    if test_match:
        test_section = test_match.group(0)
        procedure_match = re.search(r'<diggs:DrivenPenetrationTest[^>]*>(.*?)</diggs:DrivenPenetrationTest>', test_section, re.DOTALL)
        if procedure_match:
            procedure_content = procedure_match.group(1)
            hammer_type_match = re.search(r'<diggs:hammerType>(.*?)</diggs:hammerType>', procedure_content, re.DOTALL)
            if hammer_type_match:
                result["background"]["hammerType"] = hammer_type_match.group(1).strip()
            hammer_eff_match = re.search(r'<diggs:hammerEfficiency[^>]*>([^<]+)</diggs:hammerEfficiency>', procedure_content)
            if hammer_eff_match:
                result["background"]["hammerEfficiency"] = hammer_eff_match.group(1).strip()
            total_pen_match = re.search(r'<diggs:totalPenetration[^>]*>([^<]+)</diggs:totalPenetration>', procedure_content)
            if total_pen_match:
                result["background"]["totalPenetration"] = total_pen_match.group(1).strip()
            drive_sets = []
            for ds_match in re.finditer(r'<diggs:DriveSet[^>]*>(.*?)</diggs:DriveSet>', procedure_content, re.DOTALL):
                ds_content = ds_match.group(1)
                ds_data = {}
                index_match = re.search(r'<diggs:index>([^<]+)</diggs:index>', ds_content)
                if index_match:
                    ds_data["index"] = index_match.group(1).strip()
                blow_count_match = re.search(r'<diggs:blowCount>([^<]+)</diggs:blowCount>', ds_content)
                if blow_count_match:
                    ds_data["blowCount"] = blow_count_match.group(1).strip()
                penetration_match = re.search(r'<diggs:penetration[^>]*>([^<]+)</diggs:penetration>', ds_content)
                if penetration_match:
                    ds_data["penetration"] = penetration_match.group(1).strip()
                if ds_data:
                    drive_sets.append(ds_data)
            if drive_sets:
                result["background"]["driveSets"] = drive_sets
            n_value_match = re.search(r'<dataValues[^>]*>([^<]+)</dataValues>', test_section, re.DOTALL)
            if n_value_match:
                try:
                    result["background"]["nValue"] = n_value_match.group(1).strip()
                except Exception:
                    pass

    if xml_path and os.path.exists(xml_path):
        lookup = extract_pi_fc_lookup(xml_path)
        pi_fc = find_pi_fc_for_depth(
            lookup,
            result.get("location_id"),
            result.get("depth_from"),
            result.get("depth_to"),
        )
        result["background"]["pi"] = pi_fc.get("pi", "NP")
        result["background"]["fc"] = pi_fc.get("fc")

    return result


def extract_uscs_lithology_for_location(xml_path, feature_id):
    """Fallback: get USCS lithology intervals for one location directly from XML."""
    try:
        intervals = []
        inside = False
        cls_type = None

        def _first_non_none(*xs):
            for x in xs:
                if x is not None:
                    return x
            return None

        for event, elem in ET.iterparse(xml_path, events=("start", "end")):
            t = _local_tag(elem.tag)

            if event == "start" and t == "LithologySystem":
                inside = True
                cls_type = None
                continue

            if not inside:
                if event == "end":
                    elem.clear()
                continue

            if event == "end" and t == "samplingFeatureRef":
                href = elem.attrib.get(XLINK_HREF_ATTR) or elem.attrib.get("xlink:href") or ""
                loc_id = href[1:] if href.startswith("#") else href
                if loc_id != feature_id:
                    inside = False
                elem.clear()
                continue

            if event == "end" and t == "lithologyClassificationType":
                cls_type = (elem.text or "").strip().lower() if elem.text else ""
                elem.clear()
                continue

            if event == "end" and t == "LithologyObservation":
                if cls_type != "uscs":
                    elem.clear()
                    continue

                pos_list = _first_non_none(
                    elem.find(".//{*}posList"),
                    elem.find(".//posList"),
                )
                d_from = None
                d_to = None
                if pos_list is not None and pos_list.text:
                    try:
                        depths = [float(x) for x in pos_list.text.strip().split()]
                        if len(depths) >= 2:
                            d_from, d_to = depths[0], depths[1]
                    except Exception:
                        d_from, d_to = None, None
                if d_from is None or d_to is None:
                    elem.clear()
                    continue

                legend = _first_non_none(
                    elem.find(".//{*}legendCode"),
                    elem.find(".//legendCode"),
                )
                legend_code = (legend.text or "").strip() if legend is not None and legend.text else ""
                ccode = _first_non_none(
                    elem.find(".//{*}classificationCode"),
                    elem.find(".//classificationCode"),
                )
                classification_name = (ccode.text or "").strip() if ccode is not None and ccode.text else ""
                ldesc = _first_non_none(
                    elem.find(".//{*}lithDescription"),
                    elem.find(".//lithDescription"),
                )
                description = (ldesc.text or "").strip() if ldesc is not None and ldesc.text else ""

                intervals.append({
                    "from": d_from,
                    "to": d_to,
                    "legend_code": legend_code,
                    "classification_name": classification_name,
                    "description": description,
                })

                elem.clear()
                continue

            if event == "end" and t == "LithologySystem":
                inside = False
                elem.clear()
                break

        intervals.sort(key=lambda r: (r.get("from", 0.0), r.get("to", 0.0)))
        return intervals
    except Exception:
        return []


def is_vs_test(test_elem):
    """Heuristic detection for Vs/shear-wave-velocity tests in DIGGS Test payload."""
    keywords = (
        "shear_wave_velocity",
        "shear wave velocity",
        "vs30",
        "vs ",
        " vs",
        "velocity",
    )
    for ch in test_elem.iter():
        tag = _local_tag(ch.tag).lower()
        if tag in ("propertyname", "propertyclass", "name", "testtype"):
            txt = (ch.text or "").strip().lower()
            if not txt:
                continue
            if any(k in txt for k in keywords):
                return True
    return False


def build_lithology_rows_for_import(xml_path, feature_id, lithology_uscs):
    """Build lithology-based rows for SPT table import, enriched with PI, FC, unit weight."""
    if not lithology_uscs or not isinstance(lithology_uscs, list):
        return []
    loc_key = str(feature_id or "").replace("Location_", "").strip()
    if not loc_key:
        return []
    lookup = extract_pi_fc_lookup(xml_path) if xml_path and os.path.exists(xml_path) else {}
    rows = []
    for it in lithology_uscs:
        d_from = it.get("from")
        d_to = it.get("to")
        if d_from is None or d_to is None:
            continue
        try:
            d_from = float(d_from)
            d_to = float(d_to)
        except (TypeError, ValueError):
            continue
        pi_val = it.get("pi")
        fc_val = it.get("fc")
        if pi_val is None or fc_val is None:
            pi_fc = find_pi_fc_for_depth(lookup, f"Location_{loc_key}", d_from, d_to, tol_ft=3.0)
            if pi_val is None:
                pi_val = pi_fc.get("pi", "NP")
            if fc_val is None:
                fc_val = pi_fc.get("fc")
        soil_class = (it.get("soil_class") or "").strip()
        legend = (it.get("legend_code") or it.get("legendCode") or soil_class or "").strip()
        if not legend and soil_class:
            legend = soil_class
        classification = (it.get("classification_name") or it.get("classificationName") or soil_class or legend or "").strip()
        unit_w = it.get("unit_weight")
        if unit_w is None:
            unit_w = typical_unit_weight_by_uscs(legend or soil_class)
        rows.append({
            "from": d_from,
            "to": d_to,
            "soil_class": soil_class or legend,
            "legend_code": legend,
            "classification_name": classification,
            "pi": pi_val if pi_val is not None else "NP",
            "fc": fc_val,
            "unit_weight": unit_w,
        })
    return rows


def load_diggs_db(xml_path):
    """Load preprocessed DIGGS database (SQLite only)."""
    import diggs_db
    db_path = diggs_db.get_db_path(xml_path, prefer_sqlite=True)
    if not db_path:
        return None
    try:
        mtime = os.path.getmtime(db_path)
        cached = _diggs_db_memory_cache.get(db_path)
        if cached and cached[0] == mtime and isinstance(cached[1], dict):
            return cached[1]
    except (IOError, OSError):
        pass
    try:
        conn = diggs_db._get_sqlite_conn(db_path)
        if not conn:
            return None
        db = diggs_db.get_full_db_for_convert(conn, True)
        _diggs_db_memory_cache[db_path] = (mtime, db)
        return db
    except Exception as e:
        print(f"[DIGGS] Error loading database: {e}")
        return None


def load_diggs_db_raw(xml_path):
    """Load DIGGS SQLite for per-borehole queries. Returns: (conn, True) or (None, False)."""
    import diggs_db
    return diggs_db.load_diggs_db(xml_path, prefer_sqlite=True)


def convert_db_to_map_format(db):
    """Convert preprocessed database format to map-ready GeoJSON format."""
    locations = db.get("locations", {})
    spt_data = db.get("spt_data", [])
    cpt_data = db.get("cpt_data", [])
    vs_data = db.get("vs_data", [])
    location_stats = db.get("location_stats", {})
    location_tests = db.get("location_tests", {})
    project_info = db.get("project_info", {})
    lithology_uscs = db.get("lithology_uscs", {}) or {}

    features_by_id = {}
    for loc_id, loc_info in locations.items():
        stats = location_stats.get(loc_id, {})
        tests = location_tests.get(loc_id, {"cpt_tests": [], "spt_tests": []})
        project_ref = loc_info.get("project_ref", "")
        project_id = project_ref[1:] if project_ref.startswith("#") else project_ref
        project = project_info.get(project_id, {})
        features_by_id[loc_id] = {
            **loc_info,
            "spt_count": stats.get("spt_count", 0),
            "cpt_count": stats.get("cpt_count", 0),
            "vs_count": stats.get("vs_count", 0),
            "spt_samples": [spt["activity_id"] for spt in spt_data if spt["location_id"] == loc_id][:5],
            "cpt_tests": [cpt["test_id"] for cpt in cpt_data if cpt["location_id"] == loc_id][:5],
            "vs_tests": [vs["test_id"] for vs in vs_data if vs["location_id"] == loc_id][:5],
            "all_cpt_tests": tests.get("cpt_tests", []),
            "all_spt_tests": tests.get("spt_tests", []),
            "project_info": project,
        }

    geo_features = []
    detail_index = {}
    borehole_with_coords = 0
    sounding_with_coords = 0

    for loc_id, item in features_by_id.items():
        lat = item.get("latitude")
        lon = item.get("longitude")
        if lat is None or lon is None:
            continue
        if item["feature_type"] == "Borehole":
            borehole_with_coords += 1
        elif item["feature_type"] == "Sounding":
            sounding_with_coords += 1

        geo_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": item["id"],
                "name": item["name"],
                "feature_type": item["feature_type"],
                "total_depth": item.get("total_depth", ""),
                "total_depth_uom": item.get("total_depth_uom", ""),
                "project_ref": item.get("project_ref", ""),
                "spt_count": item["spt_count"],
                "cpt_count": item["cpt_count"],
                "vs_count": item["vs_count"],
                "spt_samples": item["spt_samples"],
                "cpt_tests": item["cpt_tests"],
                "vs_tests": item["vs_tests"],
            }
        })

        # Lithology may be keyed as "Location_B-04" (from XML samplingFeatureRef) while locations use "B-04"
        lith = lithology_uscs.get(loc_id) or lithology_uscs.get(f"Location_{loc_id}") if not (loc_id or "").startswith("Location_") else lithology_uscs.get(loc_id) or lithology_uscs.get((loc_id or "")[9:])
        lith = lith if lith else []

        entry = {
            "description": item.get("description", ""),
            "location_description": item.get("location_description", ""),
            "purpose": item.get("purpose", ""),
            "project_info": item.get("project_info", {}),
            "all_cpt_tests": item.get("all_cpt_tests", []),
            "all_spt_tests": item.get("all_spt_tests", []),
            "lithology_uscs": lith,
        }
        detail_index[loc_id] = entry
        # Also key by short form (B-035) so frontend lookup works either way
        if loc_id.startswith("Location_"):
            short_id = loc_id[9:]  # "Location_B-035" -> "B-035"
            detail_index[short_id] = entry

    return {
        "geojson": {"type": "FeatureCollection", "features": geo_features},
        "detail_index": detail_index,
        "summary": {
            "feature_total": len(features_by_id),
            "map_points": len(geo_features),
            "borehole_points": borehole_with_coords,
            "sounding_points": sounding_with_coords,
            "total_spt_count": sum(v["spt_count"] for v in features_by_id.values()),
            "total_cpt_count": sum(v["cpt_count"] for v in features_by_id.values()),
            "total_vs_count": sum(v["vs_count"] for v in features_by_id.values()),
        },
        "cache_meta": db.get("metadata", {}),
    }


def preprocess_diggs_db_on_startup():
    """Ensure DIGGS SQLite (.db) exists. If not, build it once from XML."""
    enabled = str(os.getenv("DIGGS_PREPROCESS_DB_ON_STARTUP", "true")).strip().lower() not in {"0", "false", "no"}
    if not enabled:
        print("DIGGS DB pre-process on startup disabled.")
        return

    preload_raw = os.getenv(
        "DIGGS_PRELOAD_FILES",
        "DIGGS_Student_Hackathon_large.XML,2026-DIGGS-Student-Hackathon-V1.XML",
    )
    candidates = [x.strip() for x in preload_raw.split(",") if x.strip()]
    if not candidates:
        return

    import diggs_db
    for xml_name in candidates:
        xml_path = safe_xml_path(xml_name)
        if not xml_path:
            continue
        try:
            db_path = diggs_db.get_db_path(xml_path, prefer_sqlite=True)
            if db_path:
                print(f"DIGGS DB ready: {os.path.basename(db_path)}")
                continue
            try:
                from tools.preprocess_diggs_to_db import preprocess_diggs_to_db
                from tools.preprocess_diggs_to_sqlite import _write_db_to_sqlite, write_lithology_to_sqlite
                base_dir = _get_project_root()
                cache_dir = os.path.join(base_dir, ".diggs_cache")
                os.makedirs(cache_dir, exist_ok=True)
                xml_base = os.path.splitext(os.path.basename(xml_path))[0]
                sqlite_path = os.path.join(cache_dir, f"{xml_base}.db")
                db = preprocess_diggs_to_db(xml_path, output_path=None, save_json=False)
                _write_db_to_sqlite(db, sqlite_path)
                n = write_lithology_to_sqlite(xml_path, sqlite_path)
                if n > 0:
                    print(f"DIGGS lithology: {n} intervals")
                print(f"DIGGS SQLite created: {os.path.basename(sqlite_path)}")
            except Exception as e:
                print(f"DIGGS DB preprocess failed for {xml_name}: {e}")
        except Exception as e:
            print(f"DIGGS DB preprocess failed for {xml_name}: {e}")
