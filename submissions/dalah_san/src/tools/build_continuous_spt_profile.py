#!/usr/bin/env python3
"""
Build a continuous, equal-interval SPT profile from borehole XML.

Merges:
  - SPT discrete point data (Depth, SPT-N) using Zone of Influence (no interpolation)
  - Lithology interval data (Top, Bottom, Soil Type, PI, FC)

Geotechnical rules:
  - SPT zone of influence: ±0.75m (halfway to next test) or half of 1.5m drive
  - SPT zone must NOT cross lithology boundaries
  - No linear interpolation of N-values
  - Missing PI/FC → NaN (not zero)
"""

import xml.etree.ElementTree as ET
import pandas as pd
import numpy as np
from pathlib import Path


def _local_tag(tag):
    """Strip namespace from tag name."""
    if tag is None:
        return ""
    if isinstance(tag, str):
        return tag
    return tag.split("}")[-1] if "}" in tag else tag


def _text(elem, default=None):
    """Safely get element text."""
    if elem is None:
        return default
    t = elem.text
    return (t.strip() if t and t.strip() else default) if t else default


def _find_text(parent, *tag_names, default=None):
    """Find first matching child tag and return its text."""
    if parent is None:
        return default
    for name in tag_names:
        for child in parent.iter():
            if _local_tag(child.tag) == name:
                return _text(child, default)
    return default


def _find_all(parent, tag_name):
    """Find all descendants with given tag name."""
    if parent is None:
        return []
    return [c for c in parent.iter() if _local_tag(c.tag) == tag_name]


def _to_float(val, default=np.nan):
    """Convert to float, return default on failure."""
    if val is None or val == "" or (isinstance(val, str) and val.strip() == ""):
        return default
    try:
        return float(str(val).strip())
    except (ValueError, TypeError):
        return default


def _parse_spt_points(root, depth_tags=None, n_tags=None):
    """
    Extract SPT discrete points: [(depth_m, n_value), ...]
    Tries common tag names. Assumes depth in meters; if in ft, caller must convert.
    """
    depth_tags = depth_tags or ["Depth", "depth", "Depth_m", "depth_m", "midDepth", "MidDepth"]
    n_tags = n_tags or ["SPT-N", "SPT_N", "spt_n", "N", "nValue", "blowCount", "dataValues"]

    spt_points = []
    seen = set()

    def _collect_from_element(elem):
        depth_val = None
        n_val = None
        for c in elem.iter():
            lt = _local_tag(c.tag)
            if lt in depth_tags:
                v = _to_float(_text(c), default=None)
                if v is not None:
                    depth_val = v
            if lt in n_tags:
                t = _text(c)
                if t:
                    # dataValues may be "12" (SPT-N) or "LL,PL,PI" (Atterberg) - take first number if comma-sep
                    v = _to_float(t, default=None)
                    if v is not None and 0 <= v <= 200:
                        n_val = v
                    else:
                        parts = str(t).split(",")
                        for p in parts:
                            v = _to_float(p.strip(), default=None)
                            if v is not None and 0 <= v <= 200:
                                n_val = v
                                break

        if depth_val is not None and n_val is not None:
            key = (round(depth_val, 4), round(n_val, 2))
            if key not in seen:
                seen.add(key)
                spt_points.append((depth_val, n_val))

    # Common structures: SPT under Test, SamplingActivity, or direct SPT/DrivenPenetrationTest
    for elem in root.iter():
        _collect_from_element(elem)

    # Deduplicate by depth (keep first N at each depth)
    by_depth = {}
    for d, n in sorted(spt_points, key=lambda x: x[0]):
        if d not in by_depth:
            by_depth[d] = n
    spt_points = sorted(by_depth.items(), key=lambda x: x[0])

    return spt_points


