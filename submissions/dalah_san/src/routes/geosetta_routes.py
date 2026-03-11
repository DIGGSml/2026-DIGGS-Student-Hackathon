"""
Geosetta API routes - borehole points proxy and local index DB.
"""
import os
import json
import requests
from flask import Blueprint, request, jsonify

from geosetta_index_db import (
    DEFAULT_DB_PATH as GEOSETTA_DB_PATH,
    db_connect,
    query_clusters_in_bbox,
    query_points_in_bbox,
)
from utils.env_loader import load_dotenv_if_present


def _get_project_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


geosetta_bp = Blueprint('geosetta', __name__, url_prefix='/api/geosetta')


@geosetta_bp.route('/points', methods=['POST'])
def geosetta_points_in_radius():
    """Proxy Geosetta Return_Historic_Data_In_Radius and return GeoJSON points."""
    try:
        data = request.json or {}
        lat = data.get('latitude')
        lon = data.get('longitude')
        radius_m = data.get('radius_m', 1000)
        want_debug = bool(data.get('debug', False))

        try:
            lat = float(lat)
            lon = float(lon)
            radius_m = float(radius_m)
        except Exception:
            return jsonify({"status": "error", "message": "Invalid latitude/longitude/radius_m"}), 400

        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            return jsonify({"status": "error", "message": "Latitude/longitude out of range"}), 400
        if radius_m <= 0 or radius_m > 50000:
            return jsonify({"status": "error", "message": "radius_m must be between 1 and 50000 meters"}), 400

        api_key = os.getenv('GEOSETTA_API_KEY', '').strip()
        if not api_key:
            load_dotenv_if_present(os.path.join(_get_project_root(), ".env"))
            api_key = os.getenv('GEOSETTA_API_KEY', '').strip()
        if not api_key:
            return jsonify({
                "status": "error",
                "message": "Missing GEOSETTA_API_KEY on server. Please set environment variable GEOSETTA_API_KEY."
            }), 500

        api_url = os.getenv('GEOSETTA_API_URL', '').strip() or "https://geosetta.org/web_map/api_key/"

        def _maybe_json_loads(x):
            if isinstance(x, (dict, list)):
                return x
            if isinstance(x, str):
                s = x.strip()
                if not s:
                    return x
                if (s.startswith('{') and s.endswith('}')) or (s.startswith('[') and s.endswith(']')):
                    try:
                        return json.loads(s)
                    except Exception:
                        return x
            return x

        def _find_feature_collection(obj, path="$", max_depth=10):
            if max_depth <= 0:
                return None, None
            obj = _maybe_json_loads(obj)
            if isinstance(obj, dict):
                if obj.get("type") == "FeatureCollection" and isinstance(obj.get("features"), list):
                    return obj, path
                for k in ["points_in_radius", "pointsInRadius", "points", "geojson", "geoJSON",
                          "featureCollection", "feature_collection", "features"]:
                    if k in obj:
                        fc, p = _find_feature_collection(obj.get(k), f"{path}.{k}", max_depth=max_depth - 1)
                        if fc is not None:
                            return fc, p
                for k, v in obj.items():
                    fc, p = _find_feature_collection(v, f"{path}.{k}", max_depth=max_depth - 1)
                    if fc is not None:
                        return fc, p
            elif isinstance(obj, list):
                for i, item in enumerate(obj):
                    fc, p = _find_feature_collection(item, f"{path}[{i}]", max_depth=max_depth - 1)
                    if fc is not None:
                        return fc, p
            return None, None

        def _normalize_feature_collection(fc):
            if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection":
                return fc
            features = fc.get("features")
            if not isinstance(features, list):
                return fc
            normalized = []
            for idx, item in enumerate(features):
                item = _maybe_json_loads(item)
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "Feature" and isinstance(item.get("geometry"), dict):
                    feat = dict(item)
                    props = feat.get("properties") or {}
                    if "title" not in props:
                        props["title"] = str(props.get("Name") or props.get("name") or props.get("Project Ref.") or props.get("Project Ref") or f"Borehole {idx + 1}")
                    feat["properties"] = props
                    normalized.append(feat)
                    continue
                geom_type = item.get("type")
                has_coords = "coordinates" in item
                if geom_type in {"Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon"} and has_coords:
                    props = item.get("properties") or {}
                    if "title" not in props:
                        props["title"] = str(props.get("Name") or props.get("name") or props.get("Project Ref.") or props.get("Project Ref") or f"Borehole {idx + 1}")
                    normalized.append({"type": "Feature", "geometry": {"type": geom_type, "coordinates": item.get("coordinates")}, "properties": props})
                    continue
                if "geometry" in item or "coordinates" in item:
                    normalized.append(item)
            out_fc = dict(fc)
            out_fc["features"] = normalized
            return out_fc

        payload = {
            "deliverableType": "Return_Historic_Data_In_Radius",
            "data": {"points": [{"latitude": lat, "longitude": lon, "radius_m": radius_m}]}
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

        try:
            resp = requests.post(api_url, headers=headers, json=payload, timeout=30)
        except requests.exceptions.Timeout:
            return jsonify({"status": "error", "message": "Geosetta API request timed out"}), 504
        except requests.exceptions.ConnectionError:
            return jsonify({"status": "error", "message": "Unable to connect to Geosetta API"}), 503
        except requests.exceptions.RequestException as e:
            return jsonify({"status": "error", "message": f"Geosetta API request failed: {str(e)}"}), 500

        if resp.status_code != 200:
            try:
                details = resp.json()
            except Exception:
                details = resp.text[:500]
            return jsonify({"status": "error", "message": f"Geosetta API error (HTTP {resp.status_code})", "details": details}), 502

        out = resp.json()
        candidates = []
        if isinstance(out, dict):
            results = out.get("results") or {}
            candidates = [
                ("$.results.points_in_radius", results.get("points_in_radius")),
                ("$.results.pointsInRadius", results.get("pointsInRadius")),
                ("$.results.geojson", results.get("geojson")),
                ("$.points_in_radius", out.get("points_in_radius")),
                ("$.geojson", out.get("geojson")),
                ("$.data.points_in_radius", (out.get("data") or {}).get("points_in_radius")),
                ("$.data.geojson", (out.get("data") or {}).get("geojson")),
            ]

        geojson = None
        found_path = None
        for p, c in candidates:
            c = _maybe_json_loads(c)
            if isinstance(c, dict) and c.get("type") == "FeatureCollection" and isinstance(c.get("features"), list):
                geojson, found_path = c, p
                break
        if geojson is None:
            geojson, found_path = _find_feature_collection(out, path="$")

        if geojson is None:
            return jsonify({
                "status": "error",
                "message": "Geosetta response did not include a GeoJSON FeatureCollection",
                "debug": {"top_keys": list(out.keys()) if isinstance(out, dict) else str(type(out)), "example_snippet": str(out)[:500]}
            }), 502

        geojson = _normalize_feature_collection(geojson)
        features = geojson.get("features") or []
        sample_prop_keys = sample_geometry_type = None
        if features:
            f0 = features[0] or {}
            sample_geometry_type = (f0.get("geometry") or {}).get("type")
            props = f0.get("properties") or {}
            if isinstance(props, dict):
                sample_prop_keys = list(props.keys())[:80]

        return jsonify({
            "status": "success",
            "data": {
                "geojson": geojson,
                "feature_count": len(features),
                "center": {"latitude": lat, "longitude": lon},
                "radius_m": radius_m,
                "debug": {
                    "found_path": found_path,
                    "top_keys": list(out.keys()) if isinstance(out, dict) else str(type(out)),
                    "sample_geometry_type": sample_geometry_type,
                    "sample_properties_keys": sample_prop_keys,
                    "raw_snippet": (json.dumps(out, ensure_ascii=False)[:2000] if want_debug else None)
                }
            }
        })
    except Exception as e:
        return jsonify({"status": "error", "message": f"Geosetta proxy failed: {str(e)}"}), 500


@geosetta_bp.route('/predict_spt_table', methods=['POST'])
def geosetta_predict_spt_table():
    """Use Geosetta SPT_Point_Prediction and convert to SPT table rows."""
    try:
        data = request.json or {}
        lat = data.get('latitude')
        lon = data.get('longitude')
        depth_ft = data.get('depth_ft', 50)

        try:
            lat = float(lat)
            lon = float(lon)
            depth_ft = float(depth_ft)
        except Exception:
            return jsonify({"status": "error", "message": "Invalid latitude/longitude/depth_ft"}), 400

        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            return jsonify({"status": "error", "message": "Latitude/longitude out of range"}), 400
        if depth_ft <= 0:
            return jsonify({"status": "error", "message": "depth_ft must be > 0"}), 400
        depth_ft = min(100.0, depth_ft)
        depth_ft_int = int(round(depth_ft))

        api_key = os.getenv('GEOSETTA_API_KEY', '').strip()
        if not api_key:
            load_dotenv_if_present(os.path.join(_get_project_root(), ".env"))
            api_key = os.getenv('GEOSETTA_API_KEY', '').strip()
        if not api_key:
            return jsonify({"status": "error", "message": "Missing GEOSETTA_API_KEY on server."}), 500

        api_url = os.getenv('GEOSETTA_API_URL', '').strip() or "https://geosetta.org/web_map/api_key/"
        headers = {"Authorization": f"Bearer {api_key}", "X-API-Key": api_key, "Content-Type": "application/json"}
        payload = {
            "deliverableType": "SPT_Point_Prediction",
            "data": {"points": [{"latitude": lat, "longitude": lon, "depth": depth_ft_int, "surfaceelevation": None}]}
        }

        def _post_payload(direct: bool):
            if direct:
                return requests.post(api_url, headers=headers, json=payload, timeout=30)
            return requests.post(api_url, headers=headers, json={"json_data": json.dumps(payload)}, timeout=30)

        try:
            resp = _post_payload(direct=True)
            if resp.status_code != 200:
                resp2 = _post_payload(direct=False)
                if resp2.status_code == 200:
                    resp = resp2
        except requests.exceptions.Timeout:
            return jsonify({"status": "error", "message": "Geosetta API request timed out"}), 504
        except requests.exceptions.ConnectionError:
            return jsonify({"status": "error", "message": "Unable to connect to Geosetta API"}), 503
        except requests.exceptions.RequestException as e:
            return jsonify({"status": "error", "message": f"Geosetta API request failed: {str(e)}"}), 500

        if resp.status_code != 200:
            try:
                details = resp.json()
            except Exception:
                details = resp.text[:500]
            return jsonify({"status": "error", "message": f"Geosetta API error (HTTP {resp.status_code})", "details": details}), 502

        out = resp.json()
        results = out.get("results")
        if not isinstance(results, list) or not results:
            return jsonify({"status": "error", "message": "Unexpected Geosetta response shape"}), 502

        r0 = results[0] if isinstance(results[0], dict) else None
        profiles = (r0 or {}).get("profiles")
        if not isinstance(profiles, list) or not profiles:
            return jsonify({"status": "error", "message": "Geosetta response missing profiles[]"}), 502

        def _parse_n_value(v):
            if v is None:
                return None
            s = str(v).strip()
            if not s:
                return None
            if "-" in s:
                parts = [p.strip() for p in s.split("-", 1)]
                try:
                    return (float(parts[0]) + float(parts[1])) / 2.0
                except Exception:
                    return None
            try:
                return float(s.replace(">", "").replace("<", "").strip())
            except Exception:
                return None

        tests = []
        for p in profiles:
            if not isinstance(p, dict):
                continue
            try:
                d = float(p.get("depth"))
            except Exception:
                continue
            if d < 0 or d >= depth_ft_int:
                continue
            n = _parse_n_value(p.get("dominant_N_value"))
            if n is None:
                continue
            tests.append({"depth_from": d, "depth_to": min(float(depth_ft_int), d + 1.0), "background": {"nValue": int(round(n))}})

        if not tests:
            return jsonify({"status": "error", "message": "No usable SPT prediction rows returned"}), 502

        return jsonify({
            "status": "success",
            "data": {
                "tests": tests,
                "meta": {"source": "Geosetta SPT_Point_Prediction", "latitude": lat, "longitude": lon, "depth_ft": float(depth_ft_int)}
            }
        })
    except Exception as e:
        return jsonify({"status": "error", "message": f"Geosetta predict_spt_table failed: {str(e)}"}), 500


@geosetta_bp.route('/db/status', methods=['GET'])
def geosetta_db_status():
    try:
        db_path = GEOSETTA_DB_PATH
        if not os.path.exists(db_path):
            return jsonify({"status": "success", "data": {"db_path": db_path, "exists": False, "boreholes": 0}})
        con = db_connect(db_path)
        try:
            row = con.execute("SELECT COUNT(1) AS c FROM boreholes;").fetchone()
            c = int(row["c"]) if row else 0
        finally:
            con.close()
        return jsonify({"status": "success", "data": {"db_path": db_path, "exists": True, "boreholes": c}})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Geosetta DB status failed: {str(e)}"}), 500


@geosetta_bp.route('/db/clusters', methods=['POST'])
def geosetta_db_clusters():
    """Query local Geosetta index DB for cluster bubbles in viewport bbox."""
    try:
        data = request.json or {}
        min_lat = float(data.get("min_lat"))
        min_lon = float(data.get("min_lon"))
        max_lat = float(data.get("max_lat"))
        max_lon = float(data.get("max_lon"))
        grid_deg = float(data.get("grid_deg"))
        limit = int(data.get("limit", 5000))

        if not os.path.exists(GEOSETTA_DB_PATH):
            return jsonify({"status": "error", "message": "Geosetta DB not built yet."}), 404

        con = db_connect(GEOSETTA_DB_PATH)
        try:
            clusters = query_clusters_in_bbox(
                con, min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon,
                grid_deg=grid_deg, limit=limit,
            )
        finally:
            con.close()
        return jsonify({"status": "success", "data": {"clusters": clusters}})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Geosetta DB clusters failed: {str(e)}"}), 500


@geosetta_bp.route('/db/points', methods=['POST'])
def geosetta_db_points():
    """Query local Geosetta index DB for exact points in viewport bbox."""
    try:
        data = request.json or {}
        min_lat = float(data.get("min_lat"))
        min_lon = float(data.get("min_lon"))
        max_lat = float(data.get("max_lat"))
        max_lon = float(data.get("max_lon"))
        limit = int(data.get("limit", 20000))

        if not os.path.exists(GEOSETTA_DB_PATH):
            return jsonify({"status": "error", "message": "Geosetta DB not built yet."}), 404

        con = db_connect(GEOSETTA_DB_PATH)
        try:
            points = query_points_in_bbox(
                con, min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon, limit=limit,
            )
        finally:
            con.close()
        return jsonify({"status": "success", "data": {"points": points}})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Geosetta DB points failed: {str(e)}"}), 500
