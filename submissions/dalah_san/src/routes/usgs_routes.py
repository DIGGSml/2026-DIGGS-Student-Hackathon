"""
USGS API routes - earthquake parameters (ASCE 7-22/16, AASHTO 2009).
"""
import concurrent.futures
import requests
from flask import Blueprint, request, jsonify

from usgs_mw import get_usgs_deaggregation_mw


usgs_bp = Blueprint('usgs', __name__, url_prefix='/api/usgs')


@usgs_bp.route('/seismic', methods=['POST'])
def get_usgs_seismic():
    """Fetch USGS earthquake parameters for design codes (ASCE 7-22/16, AASHTO 2009)."""
    try:
        data = request.json

        # 1. Read basic parameters
        lat = data.get('latitude')
        lon = data.get('longitude')
        site_class = data.get('siteClass', 'BC')
        risk_category = data.get('riskCategory', 'II')
        # USGS NSHMP Hazard Disaggregation (for Mw)
        disagg_model = data.get('deaggModel', 'conus-2023')
        disagg_vs30 = data.get('deaggVs30', 760)
        # Always compute both 475yr (10% in 50) and 2475yr (2% in 50)
        disagg_return_periods = [475, 2475]

        # 2. Read design code (default ASCE 7-22)
        # Frontend values: 'asce7-22', 'asce7-16', 'aashto-2009'
        design_code = data.get('designCode', 'asce7-22')

        # 3. Design code to USGS API endpoint mapping
        CODE_MAP = {
            "asce7-22": "asce7-22",
            "asce7-16": "asce7-16",
            "aashto-2009": "aashto-2009",
        }

        if design_code not in CODE_MAP:
            return jsonify({"status": "error", "message": "Unsupported design code"}), 400

        # 4. Coordinate check (Western hemisphere)
        if lon and float(lon) > 0:
            return jsonify({
                "status": "error",
                "message": "Longitude is positive (Eastern hemisphere). For US locations use negative longitude (e.g. -122.4).",
            }), 400

        if not lat or not lon:
            return jsonify({"status": "error", "message": "Missing latitude/longitude"}), 400

        # 5. Build dynamic URL
        endpoint = CODE_MAP[design_code]
        url = f"https://earthquake.usgs.gov/ws/designmaps/{endpoint}.json"

        params = {
            "latitude": lat,
            "longitude": lon,
            "siteClass": site_class,
            "title": "Liquefaction Analysis",
        }
        if "asce" in design_code:
            params["riskCategory"] = risk_category

        try:
            response = requests.get(url, params=params, timeout=30)
        except requests.exceptions.Timeout:
            return jsonify({"status": "error", "message": "USGS API request timed out. Please try again later."}), 504
        except requests.exceptions.ConnectionError:
            return jsonify({"status": "error", "message": "Unable to connect to USGS API. Please check your network connection."}), 503
        except requests.exceptions.RequestException as e:
            return jsonify({"status": "error", "message": f"USGS API request failed: {str(e)}"}), 500

        if response.status_code == 200:
            usgs_data = response.json()

            response_data = None
            if "response" in usgs_data and "data" in usgs_data["response"]:
                response_data = usgs_data["response"]["data"]
            elif "response" in usgs_data:
                response_data = usgs_data["response"]
            elif "data" in usgs_data:
                response_data = usgs_data["data"]
            else:
                response_data = usgs_data

            pga_m = response_data.get("pgaM") or response_data.get("pga") if response_data else None

            if pga_m is None:

                def find_pga_in_dict(obj, depth=0):
                    if depth > 5:
                        return None
                    if isinstance(obj, dict):
                        for key, value in obj.items():
                            if key.lower() in ["pgam", "pga_m", "pga"] and isinstance(value, (int, float)):
                                return value
                            if isinstance(value, (dict, list)):
                                result = find_pga_in_dict(value, depth + 1)
                                if result is not None:
                                    return result
                    elif isinstance(obj, list):
                        for item in obj:
                            result = find_pga_in_dict(item, depth + 1)
                            if result is not None:
                                return result
                    return None

                pga_m = find_pga_in_dict(usgs_data)

            if pga_m is None:
                error_msg = response_data.get("error") or response_data.get("message") if response_data else None
                if error_msg:
                    return jsonify({
                        "status": "error",
                        "message": f"USGS API error: {error_msg}",
                        "debug": {
                            "designCode": design_code,
                            "response_keys": list(usgs_data.keys()) if isinstance(usgs_data, dict) else "Not a dict",
                            "response_data_keys": list(response_data.keys()) if isinstance(response_data, dict) else "Not a dict",
                        },
                    }), 400
                return jsonify({
                    "status": "error",
                    "message": "No USGS data for this location (may be outside US or data format issue)",
                    "debug": {
                        "designCode": design_code,
                        "response_keys": list(usgs_data.keys()) if isinstance(usgs_data, dict) else "Not a dict",
                        "response_data_keys": list(response_data.keys()) if isinstance(response_data, dict) else "Not a dict",
                        "full_response": str(usgs_data)[:500],
                    },
                }), 400

            sds = response_data.get("sds") if response_data else None
            sd1 = response_data.get("sd1") if response_data else None
            t_l = response_data.get("tL") or response_data.get("tl") if response_data else None

            mw_mean = mw_mode = mw_mean_dist = mw_mean_eps = None
            mw_mean_475 = mw_mode_475 = mw_mean_dist_475 = mw_mean_eps_475 = None
            mw_mean_2475 = mw_mode_2475 = mw_mean_dist_2475 = mw_mean_eps_2475 = None

            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                    futures = {
                        executor.submit(get_usgs_deaggregation_mw, lat, lon, disagg_model, disagg_vs30, rp): rp
                        for rp in disagg_return_periods
                    }
                    try:
                        for future in concurrent.futures.as_completed(futures, timeout=12):
                            rp = futures[future]
                            try:
                                mw_data = future.result()
                            except Exception:
                                continue
                            if not mw_data:
                                continue
                            if rp == 475:
                                mw_mean_475 = mw_data.get("meanMw")
                                mw_mode_475 = mw_data.get("modeMw")
                                mw_mean_dist_475 = mw_data.get("meanDistanceKm")
                                mw_mean_eps_475 = mw_data.get("meanEpsilon")
                            elif rp == 2475:
                                mw_mean_2475 = mw_data.get("meanMw")
                                mw_mode_2475 = mw_data.get("modeMw")
                                mw_mean_dist_2475 = mw_data.get("meanDistanceKm")
                                mw_mean_eps_2475 = mw_data.get("meanEpsilon")
                    except concurrent.futures.TimeoutError:
                        pass
            except Exception:
                pass

            mw_mean = mw_mean_2475
            mw_mode = mw_mode_2475
            mw_mean_dist = mw_mean_dist_2475
            mw_mean_eps = mw_mean_eps_2475

            return jsonify({
                "status": "success",
                "data": {
                    "designCode": design_code,
                    "pgaM": pga_m,
                    "sds": sds,
                    "sd1": sd1,
                    "tL": t_l,
                    "siteClass": site_class,
                    "latitude": lat,
                    "longitude": lon,
                    "meanMw": mw_mean,
                    "modeMw": mw_mode,
                    "meanDistanceKm": mw_mean_dist,
                    "meanEpsilon": mw_mean_eps,
                    "deaggModel": disagg_model,
                    "deaggVs30": disagg_vs30,
                    "deaggReturnPeriods": disagg_return_periods,
                    "meanMw475": mw_mean_475,
                    "modeMw475": mw_mode_475,
                    "meanDistanceKm475": mw_mean_dist_475,
                    "meanEpsilon475": mw_mean_eps_475,
                    "meanMw2475": mw_mean_2475,
                    "modeMw2475": mw_mode_2475,
                    "meanDistanceKm2475": mw_mean_dist_2475,
                    "meanEpsilon2475": mw_mean_eps_2475,
                    "note": "Mw values from USGS Hazard Disaggregation API (if available). Mean Mw at 2475yr is commonly used for liquefaction checks." if mw_mean_2475 else "USGS API did not return Mw for 2475yr. Please use a default Mw or check the USGS disaggregation report.",
                    "default_Mw": mw_mean_2475 if mw_mean_2475 else 7.5,
                },
            })

        if response.status_code == 502:
            return jsonify({"status": "error", "message": "USGS API server temporarily unavailable (502). Try again later.", "designCode": design_code}), 502
        if response.status_code == 503:
            return jsonify({"status": "error", "message": "USGS API service temporarily unavailable (503). Try again later.", "designCode": design_code}), 503
        if response.status_code == 504:
            return jsonify({"status": "error", "message": "USGS API request timed out (504). Try again later.", "designCode": design_code}), 504

        error_text = response.text[:500] if response.text else "No error message"
        return jsonify({
            "status": "error",
            "message": f"USGS API returned error (Status {response.status_code})",
            "details": error_text,
            "designCode": design_code,
        }), response.status_code

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
