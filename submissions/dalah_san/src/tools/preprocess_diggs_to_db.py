#!/usr/bin/env python3
"""
Preprocess DIGGS XML into a structured database (JSON format).
Extracts: locations (coordinates), SPT, CPT, VS data.
Output: compact JSON database for fast backend queries.
"""
import io
import sys
import os
import json
import xml.etree.ElementTree as ET
import xml.sax
from datetime import datetime, timezone

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GML_NS = "http://www.opengis.net/gml/3.2"
XLINK_NS = "http://www.w3.org/1999/xlink"
DIGGS_NS = "http://diggsml.org/schemas/3"  # Default namespace in this XML
GML_ID_ATTR = f"{{{GML_NS}}}id"
XLINK_HREF_ATTR = f"{{{XLINK_NS}}}href"


def local_tag(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def parse_pos_text(pos_text):
    """
    Parse gml:pos string into (lat, lon, elev).
    Handles both axis orders:
    - lat lon [elev] (EPSG:4326 lat-first, e.g. DIGGS_Student_Hackathon_large.XML)
    - lon lat [elev] (EPSG:4326 lon-first, e.g. 2026-DIGGS-Student-Hackathon-V1.XML)
    Heuristic: |lat| <= 90, |lon| can be up to 180.
    """
    if not pos_text:
        return None, None, None
    try:
        vals = [float(x) for x in str(pos_text).strip().split()]
        if len(vals) >= 2:
            a, b = vals[0], vals[1]
            elev = vals[2] if len(vals) >= 3 else None
            # If first value looks like lon (|a|>90) and second like lat (|b|<=90), treat as lon lat
            if abs(a) > 90 and abs(b) <= 90:
                lon, lat = a, b
            else:
                lat, lon = a, b
            return lat, lon, elev
    except Exception:
        pass
    return None, None, None


def extract_location_info(elem, feature_type):
    """Extract location (Borehole/Sounding) info with coordinates."""
    gid = elem.attrib.get(GML_ID_ATTR) or elem.attrib.get("gml:id") or elem.attrib.get("id") or ""
    if not gid:
        return None

    name_elem = elem.find(f".//{{{GML_NS}}}name")
    name = (name_elem.text or "").strip() if name_elem is not None and name_elem.text else gid

    # Try multiple patterns for coordinates
    # Pattern 1: referencePoint -> PointLocation -> gml:pos (most common in this XML)
    pos_elem = None
    
    # Try to find referencePoint by iterating direct children first (faster)
    for child in elem:
        if local_tag(child.tag) == "referencePoint":
            ref_point = child
            # PointLocation should be a direct child of referencePoint
            for point_child in ref_point:
                if local_tag(point_child.tag) == "PointLocation":
                    point_loc = point_child
                    pos_elem = point_loc.find(f".//{{{GML_NS}}}pos")
                    if pos_elem is None:
                        pos_elem = point_loc.find(".//{*}pos")
                    break
            if pos_elem is not None:
                break
    
    # Pattern 2: Use find() as fallback
    if pos_elem is None:
        ref_point = elem.find(f".//{{{DIGGS_NS}}}referencePoint")
        if ref_point is None:
            ref_point = elem.find(".//{*}referencePoint")
        if ref_point is not None:
            point_loc = ref_point.find(f".//{{{DIGGS_NS}}}PointLocation")
            if point_loc is None:
                point_loc = ref_point.find(".//{*}PointLocation")
            if point_loc is not None:
                pos_elem = point_loc.find(f".//{{{GML_NS}}}pos")
                if pos_elem is None:
                    pos_elem = point_loc.find(".//{*}pos")
    
    # Pattern 3: Direct PointLocation -> gml:pos
    if pos_elem is None:
        point_loc = elem.find(f".//{{{DIGGS_NS}}}PointLocation")
        if point_loc is None:
            point_loc = elem.find(".//{*}PointLocation")
        if point_loc is not None:
            pos_elem = point_loc.find(f".//{{{GML_NS}}}pos")
            if pos_elem is None:
                pos_elem = point_loc.find(".//{*}pos")
    
    # Pattern 4: Direct gml:pos
    if pos_elem is None:
        pos_elem = elem.find(f".//{{{GML_NS}}}pos")
    if pos_elem is None:
        pos_elem = elem.find(".//{*}pos")
    
    lat, lon, elev = parse_pos_text(pos_elem.text if pos_elem is not None else None)

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

    return {
        "id": gid,
        "name": name,
        "feature_type": feature_type,  # "Borehole" or "Sounding"
        "latitude": lat,
        "longitude": lon,
        "elevation": elev,
        "total_depth": total_depth,
        "total_depth_uom": total_depth_uom,
        "project_ref": project_ref,
    }


def is_vs_test(test_elem):
    """Heuristic detection for VS/shear-wave-velocity tests."""
    keywords = (
        "shear_wave_velocity",
        "shear wave velocity",
        "vs30",
        "vs ",
        " vs",
        "velocity",
    )
    for ch in test_elem.iter():
        tag = local_tag(ch.tag).lower()
        if tag in ("propertyname", "propertyclass", "name", "testtype"):
            txt = (ch.text or "").strip().lower()
            if not txt:
                continue
            if any(k in txt for k in keywords):
                return True
    return False


def extract_project_info(xml_path, xml_source=None):
    """Extract project information from XML. xml_source: optional file-like (BytesIO) for faster repeated parsing."""
    project_info = {}
    source = xml_source if xml_source is not None else xml_path
    for event, elem in ET.iterparse(source, events=("end",)):
        t = local_tag(elem.tag)
        if t == "Project":
            gid = elem.attrib.get(GML_ID_ATTR) or elem.attrib.get("gml:id") or ""
            if gid:
                name_elem = elem.find(f".//{{{GML_NS}}}name")
                desc_elem = elem.find(f".//{{{GML_NS}}}description")
                locality_elem = elem.find(".//{*}locality")
                locality_desc = ""
                if locality_elem is not None:
                    locality_desc_elem = locality_elem.find(f".//{{{GML_NS}}}description")
                    if locality_desc_elem is not None and locality_desc_elem.text:
                        locality_desc = locality_desc_elem.text.strip()
                
                remark_elem = elem.find(".//{*}remark")
                remark_content = ""
                if remark_elem is not None:
                    content_elem = remark_elem.find(".//{*}content")
                    if content_elem is not None and content_elem.text:
                        remark_content = content_elem.text.strip()
                
                # Extract client and project engineer
                client_name = ""
                engineer_name = ""
                for role in elem.findall(".//{*}role"):
                    role_performed = role.find(".//{*}rolePerformed")
                    if role_performed is not None:
                        role_code = role_performed.attrib.get("codeSpace", "")
                        if "client" in role_code.lower():
                            name_elem = role.find(f".//{{{GML_NS}}}name")
                            if name_elem is not None and name_elem.text:
                                client_name = name_elem.text.strip()
                        elif "project_engineer" in role_code.lower():
                            name_elem = role.find(f".//{{{GML_NS}}}name")
                            if name_elem is not None and name_elem.text:
                                engineer_name = name_elem.text.strip()
                
                project_info[gid] = {
                    "id": gid,
                    "name": (name_elem.text or "").strip() if name_elem is not None and name_elem.text else "",
                    "description": (desc_elem.text or "").strip() if desc_elem is not None and desc_elem.text else "",
                    "locality": locality_desc,
                    "remark": remark_content,
                    "client": client_name,
                    "project_engineer": engineer_name,
                }
            elem.clear()
            break
        elem.clear()
    return project_info


def extract_uscs_lithology(xml_path, xml_source=None):
    """
    Extract USCS lithology observations per location from DIGGS XML.
    Returns: {location_id: [{from, to, legend_code, classification_name, description}]}
    Notes:
    - Depths are returned in the XML's native linear reference system (commonly ft in this dataset).
    - Frontend should convert consistently with SPT depths.
    xml_source: optional file-like (BytesIO) for faster repeated parsing.
    """
    # IMPORTANT: we must NOT blindly elem.clear() for every element, otherwise the
    # LithologySystem children are cleared before LithologySystem ends.
    lith_by_loc = {}
    stack = []  # [{loc_id, cls_type, intervals}]
    source = xml_source if xml_source is not None else xml_path

    def _first_non_none(*xs):
        for x in xs:
            if x is not None:
                return x
        return None

    for event, elem in ET.iterparse(source, events=("start", "end")):
        t = local_tag(elem.tag)

        if event == "start" and t == "LithologySystem":
            stack.append({"loc_id": None, "cls_type": None, "intervals": []})
            continue

        if not stack:
            # Outside lithology system; safe to clear to keep memory low.
            if event == "end":
                elem.clear()
            continue

        ctx = stack[-1]

        if event == "end" and t == "samplingFeatureRef":
            href = elem.attrib.get(XLINK_HREF_ATTR) or elem.attrib.get("xlink:href") or ""
            ctx["loc_id"] = href[1:] if href.startswith("#") else href
            elem.clear()
            continue

        if event == "end" and t == "lithologyClassificationType":
            ctx["cls_type"] = (elem.text or "").strip().lower() if elem.text else ""
            elem.clear()
            continue

        if event == "end" and t == "LithologyObservation":
            # Extract interval row from this observation element
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

            if d_from is not None and d_to is not None:
                ctx["intervals"].append({
                    "from": d_from,
                    "to": d_to,
                    "legend_code": legend_code,
                    "classification_name": classification_name,
                    "description": description,
                })

            # Clear this observation subtree now that it's been consumed
            elem.clear()
            continue

        if event == "end" and t == "LithologySystem":
            finished = stack.pop()
            loc_id = finished.get("loc_id")
            cls_type = finished.get("cls_type")
            intervals = finished.get("intervals") or []
            if loc_id and cls_type == "uscs" and intervals:
                intervals.sort(key=lambda r: (r.get("from", 0.0), r.get("to", 0.0)))
                lith_by_loc[loc_id] = intervals
            elem.clear()
            continue

        # Do NOT clear arbitrary elements inside LithologySystem here:
        # many of the needed values (posList/legendCode/etc) are leaf nodes and
        # would be cleared before LithologyObservation ends.

    return lith_by_loc


def _extract_pi_fc_lookup_from_xml(xml_path, xml_text=None):
    """
    Extract PI (Plasticity Index) and FC (Fines Content %) by (location_key, depth_ft) from XML.
    Returns dict: {(location_key, depth_ft): {"pi": val_or_NP, "fc": val_or_None}}
    Uses split-by-Test approach to avoid catastrophic regex backtracking on large files.
    xml_text: optional pre-read string to avoid disk I/O.
    """
    import re
    lookup = {}

    def _norm_loc(loc):
        if not loc:
            return ""
        s = str(loc).strip()
        if s.startswith("Location_"):
            return s[9:]
        return s

    try:
        if xml_text is None:
            with open(xml_path, 'r', encoding='utf-8') as f:
                xml_text = f.read()
    except Exception:
        return lookup

    # AtterbergLimitsTest: use a bounded search to avoid catastrophic backtracking
    # Split by <Test to process each block separately instead of .*? across whole file
    test_blocks = re.split(r'<\s*Test\s+', xml_text, flags=re.IGNORECASE)
    for i, block in enumerate(test_blocks[1:], 1):  # skip first (content before first Test)
        if 'AtterbergLimitsTest' not in block and 'atterberglimitstest' not in block.lower():
            continue
        test_section = '<Test ' + block[:15000]  # limit size per block
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

    # ParticleSizeTest / sieveAnalysis: same bounded approach
    for i, block in enumerate(test_blocks[1:], 1):
        if 'sieveAnalysis' not in block and 'sieveanalysis' not in block.lower():
            continue
        if '0.075' not in block:
            continue
        test_section = '<Test ' + block[:15000]
        loc_m = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', test_section)
        pos_m = re.search(r'<PointLocation[^>]*>.*?<gml:pos>([^<]+)</gml:pos>', test_section, re.DOTALL)
        sample_m = re.search(r'<sampleRef[^>]*xlink:href=["\']#?Sample_([^"\']+)["\']', test_section)
        pp_m = re.search(
            r'<diggs:particleSize[^>]*>0\.075[0-9]*[^<]*</diggs:particleSize>.*?<diggs:percentPassing[^>]*>([^<]+)</diggs:percentPassing>',
            test_section, re.DOTALL
        )
        if not pp_m:
            pp_m = re.search(r'<percentPassing[^>]*>([^<]+)</percentPassing>', test_section)
        if not pp_m:
            continue
        try:
            fc_val = float(pp_m.group(1).strip())
        except ValueError:
            continue
        if sample_m:
            parts = [p for p in sample_m.group(1).split('_') if p]
            depth_ft = None
            depth_idx = None
            for j, p in enumerate(parts):
                try:
                    v = float(p)
                    # Prefer decimal depth (e.g. 113.50) or value >= 10 to skip '1' in Pier_1
                    if '.' in p or v >= 10:
                        depth_ft = v
                        depth_idx = j
                        break
                    elif depth_idx is None:
                        depth_ft, depth_idx = v, j
                except ValueError:
                    continue
            if depth_ft is not None and depth_idx is not None and depth_idx > 0:
                loc_key = '_'.join(parts[:depth_idx])  # e.g. Pier_1_WB-1, B-113
                key = (loc_key, round(depth_ft, 2))
                if key not in lookup:
                    lookup[key] = {"pi": "NP", "fc": None}
                lookup[key]["fc"] = round(fc_val, 2)
        elif loc_m and pos_m:
            try:
                depth_ft = float(pos_m.group(1).strip())
                loc_key = _norm_loc(loc_m.group(1))
                key = (loc_key, round(depth_ft, 2))
                if key not in lookup:
                    lookup[key] = {"pi": "NP", "fc": None}
                lookup[key]["fc"] = round(fc_val, 2)
            except ValueError:
                pass

    return lookup


def _find_pi_fc_for_depth(lookup, location_id, depth_from, depth_to, tol_ft=2.0):
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


def _extract_bulk_density_by_sample(xml_path, xml_text=None):
    """
    Extract bulk density (unit weight) from TestResult with bulk_density property.
    Returns: {(location_id, depth_from, depth_to): bulk_density_tf_m3}
    - Test has samplingFeatureRef (location) and TestResult has location + dataValues
    - Depth: PointLocation uses gml:pos (single depth); some use gml:posList (depth_from, depth_to)
    - dataValues: "water_content, bulk_density_pcf, dry_density" (bulk at index 2)
    - Convert pcf to tf/m³: 1 pcf = 0.016018 tf/m³
    xml_text: optional pre-read string to avoid disk I/O.
    """
    import re
    result = {}
    PCF_TO_TF_M3 = 0.016018  # 1 lbf/ft³ = 0.016018 tf/m³
    if xml_text is None:
        with open(xml_path, 'r', encoding='utf-8') as f:
            xml_text = f.read()
    # Split by Test blocks to avoid slow DOTALL regex on huge files
    test_blocks = re.split(r'<Test\s', xml_text)
    for block in test_blocks[1:]:  # skip part before first Test
        if 'bulk_density' not in block or 'dataValues' not in block:
            continue
        loc_m = re.search(r'samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', block)
        if not loc_m:
            continue
        loc_id = loc_m.group(1).strip()
        if not loc_id.startswith("Location_"):
            loc_id = f"Location_{loc_id}"
        # Try PointLocation gml:pos (single depth) first
        pos_match = re.search(r'<gml:pos>([^<]+)</gml:pos>', block)
        if pos_match:
            try:
                d = float(pos_match.group(1).strip())
                depth_from = depth_to = d
            except ValueError:
                continue
        else:
            pos_match = re.search(r'<gml:posList[^>]*>([^<]+)</', block)
            if not pos_match:
                continue
            pos_list = pos_match.group(1).strip().split()
            try:
                if len(pos_list) >= 6:
                    d = float(pos_list[-1])
                    depth_from = depth_to = abs(d)
                elif len(pos_list) >= 2:
                    depth_from = float(pos_list[0])
                    depth_to = float(pos_list[1])
                else:
                    depth_from = depth_to = float(pos_list[0])
            except (ValueError, IndexError):
                continue
        dv_match = re.search(r'<dataValues[^>]*>([^<]+)</dataValues>', block)
        if not dv_match:
            continue
        vals = [x.strip() for x in dv_match.group(1).split(',')]
        if len(vals) < 2:
            continue
        try:
            bulk_pcf = float(vals[1])
            if 50 <= bulk_pcf <= 200:
                bulk_tf_m3 = bulk_pcf * PCF_TO_TF_M3
                result[(loc_id, depth_from, depth_to)] = round(bulk_tf_m3, 3)
        except (ValueError, IndexError):
            pass
    return result


def _find_unit_weight_for_interval(bulk_lookup, location_id, depth_from, depth_to, tol_ft=3.0):
    """Find unit weight (tf/m³) for lithology interval from bulk density lookup."""
    loc_key = str(location_id or "").replace("Location_", "").strip()
    if not loc_key:
        return None
    mid = (float(depth_from or 0) + float(depth_to or 0)) / 2.0 if (depth_from or depth_to) else 0
    best = None
    best_dist = 1e9
    for (loc, df, dt), gamma in bulk_lookup.items():
        loc_short = loc.replace("Location_", "")
        if loc_short != loc_key and loc != loc_key:
            continue
        sample_mid = (df + dt) / 2.0
        dist = abs(sample_mid - mid)
        if dist < best_dist and dist <= tol_ft:
            best_dist = dist
            best = gamma
    return best


def preprocess_diggs_to_db(xml_path, output_path=None, save_json=True):
    """
    Preprocess DIGGS XML into structured database.
    Returns: dict with locations, spt_data, cpt_data, vs_data, project_info
    output_path: path for JSON output (used when save_json=True)
    save_json: if True, write to output_path; if False, skip file write (for SQLite pipeline)
    """
    print(f"Preprocessing {os.path.basename(xml_path)}...")
    
    # Read file once to avoid repeated disk I/O (major speedup for large XML)
    with open(xml_path, 'rb') as f:
        xml_bytes = f.read()
    xml_io = io.BytesIO(xml_bytes)
    xml_text = xml_bytes.decode('utf-8', errors='replace')
    
    locations = {}  # {location_id: location_info}
    spt_data = []  # [{location_id, activity_id, depth_range, ...}]
    cpt_data = []  # [{location_id, test_id, ...}]
    vs_data = []   # [{location_id, test_id, ...}]
    project_info = {}  # {project_id: project_info}
    lithology_uscs = {}  # {location_id: [{from,to,legend_code,...}]}
    # Detailed test payloads (precomputed for fast frontend import)
    spt_activity_data_by_id = {}  # {activity_id: {activity_id, location_id, depth_from, depth_to, name, background{...}}}
    cpt_test_data_by_id = {}      # {test_id: {test_id, location_id, depths,qc,fs,u2,units,background{...}}}

    # Pass 0: Extract project information
    print("  Pass 0: Extracting project information...")
    xml_io.seek(0)
    project_info = extract_project_info(xml_path, xml_source=xml_io)
    print(f"    Found {len(project_info)} project(s)")

    # Pass 0.5: Extract USCS lithology (use xml_path to avoid stream reuse bugs during upload)
    print("  Pass 0.5: Extracting USCS lithology...")
    lithology_uscs = extract_uscs_lithology(xml_path, xml_source=None)
    print(f"    Found USCS lithology for {len(lithology_uscs)} location(s)")

    # Pass 0.6: Extract bulk density (unit weight) and enrich lithology
    bulk_lookup = _extract_bulk_density_by_sample(xml_path, xml_text=xml_text)
    if bulk_lookup:
        print(f"  Pass 0.6: Enriching lithology with {len(bulk_lookup)} bulk density sample(s)...")
        for loc_id, intervals in lithology_uscs.items():
            if not isinstance(intervals, list):
                continue
            for it in intervals:
                gamma = _find_unit_weight_for_interval(
                    bulk_lookup, loc_id, it.get("from"), it.get("to"), tol_ft=5.0
                )
                if gamma is not None:
                    it["unit_weight"] = gamma
        print(f"    Enriched lithology with unit_weight where bulk density available")
    else:
        print("  Pass 0.6: No bulk density data found (optional)")

    # Pass 1: Extract all locations (Borehole and Sounding)
    # Use both start and end events to ensure we capture all data before clearing
    print("  Pass 1: Extracting locations...")
    pending_locations = {}  # Store elements until we can fully extract them
    
    # First pass: collect all Borehole/Sounding elements
    xml_io.seek(0)
    for event, elem in ET.iterparse(xml_io, events=("start", "end")):
        t = local_tag(elem.tag)
        if t in ("Borehole", "Sounding"):
            if event == "start":
                # Mark that we're starting to parse this element
                pending_locations[elem] = t
            elif event == "end" and elem in pending_locations:
                # Now extract all data before clearing
                info = extract_location_info(elem, pending_locations[elem])
                if info and info.get("id"):
                    if info.get("latitude") is not None and info.get("longitude") is not None:
                        locations[info["id"]] = info
                del pending_locations[elem]
                elem.clear()
    
    print(f"    Found {len(locations)} locations with coordinates")

    # Pass 2: Extract SPT data using regex (more reliable for xlink attributes)
    print("  Pass 2: Extracting SPT data...")
    import re
    # Pre-extract PI/FC lookup from AtterbergLimitsTest and ParticleSizeTest (sieveAnalysis)
    pi_fc_lookup = _extract_pi_fc_lookup_from_xml(xml_path, xml_text=xml_text)
    # Enrich each lithology interval with PI and FC by depth (each soil class interval has corresponding pi, fc)
    for loc_id, intervals in lithology_uscs.items():
        if not isinstance(intervals, list):
            continue
        for it in intervals:
            pi_fc = _find_pi_fc_for_depth(pi_fc_lookup, loc_id, it.get("from"), it.get("to"), tol_ft=3.0)
            it["pi"] = pi_fc.get("pi", "NP")
            it["fc"] = pi_fc.get("fc")
    # Pre-extract all SamplingActivity IDs and their samplingFeatureRefs using regex (use pre-read xml_text)
    spt_id_to_location = {}  # {activity_id: location_id}
    spt_id_to_depth_range = {}  # {activity_id: {"from": ft, "to": ft}}
    # Find all SamplingActivity with SPT in ID or samplingMethod
    # Pattern: <SamplingActivity gml:id="SPT_SA_B-101_..." ...> ... <samplingFeatureRef xlink:href="#Location_B-101"/>
    for match in re.finditer(r'<SamplingActivity[^>]*gml:id="([^"]+)"[^>]*>', xml_text):
        activity_id = match.group(1)
        if "SPT" in activity_id.upper():
            # Find the samplingFeatureRef within this activity (next 2000 chars)
            start_pos = match.end()
            end_pos = min(start_pos + 2000, len(xml_text))
            activity_section = xml_text[start_pos:end_pos]
            # Look for samplingFeatureRef xlink:href
            href_match = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', activity_section)
            if href_match:
                location_id = href_match.group(1)
                spt_id_to_location[activity_id] = location_id
            # Depth range is commonly expressed as a gml:posList near samplingLocation.
            # Note: in this dataset, samplingLocation can be empty in the parsed tree, so we use regex on text.
            depth_match = re.search(r'<samplingLocation[^>]*>.*?<gml:posList[^>]*>(.*?)</gml:posList>', activity_section, re.DOTALL)
            if depth_match:
                try:
                    depths = [float(x) for x in depth_match.group(1).strip().split() if x.strip()]
                    if len(depths) >= 2:
                        spt_id_to_depth_range[activity_id] = {"from": depths[0], "to": depths[1]}
                except Exception:
                    pass

    # Now iterate XML to get additional details
    xml_io.seek(0)
    for event, elem in ET.iterparse(xml_io, events=("end",)):
        t = local_tag(elem.tag)
        if t == "SamplingActivity":
            gid = elem.attrib.get(GML_ID_ATTR) or elem.attrib.get("gml:id") or elem.attrib.get("id") or ""
            
            # Check if this activity is in our pre-extracted SPT list
            if gid in spt_id_to_location:
                location_id = spt_id_to_location[gid]
                
                # Extract depth range if available
                depth_range = spt_id_to_depth_range.get(gid)
                
                name_elem = elem.find(f".//{{{GML_NS}}}name")
                name = (name_elem.text or "").strip() if name_elem is not None and name_elem.text else ""
                spt_data.append({
                    "activity_id": gid,
                    "location_id": location_id,
                    "name": name,
                    "depth_range": depth_range,
                })
        elem.clear()
    
    print(f"    Found {len(spt_data)} SPT activities")
    spt_meta_by_id = {x["activity_id"]: x for x in spt_data if x.get("activity_id")}
    # Helper key: (location_id, depth_from, depth_to) -> activity_id for joining to Test blocks
    spt_key_to_activity = {}
    for a_id, meta in spt_meta_by_id.items():
        dr = meta.get("depth_range") or {}
        if not isinstance(dr, dict):
            continue
        loc = meta.get("location_id")
        df = dr.get("from")
        dt = dr.get("to")
        try:
            if loc and df is not None and dt is not None:
                k = (str(loc), round(float(df), 3), round(float(dt), 3))
                spt_key_to_activity[k] = a_id
        except Exception:
            continue

    # Pass 3: Extract CPT and VS data using iterparse (fast; avoids slow char-by-char regex)
    print("  Pass 3: Extracting CPT and VS data...")
    cpt_id_to_location = {}
    vs_id_to_location = {}

    def _extract_cpt_payload_from_test_section(test_id, test_section):
        out = {
            "test_id": test_id,
            "location_id": None,
            "depths": [],
            "qc": [],
            "fs": [],
            "u2": [],
            "units": {},
            "background": {}
        }
        mloc = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', test_section)
        if mloc:
            out["location_id"] = mloc.group(1).strip()
        mdepth = re.search(r'<MultiPointLocation[^>]*>.*?<gml:posList[^>]*>(.*?)</gml:posList>', test_section, re.DOTALL)
        if not mdepth:
            mdepth = re.search(r'<gml:posList[^>]*>(.*?)</gml:posList>', test_section, re.DOTALL)
        if mdepth:
            try:
                out["depths"] = [float(x) for x in mdepth.group(1).strip().split() if x.strip()]
            except Exception:
                pass
        try:
            for idx, name, unit in re.findall(r'<Property[^>]*index="(\d+)"[^>]*>.*?<propertyName>(.*?)</propertyName>.*?<uom>(.*?)</uom>', test_section, re.DOTALL):
                nm = (name or '').strip()
                um = (unit or '').strip()
                if nm:
                    out["units"][nm] = um
        except Exception:
            pass
        mdata = re.search(r'<dataValues[^>]*>(.*?)</dataValues>', test_section, re.DOTALL)
        if mdata:
            data_text = mdata.group(1).strip()
            lines = [l.strip() for l in data_text.split('\n') if l.strip()]
            for line in lines:
                try:
                    values = [float(x.strip()) for x in line.split(',') if x.strip()]
                    if len(values) >= 3:
                        out["qc"].append(values[0])
                        out["fs"].append(values[1])
                        out["u2"].append(values[2])
                except Exception:
                    continue
        pm = re.search(r'<diggs:StaticConePenetrationTest[^>]*>(.*?)</diggs:StaticConePenetrationTest>', test_section, re.DOTALL)
        if pm:
            pc = pm.group(1)
            def _m(tag):
                mm = re.search(rf'<diggs:{tag}[^>]*>(.*?)</diggs:{tag}>', pc, re.DOTALL)
                return (mm.group(1).strip() if mm else None)
            pt = _m('penetrometerType')
            if pt: out["background"]["penetrometerType"] = pt
            dm = re.search(r'<diggs:distanceTipToSleeve[^>]*uom=["\']([^"\']+)["\'][^>]*>([^<]+)</diggs:distanceTipToSleeve>', pc)
            if dm:
                out["background"]["distanceTipToSleeve_uom"] = dm.group(1).strip()
                out["background"]["distanceTipToSleeve"] = dm.group(2).strip()
            na = _m('netAreaRatioCorrection')
            if na: out["background"]["netAreaRatioCorrection"] = na
            pr = re.search(r'<diggs:penetrationRate[^>]*uom=["\']([^"\']+)["\'][^>]*>([^<]+)</diggs:penetrationRate>', pc)
            if pr:
                out["background"]["penetrationRate_uom"] = pr.group(1).strip()
                out["background"]["penetrationRate"] = pr.group(2).strip()
            ta = re.search(r'<diggs:tipArea[^>]*uom=["\']([^"\']+)["\'][^>]*>([^<]+)</diggs:tipArea>', pc)
            if ta:
                out["background"]["tipArea_uom"] = ta.group(1).strip()
                out["background"]["tipArea"] = ta.group(2).strip()
            eq = re.search(r'<testProcedureEquipment>.*?<Equipment[^>]*>.*?<serialNumber>([^<]+)</serialNumber>', pc, re.DOTALL)
            if eq:
                out["background"]["serialNumber"] = eq.group(1).strip()
        return out

    def _extract_spt_background_from_test_section(test_section):
        bg = {}
        pm = re.search(r'<diggs:DrivenPenetrationTest[^>]*>(.*?)</diggs:DrivenPenetrationTest>', test_section, re.DOTALL)
        if pm:
            pc = pm.group(1)
            mt = re.search(r'<diggs:hammerType>(.*?)</diggs:hammerType>', pc, re.DOTALL)
            if mt: bg["hammerType"] = mt.group(1).strip()
            me = re.search(r'<diggs:hammerEfficiency[^>]*>([^<]+)</diggs:hammerEfficiency>', pc)
            if me: bg["hammerEfficiency"] = me.group(1).strip()
            tp = re.search(r'<diggs:totalPenetration[^>]*>([^<]+)</diggs:totalPenetration>', pc)
            if tp: bg["totalPenetration"] = tp.group(1).strip()
            drive_sets = []
            for ds in re.finditer(r'<diggs:DriveSet[^>]*>(.*?)</diggs:DriveSet>', pc, re.DOTALL):
                dsc = ds.group(1)
                d = {}
                im = re.search(r'<diggs:index>([^<]+)</diggs:index>', dsc)
                if im: d["index"] = im.group(1).strip()
                bm = re.search(r'<diggs:blowCount>([^<]+)</diggs:blowCount>', dsc)
                if bm: d["blowCount"] = bm.group(1).strip()
                pm2 = re.search(r'<diggs:penetration[^>]*>([^<]+)</diggs:penetration>', dsc)
                if pm2: d["penetration"] = pm2.group(1).strip()
                if d: drive_sets.append(d)
            if drive_sets:
                bg["driveSets"] = drive_sets
        nv = re.search(r'<dataValues[^>]*>([^<]+)</dataValues>', test_section, re.DOTALL)
        if nv:
            bg["nValue"] = nv.group(1).strip()
        return bg

    # Pass 3: Use regex on raw xml_text (iterparse loses xlink:href; fast str.find for </Test>)
    pos = 0
    test_open = "<Test "
    test_close = "</Test>"
    while True:
        idx = xml_text.find(test_open, pos)
        if idx < 0:
            break
        end_idx = xml_text.find(test_close, idx)
        if end_idx < 0:
            break
        end_idx += len(test_close)
        test_section = xml_text[idx:end_idx]
        pos = end_idx
        # Extract test_id from opening tag
        id_m = re.search(r'gml:id=["\']([^"\']+)["\']', test_section[:500])
        test_id = id_m.group(1) if id_m else ""
        href_match = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', test_section)
        if not href_match:
            continue
        location_id = href_match.group(1).strip()
        is_cpt = "CPT" in test_id.upper()
        if not is_cpt:
            is_cpt = bool(re.search(r'<[^:>]*:?StaticConePenetrationTest', test_section, re.IGNORECASE))
        if is_cpt:
            cpt_id_to_location[test_id] = location_id
            cpt_data.append({"test_id": test_id, "location_id": location_id, "name": ""})
            try:
                cpt_test_data_by_id[test_id] = _extract_cpt_payload_from_test_section(test_id, test_section)
            except Exception:
                pass
        vs_keywords = ["shear_wave_velocity", "shear wave velocity", "vs30", " vs", "vs "]
        if any(kw in test_section.lower() for kw in vs_keywords):
            vs_id_to_location[test_id] = location_id
            nm = re.search(r'<gml:name[^>]*>([^<]*)</gml:name>', test_section)
            vs_data.append({"test_id": test_id, "location_id": location_id, "name": (nm.group(1).strip() if nm else "")})
        try:
            if re.search(r'<diggs:DrivenPenetrationTest[^>]*>', test_section):
                mloc = re.search(r'<samplingFeatureRef[^>]*xlink:href=["\']#?([^"\']+)["\']', test_section)
                loc = (mloc.group(1).strip() if mloc else None) or location_id
                mdr = re.search(r'<LinearExtent[^>]*>.*?<gml:posList[^>]*>(.*?)</gml:posList>', test_section, re.DOTALL)
                df = dt = None
                if mdr:
                    try:
                        dd = [float(x) for x in mdr.group(1).strip().split() if x.strip()]
                        if len(dd) >= 2:
                            df, dt = dd[0], dd[1]
                    except Exception:
                        df = dt = None
                activity_id = None
                if loc and df is not None and dt is not None:
                    activity_id = spt_key_to_activity.get((str(loc), round(float(df), 3), round(float(dt), 3)))
                if activity_id and activity_id not in spt_activity_data_by_id:
                    meta = spt_meta_by_id.get(activity_id) or {}
                    dr = meta.get("depth_range") or {}
                    bg = _extract_spt_background_from_test_section(test_section)
                    loc_id = meta.get("location_id") or loc
                    df_val = dr.get("from") if isinstance(dr, dict) else df
                    dt_val = dr.get("to") if isinstance(dr, dict) else dt
                    pi_fc = _find_pi_fc_for_depth(pi_fc_lookup, loc_id, df_val, dt_val)
                    bg["pi"] = pi_fc.get("pi", "NP")
                    bg["fc"] = pi_fc.get("fc")
                    spt_activity_data_by_id[activity_id] = {
                        "activity_id": activity_id,
                        "location_id": loc_id,
                        "depth_from": df_val,
                        "depth_to": dt_val,
                        "name": meta.get("name") or "",
                        "background": bg,
                    }
        except Exception:
            pass

    print(f"    Found {len(cpt_id_to_location)} CPT, {len(vs_id_to_location)} VS")
    print(f"    Found {len(cpt_data)} CPT tests")
    print(f"    Found {len(vs_data)} VS tests")
    print(f"    Precomputed CPT payloads: {len(cpt_test_data_by_id)}")
    print(f"    Precomputed SPT payloads: {len(spt_activity_data_by_id)}")

    # Build summary statistics
    location_stats = {}
    for loc_id, loc in locations.items():
        spt_count = sum(1 for spt in spt_data if spt["location_id"] == loc_id)
        cpt_count = sum(1 for cpt in cpt_data if cpt["location_id"] == loc_id)
        vs_count = sum(1 for vs in vs_data if vs["location_id"] == loc_id)
        location_stats[loc_id] = {
            "spt_count": spt_count,
            "cpt_count": cpt_count,
            "vs_count": vs_count,
        }

    # Build location test lists (for dropdown menus)
    location_tests = {}  # {location_id: {cpt_tests: [...], spt_tests: [...]}}
    for loc_id in locations.keys():
        location_tests[loc_id] = {
            "cpt_tests": [cpt["test_id"] for cpt in cpt_data if cpt["location_id"] == loc_id],
            "spt_tests": [spt["activity_id"] for spt in spt_data if spt["location_id"] == loc_id],
        }

    # Build database structure
    db = {
        "metadata": {
            "source_file": os.path.basename(xml_path),
            "source_mtime": os.path.getmtime(xml_path),
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "total_locations": len(locations),
            "total_spt_activities": len(spt_data),
            "total_cpt_tests": len(cpt_data),
            "total_vs_tests": len(vs_data),
        },
        "project_info": project_info,
        "locations": locations,
        "lithology_uscs": lithology_uscs,
        "spt_activity_data_by_id": spt_activity_data_by_id,
        "cpt_test_data_by_id": cpt_test_data_by_id,
        "spt_data": spt_data,
        "cpt_data": cpt_data,
        "vs_data": vs_data,
        "location_stats": location_stats,  # Quick lookup: location_id -> {spt_count, cpt_count, vs_count}
        "location_tests": location_tests,  # Quick lookup: location_id -> {cpt_tests: [...], spt_tests: [...]}
    }

    # Save to JSON (optional)
    if save_json and output_path:
        print(f"  Saving to {os.path.basename(output_path)}...")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(db, f, ensure_ascii=False, indent=2)
        print(f"  Done! Database size: {os.path.getsize(output_path) / 1024 / 1024:.2f} MB")
    elif not save_json:
        print(f"  Skipping JSON write (SQLite pipeline)")
    return db


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python preprocess_diggs_to_db.py <input.xml> [output.json]")
        sys.exit(1)
    
    xml_path = sys.argv[1]
    if not os.path.exists(xml_path):
        print(f"Error: XML file not found: {xml_path}")
        sys.exit(1)
    
    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cache_dir = os.path.join(base_dir, ".diggs_cache")
        os.makedirs(cache_dir, exist_ok=True)
        xml_base = os.path.splitext(os.path.basename(xml_path))[0]
        output_path = os.path.join(cache_dir, f"{xml_base}.db.json")
    
    try:
        db = preprocess_diggs_to_db(xml_path, output_path)
        print(f"\nSummary:")
        print(f"  Locations: {db['metadata']['total_locations']}")
        print(f"  SPT activities: {db['metadata']['total_spt_activities']}")
        print(f"  CPT tests: {db['metadata']['total_cpt_tests']}")
        print(f"  VS tests: {db['metadata']['total_vs_tests']}")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
