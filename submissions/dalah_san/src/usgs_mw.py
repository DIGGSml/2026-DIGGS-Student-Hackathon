import requests


def _find_value_in_json(data, target_name):
    """Recursively search JSON for a dict with name == target_name and return its 'data' field."""
    if isinstance(data, dict):
        if data.get('name') == target_name:
            return data.get('data')
        for value in data.values():
            found = _find_value_in_json(value, target_name)
            if found:
                return found
    elif isinstance(data, list):
        for item in data:
            found = _find_value_in_json(item, target_name)
            if found:
                return found
    return None


def _find_data_by_name_contains(data, substrings):
    """
    Fuzzy match helper: find the first dict with a 'name' containing any of substrings (case-insensitive),
    and return its 'data' field.
    """
    if not substrings:
        return None
    if isinstance(substrings, str):
        substrings = [substrings]
    needles = [s.casefold() for s in substrings if s]

    if isinstance(data, dict):
        name = data.get('name')
        if isinstance(name, str):
            n = name.casefold()
            if any(needle in n for needle in needles):
                return data.get('data')
        for value in data.values():
            found = _find_data_by_name_contains(value, needles)
            if found:
                return found
    elif isinstance(data, list):
        for item in data:
            found = _find_data_by_name_contains(item, needles)
            if found:
                return found
    return None


def _parse_disagg_mean_mode(data_list):
    """Parse USGS disagg data list (list of {name,value}) to dict."""
    if not isinstance(data_list, list):
        return {}
    out = {}
    for param in data_list:
        if not isinstance(param, dict):
            continue
        n = param.get('name')
        v = param.get('value')
        if n == 'm':
            out['Mw'] = v
        elif n == 'r':
            out['Distance_km'] = v
        elif n in ['ε₀', 'epsilon0', 'eps0', 'e0']:
            out['Epsilon'] = v
    return out


def get_usgs_deaggregation_mw(lat, lon, disagg_model='conus-2023', vs30=760, return_period=2475, timeout=60):
    """
    USGS NSHMP Hazard Disaggregation API (dynamic/disagg): get Mean Mw / Mode Mw for PGA.

    Parameters:
    - lat, lon: coordinates
    - disagg_model: conus-2018 / conus-2023 / alaska-2023 / hawaii-2021
    - vs30: m/s
    - return_period: years (e.g., 475, 2475)
    """
    try:
        model = (disagg_model or 'conus-2023').strip()
        vs30_val = int(vs30) if vs30 is not None else 760
        rp_val = int(return_period) if return_period is not None else 2475

        # dynamic disagg endpoint (note lon/lat order)
        url = f"https://earthquake.usgs.gov/ws/nshmp/{model}/dynamic/disagg/{lon}/{lat}/{vs30_val}/{rp_val}"
        params = {"out": "DISAGG_DATA", "imt": "PGA"}

        print(f"DEBUG: Disagg request url={url} params={params}")
        resp = requests.get(url, params=params, timeout=timeout)
        if resp.status_code != 200:
            print(f"DEBUG: Disagg HTTP {resp.status_code}: {resp.text[:200] if resp.text else ''}")
            return None

        payload = resp.json()

        # Robust search: Mean first, then Mode
        mean_list = (
            _find_value_in_json(payload, 'Mean (over all sources)')
            or _find_value_in_json(payload, 'Mean (all sources)')
            or _find_data_by_name_contains(payload, ['mean', 'over all sources'])
            or _find_data_by_name_contains(payload, ['mean', 'all sources'])
            or _find_data_by_name_contains(payload, ['mean'])
        )
        mode_list = (
            _find_value_in_json(payload, 'Mode (largest m-r-ε₀ bin)')
            or _find_data_by_name_contains(payload, ['mode', 'largest'])
            or _find_data_by_name_contains(payload, ['mode'])
        )

        mean_parsed = _parse_disagg_mean_mode(mean_list) if mean_list else {}
        mode_parsed = _parse_disagg_mean_mode(mode_list) if mode_list else {}

        out = {
            "meanMw": float(mean_parsed.get('Mw')) if mean_parsed.get('Mw') is not None else None,
            "modeMw": float(mode_parsed.get('Mw')) if mode_parsed.get('Mw') is not None else None,
            "meanDistanceKm": float(mean_parsed.get('Distance_km')) if mean_parsed.get('Distance_km') is not None else None,
            "meanEpsilon": float(mean_parsed.get('Epsilon')) if mean_parsed.get('Epsilon') is not None else None,
            "modeDistanceKm": float(mode_parsed.get('Distance_km')) if mode_parsed.get('Distance_km') is not None else None,
            "modeEpsilon": float(mode_parsed.get('Epsilon')) if mode_parsed.get('Epsilon') is not None else None,
            "disaggModel": model,
            "vs30": vs30_val,
            "returnPeriod": rp_val,
            "imt": "PGA"
        }

        if out["meanMw"] is None and out["modeMw"] is None:
            return None

        return out
    except Exception as e:
        print(f"Error in get_usgs_deaggregation_mw: {e}")
        return None