def _parse_lithology_intervals(root, top_tags=None, bottom_tags=None, soil_tags=None,
                               pi_tags=None, fc_tags=None, depth_unit="m"):
    """
    Extract lithology intervals: [(top_m, bottom_m, soil_type, pi, fc), ...]
    """
    top_tags = top_tags or ["TopDepth", "topDepth", "DepthFrom", "depth_from", "from", "Top"]
    bottom_tags = bottom_tags or ["BottomDepth", "bottomDepth", "DepthTo", "depth_to", "to", "Bottom"]
    soil_tags = soil_tags or ["SoilType", "soil_type", "Soil_Type", "legendCode", "classificationCode",
                             "USCS", "Classification", "soil_class"]
    pi_tags = pi_tags or ["PI", "pi", "PlasticityIndex", "plasticity_index"]
    fc_tags = fc_tags or ["FC", "fc", "FinesContent", "fines_content", "percentPassing"]

    FT_TO_M = 0.3048

    intervals = []

    def _get_interval(elem):
        top = bottom = soil = pi = fc = None
        for c in elem.iter():
            lt = _local_tag(c.tag)
            if lt in top_tags:
                v = _to_float(_text(c), default=None)
                if v is not None:
                    top = v
            if lt in bottom_tags:
                v = _to_float(_text(c), default=None)
                if v is not None:
                    bottom = v
            if lt in soil_tags:
                t = _text(c)
                if t:
                    soil = str(t).strip()
            if lt in pi_tags:
                t = _text(c)
                if t and str(t).strip().upper() != "NP":
                    v = _to_float(t, default=None)
                    pi = v if v is not None and not np.isnan(v) else np.nan
                else:
                    pi = np.nan
            if lt in fc_tags:
                v = _to_float(_text(c), default=None)
                if v is not None and not np.isnan(v):
                    fc = v

        # posList: "top bottom" (DIGGS style)
        pl = elem.find(".//{*}posList") or elem.find(".//posList")
        if pl is not None and pl.text:
            parts = pl.text.strip().split()
            if len(parts) >= 2:
                try:
                    top = float(parts[0])
                    bottom = float(parts[1])
                except ValueError:
                    pass

        if top is not None and bottom is not None:
            if depth_unit.lower() in ("ft", "feet"):
                top *= FT_TO_M
                bottom *= FT_TO_M
            pi_val = np.nan if pi is None or (isinstance(pi, float) and np.isnan(pi)) else pi
            fc_val = np.nan if fc is None or (isinstance(fc, float) and np.isnan(fc)) else fc
            intervals.append((top, bottom, soil or "", pi_val, fc_val))

    # LithologyObservation, Layer, Stratum, etc.
    for tag in ["LithologyObservation", "Layer", "Stratum", "Interval", "Lithology"]:
        for elem in root.iter():
            if _local_tag(elem.tag) == tag:
                _get_interval(elem)

    # Fallback: any element with both top and bottom depth
    if not intervals:
        for elem in root.iter():
            top = _find_text(elem, *top_tags)
            bottom = _find_text(elem, *bottom_tags)
            if top is not None and bottom is not None:
                try:
                    t = float(str(top).strip())
                    b = float(str(bottom).strip())
                    if depth_unit.lower() in ("ft", "feet"):
                        t *= FT_TO_M
                        b *= FT_TO_M
                    soil = _find_text(elem, *soil_tags) or ""
                    intervals.append((t, b, soil, np.nan, np.nan))
                except ValueError:
                    pass

    # Deduplicate by (top, bottom), keep first
    seen = set()
    unique = []
    for t, b, st, p, f in sorted(intervals, key=lambda x: (x[0], x[1])):
        key = (round(t, 4), round(b, 4))
        if key not in seen:
            seen.add(key)
            unique.append((t, b, st, p, f))
    return unique


def _spt_zone_bounds(spt_depths, idx, half_spacing_m=0.75):
    """
    Zone of influence for SPT at index idx.
    Returns (z_low, z_high) in meters.
    Zone extends halfway to next test above and below.
    """
    z = spt_depths[idx]
    n = len(spt_depths)
    if n == 1:
        return (max(0, z - half_spacing_m), z + half_spacing_m)
    if idx == 0:
        next_below = spt_depths[idx + 1]
        mid = (z + next_below) / 2.0
        return (max(0, z - half_spacing_m), mid)
    if idx == n - 1:
        prev_above = spt_depths[idx - 1]
        mid = (prev_above + z) / 2.0
        return (mid, z + half_spacing_m)
    prev_above = spt_depths[idx - 1]
    next_below = spt_depths[idx + 1]
    mid_above = (prev_above + z) / 2.0
    mid_below = (z + next_below) / 2.0
    return (mid_above, mid_below)


def _clip_zone_to_lithology(z_low, z_high, lithology_intervals):
    """
    Clip SPT zone so it does NOT cross lithology boundaries.
    Returns (z_low_clipped, z_high_clipped) or None if zone is entirely outside lithology.
    """
    # Find which lithology interval contains the SPT midpoint
    mid = (z_low + z_high) / 2.0
    for top, bottom, _, _, _ in lithology_intervals:
        if top <= mid <= bottom:
            # Clip zone to this layer
            z_low_c = max(z_low, top)
            z_high_c = min(z_high, bottom)
            if z_low_c < z_high_c:
                return (z_low_c, z_high_c)
            return None
    return None


