#!/usr/bin/env python3
"""
Extract detailed CPT and SPT test data from DIGGS XML.
This script extracts the actual measurement data (qc, fs, u2 for CPT; N-values for SPT).
"""
import sys
import os
import json
import xml.etree.ElementTree as ET
import re
from datetime import datetime, timezone

GML_NS = "http://www.opengis.net/gml/3.2"
DIGGS_NS = "http://diggsml.org/schemas/3"
GML_ID_ATTR = f"{{{GML_NS}}}id"


def local_tag(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def extract_cpt_data(xml_path, test_id):
    """
    Extract CPT test data for a specific test_id.
    Returns: {
        "test_id": "...",
        "location_id": "...",
        "depths": [depth1, depth2, ...],  # in ft
        "qc": [qc1, qc2, ...],  # tip resistance in tonf[US]/ft2
        "fs": [fs1, fs2, ...],  # sleeve friction in tonf[US]/ft2
        "u2": [u1, u2, ...],   # pore pressure in tonf[US]/ft2
        "units": {"qc": "tonf[US]/ft2", "fs": "tonf[US]/ft2", "u2": "tonf[US]/ft2"}
    }
    """
    result = {
        "test_id": test_id,
        "location_id": None,
        "depths": [],
        "qc": [],
        "fs": [],
        "u2": [],
        "units": {}
    }
    
    for event, elem in ET.iterparse(xml_path, events=("end",)):
        if local_tag(elem.tag) == "Test":
            gid = elem.attrib.get(GML_ID_ATTR) or elem.attrib.get("gml:id") or ""
            if gid != test_id:
                elem.clear()
                continue
            
            # Extract location_id
            sf_ref = elem.find(".//{*}samplingFeatureRef")
            if sf_ref is not None:
                sf_href = sf_ref.attrib.get("xlink:href") or ""
                result["location_id"] = sf_href[1:] if sf_href.startswith("#") else sf_href
            
            # Extract depth from location/MultiPointLocation/gml:posList
            location = elem.find(".//{*}location")
            if location is not None:
                pos_list = location.find(f".//{{{GML_NS}}}posList")
                if pos_list is None:
                    pos_list = location.find(".//{*}posList")
                if pos_list is not None and pos_list.text:
                    try:
                        depths = [float(x) for x in pos_list.text.strip().split()]
                        result["depths"] = depths
                    except:
                        pass
            
            # Extract test data from results/ResultSet/dataValues
            results = elem.find(".//{*}results")
            if results is not None:
                result_set = results.find(".//{*}ResultSet")
                if result_set is not None:
                    # Get parameter definitions to understand column order
                    params = result_set.find(".//{*}parameters")
                    param_order = []
                    if params is not None:
                        properties = params.findall(".//{*}Property")
                        for prop in properties:
                            prop_name = prop.find(".//{*}propertyName")
                            if prop_name is not None and prop_name.text:
                                param_order.append(prop_name.text.strip())
                    
                    # Extract data values
                    data_values = result_set.find(".//{*}dataValues")
                    if data_values is not None and data_values.text:
                        lines = data_values.text.strip().split('\n')
                        for line in lines:
                            line = line.strip()
                            if not line:
                                continue
                            # Parse CSV: qc,fs,u2
                            try:
                                values = [float(x.strip()) for x in line.split(',')]
                                if len(values) >= 3:
                                    # Map to qc, fs, u2 based on param_order or default order
                                    if len(param_order) >= 3:
                                        # Use param_order to map
                                        for i, val in enumerate(values):
                                            if i < len(param_order):
                                                param_name = param_order[i]
                                                if param_name == "qc":
                                                    result["qc"].append(val)
                                                elif param_name == "fs":
                                                    result["fs"].append(val)
                                                elif param_name == "u2":
                                                    result["u2"].append(val)
                                    else:
                                        # Default order: qc, fs, u2
                                        if len(values) >= 1:
                                            result["qc"].append(values[0])
                                        if len(values) >= 2:
                                            result["fs"].append(values[1])
                                        if len(values) >= 3:
                                            result["u2"].append(values[2])
                            except:
                                pass
                    
                    # Extract units
                    properties = result_set.findall(".//{*}Property")
                    for prop in properties:
                        prop_name = prop.find(".//{*}propertyName")
                        uom = prop.find(".//{*}uom")
                        if prop_name is not None and prop_name.text and uom is not None and uom.text:
                            param_name = prop_name.text.strip()
                            result["units"][param_name] = uom.text.strip()
            
            elem.clear()
            break
        elem.clear()
    
    return result


def extract_spt_data(xml_path, activity_id):
    """
    Extract SPT activity data.
    Returns: {
        "activity_id": "...",
        "location_id": "...",
        "depth_from": float,  # in ft
        "depth_to": float,   # in ft
        "name": "...",
        "n_value": None  # SPT N-value if available (need to check Test elements)
    }
    """
    result = {
        "activity_id": activity_id,
        "location_id": None,
        "depth_from": None,
        "depth_to": None,
        "name": "",
        "n_value": None
    }
    
    for event, elem in ET.iterparse(xml_path, events=("end",)):
        if local_tag(elem.tag) == "SamplingActivity":
            gid = elem.attrib.get(GML_ID_ATTR) or elem.attrib.get("gml:id") or ""
            if gid != activity_id:
                elem.clear()
                continue
            
            # Extract location_id
            sf_ref = elem.find(".//{*}samplingFeatureRef")
            if sf_ref is not None:
                sf_href = sf_ref.attrib.get("xlink:href") or ""
                result["location_id"] = sf_href[1:] if sf_href.startswith("#") else sf_href
            
            # Extract depth range
            loc = elem.find(".//{*}samplingLocation")
            if loc is not None:
                pos_list = loc.find(f".//{{{GML_NS}}}posList")
                if pos_list is None:
                    pos_list = loc.find(".//{*}posList")
                if pos_list is not None and pos_list.text:
                    try:
                        depths = [float(x) for x in pos_list.text.strip().split()]
                        if len(depths) >= 2:
                            result["depth_from"] = depths[0]
                            result["depth_to"] = depths[1]
                    except:
                        pass
            
            # Extract name
            name_elem = elem.find(f".//{{{GML_NS}}}name")
            if name_elem is not None and name_elem.text:
                result["name"] = name_elem.text.strip()
            
            elem.clear()
            break
        elem.clear()
    
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python extract_cpt_spt_data.py <xml_file> <test_type> <test_id>")
        print("  test_type: 'cpt' or 'spt'")
        print("  test_id: test ID to extract")
        sys.exit(1)
    
    xml_path = sys.argv[1]
    test_type = sys.argv[2].lower()
    test_id = sys.argv[3]
    
    if test_type == "cpt":
        data = extract_cpt_data(xml_path, test_id)
        print(json.dumps(data, indent=2))
    elif test_type == "spt":
        data = extract_spt_data(xml_path, test_id)
        print(json.dumps(data, indent=2))
    else:
        print(f"Unknown test type: {test_type}")
        sys.exit(1)
