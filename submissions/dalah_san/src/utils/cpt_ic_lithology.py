"""
Derive lithology (soil class) from CPT data using Ic (Robertson Soil Behavior Type Index).
- 2-5 ft intervals
- For each interval: compute Ic at each CPT point, map to soil class, use mode (most frequent)
"""
import numpy as np
from collections import Counter

# Robertson Ic (2009) to USCS-like soil class
IC_TO_SOIL_CLASS = [
    (1.31, "SP"),
    (1.64, "SP-SM"),
    (2.05, "SM"),
    (2.60, "CL-ML"),
    (float("inf"), "CL"),
]


def _ic_to_soil_class(ic: float) -> str:
    """Map Ic to soil class (Robertson SBT zones)."""
    if ic is None or np.isnan(ic):
        return "SM"
    ic = float(ic)
    for threshold, code in IC_TO_SOIL_CLASS:
        if ic < threshold:
            return code
    return "CL"


def _compute_ic_at_depth(depth_m, qt, fs, sigma_v, sigma_ve, pa=101.325):
    """Compute Ic from CPT point (Robertson & Wride)."""
    if qt is None or fs is None or sigma_v is None or sigma_ve is None:
        return None
    qt = max(float(qt), 1.0)
    fs = max(float(fs), 0.1)
    denom = max(qt - sigma_v, 0.01 * pa)
    F = (fs / denom) * 100.0
    F_safe = max(F, 0.1)
    n = 1.0
    Cn = min((pa / max(sigma_ve, 1.0)) ** n, 1.7)
    Q = (qt - sigma_v) / pa * Cn
    Q = max(Q, 0.1)
    ic = float(np.sqrt((3.47 - np.log10(Q)) ** 2 + (np.log10(F_safe) + 1.22) ** 2))
    return ic


def derive_lithology_from_cpt(depths, qc, fs, u2=None, interval_ft=3.0, depth_unit="ft", qc_fs_unit="kPa", an=0.8):
    """
    Derive lithology intervals from CPT data using Ic.
    depths, qc, fs: lists. If lengths differ, truncate to minimum (handles malformed DIGGS).
    interval_ft: layer thickness (2-5 ft). Default 3 ft.
    depth_unit: "ft" or "m"
    qc_fs_unit: "kPa", "MPa", or "tsf" - input units for qc/fs
    Returns: [{from, to, soil_class, legend_code}]
    """
    if not depths or not qc or not fs:
        return []
    n = min(len(depths), len(qc), len(fs))
    if n < 2:
        return []
    depths = [float(d) for d in depths[:n]]
    qc = [float(x) for x in qc[:n]]
    fs = [float(x) for x in fs[:n]]
    # Convert qc/fs to kPa for Ic formula
    if (qc_fs_unit or "").strip().lower() in ("mpa", "mPa"):
        scale = 1000.0
    elif (qc_fs_unit or "").strip().lower() in ("tsf",):
        scale = 95.76
    else:
        scale = 1.0
    qc = [x * scale for x in qc]
    fs = [x * scale for x in fs]
    u2 = u2 if u2 and len(u2) >= n else [0.0] * n
    u2 = [float(x) * scale for x in u2[:n]]

    # Convert to m for stress calc
    if depth_unit == "ft":
        to_m = 0.3048
    else:
        to_m = 1.0
    depths_m = [d * to_m for d in depths]

    # Unit weight estimate (Robertson & Cabal)
    pa = 101.325
    gamma_w = 9.81
    gamma_list = []
    sigma_v_list = []
    sigma_ve_list = []
    curr_sigma_v = 0.0
    for i in range(len(depths)):
        d = depths_m[i]
        qt_val = qc[i] + u2[i] * (1.0 - an)
        qt_val = max(qt_val, 1.0)
        rf = (fs[i] / qt_val) * 100.0 if qt_val > 0 else 0.1
        rf = max(rf, 0.1)
        sg = 0.27 * np.log10(rf) + 0.36 * np.log10(qt_val / pa) + 1.236
        gamma = np.clip(sg * gamma_w, 14.0, 23.0)
        gamma_list.append(float(gamma))
        thick = d - (depths_m[i - 1] if i > 0 else 0.0)
        thick = max(thick, 0.0)
        curr_sigma_v += gamma * thick
        sigma_v_list.append(curr_sigma_v)
        u0 = max(0.0, d * gamma_w)  # simplified: assume gwl at surface
        sigma_ve_list.append(max(curr_sigma_v - u0, 1.0))

    # Compute Ic and soil class per point
    ic_list = []
    soil_list = []
    for i in range(len(depths)):
        ic = _compute_ic_at_depth(
            depths_m[i], qc[i] + u2[i] * (1.0 - an), fs[i],
            sigma_v_list[i], sigma_ve_list[i] if i < len(sigma_ve_list) else sigma_v_list[i]
        )
        ic_list.append(ic)
        soil_list.append(_ic_to_soil_class(ic) if ic is not None else "SM")

    # Build 2-5 ft intervals
    interval_m = interval_ft * to_m
    d_min = min(depths)
    d_max = max(depths)
    intervals = []
    d_from = d_min
    while d_from < d_max:
        d_to = min(d_from + interval_ft, d_max)
        # Collect soil classes in this interval
        classes_in_interval = []
        for i in range(len(depths)):
            if d_from <= depths[i] < d_to:
                classes_in_interval.append(soil_list[i])
        if classes_in_interval:
            mode_class = Counter(classes_in_interval).most_common(1)[0][0]
        else:
            mode_class = "SM"
        intervals.append({
            "from": d_from,
            "to": d_to,
            "soil_class": mode_class,
            "legend_code": mode_class,
        })
        d_from = d_to
    return intervals