def build_continuous_spt_profile(xml_path, step_m=0.1, depth_unit="m", half_spacing_m=0.75):
    """
    Parse borehole XML and build a continuous equal-interval SPT profile.

    Parameters
    ----------
    xml_path : str or Path
        Path to the borehole XML file.
    step_m : float
        Grid spacing in meters (default 0.1).
    depth_unit : str
        'm' or 'ft' - unit of depths in XML (converted to m internally).
    half_spacing_m : float
        Half of SPT zone of influence in meters (default 0.75 for 1.5m spacing).

    Returns
    -------
    pandas.DataFrame
        Columns: ['Depth_m', 'Soil_Type', 'PI', 'FC', 'SPT_N_Raw']
    """
    xml_path = Path(xml_path)
    if not xml_path.exists():
        raise FileNotFoundError(f"XML file not found: {xml_path}")

    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except ET.ParseError as e:
        raise ValueError(f"Invalid XML: {e}") from e

    # 1. Parse SPT discrete points
    spt_points = _parse_spt_points(root)
    FT_TO_M = 0.3048
    if depth_unit.lower() in ("ft", "feet") and spt_points:
        spt_points = [(d * FT_TO_M, n) for d, n in spt_points]
    if not spt_points:
        spt_depths = []
        spt_values = []
    else:
        spt_depths = [p[0] for p in spt_points]
        spt_values = [p[1] for p in spt_points]

    # 2. Parse lithology intervals
    lithology_intervals = _parse_lithology_intervals(root, depth_unit=depth_unit)

    # 3. Determine max depth
    max_depth = 0.0
    if spt_depths:
        max_depth = max(max_depth, max(spt_depths) + half_spacing_m)
    for top, bottom, _, _, _ in lithology_intervals:
        max_depth = max(max_depth, bottom)
    if max_depth <= 0:
        return pd.DataFrame(columns=["Depth_m", "Soil_Type", "PI", "FC", "SPT_N_Raw"])

    # 4. Create equal-interval grid
    depths = np.arange(0, max_depth + step_m / 2, step_m)
    n_points = len(depths)

    soil_type = np.array([""] * n_points, dtype=object)
    pi = np.full(n_points, np.nan, dtype=float)
    fc = np.full(n_points, np.nan, dtype=float)
    spt_n = np.full(n_points, np.nan, dtype=float)

    # 5. Lithology mapping (interval → grid)
    for top, bottom, st, p, f in lithology_intervals:
        mask = (depths >= top) & (depths < bottom)
        soil_type[mask] = st or ""
        if p is not None and not (isinstance(p, float) and np.isnan(p)):
            pi[mask] = p
        if f is not None and not (isinstance(f, float) and np.isnan(f)):
            fc[mask] = f

    # 6. SPT-N mapping (zone of influence, clipped to lithology)
    for idx, (z_spt, n_val) in enumerate(zip(spt_depths, spt_values)):
        z_low, z_high = _spt_zone_bounds(spt_depths, idx, half_spacing_m)

        if lithology_intervals:
            clipped = _clip_zone_to_lithology(z_low, z_high, lithology_intervals)
            if clipped is None:
                continue
            z_low, z_high = clipped

        mask = (depths >= z_low) & (depths < z_high)
        spt_n[mask] = n_val

    # 7. Build DataFrame
    df = pd.DataFrame({
        "Depth_m": depths,
        "Soil_Type": soil_type,
        "PI": pi,
        "FC": fc,
        "SPT_N_Raw": spt_n,
    })

    return df


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Build continuous SPT profile from borehole XML")
    parser.add_argument("xml_path", help="Path to borehole XML file")
    parser.add_argument("--step", "-s", type=float, default=0.1, help="Grid step in meters (default: 0.1)")
    parser.add_argument("--output", "-o", help="Output CSV path (default: print to stdout)")
    parser.add_argument("--depth-unit", choices=["m", "ft"], default="m", help="Depth unit in XML")
    args = parser.parse_args()

    df = build_continuous_spt_profile(args.xml_path, step_m=args.step, depth_unit=args.depth_unit)
    if args.output:
        df.to_csv(args.output, index=False)
        print(f"Saved {len(df)} rows to {args.output}")
    else:
        print(df.to_string())
