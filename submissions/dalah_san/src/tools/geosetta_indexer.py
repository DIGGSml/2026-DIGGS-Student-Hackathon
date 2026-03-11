#!/usr/bin/env python3
"""
Build a local Geosetta borehole index database by crawling the public Geosetta API.

This script is designed to be:
- resumable (scan centers are stored in the same SQLite DB)
- rate-limited (sleep between requests)
- safe (no hardcoded API keys; reads GEOSETTA_API_KEY from env or .env)

It uses Geosetta deliverableType:
  - Return_Historic_Data_In_Radius

and stores returned point locations into:
  data/geosetta_index.sqlite
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
sys.path.insert(0, PROJECT_ROOT)

from geosetta_index_db import (  # noqa: E402
    DEFAULT_DB_PATH,
    db_connect,
    ensure_db,
    extract_provider_and_depth_ft_from_content,
    upsert_borehole,
)


def _load_dotenv_if_present(dotenv_path: str) -> bool:
    try:
        if not dotenv_path or not os.path.exists(dotenv_path):
            return False
        with open(dotenv_path, "r", encoding="utf-8") as f:
            for raw in f.readlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if not k:
                    continue
                if k not in os.environ or not os.environ.get(k, "").strip():
                    os.environ[k] = v
        return True
    except Exception:
        return False


def _auth_headers(api_key: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }


def _post_geosetta(api_url: str, api_key: str, payload: Dict[str, Any], timeout_s: int) -> requests.Response:
    """
    Try direct json payload first, then wrapped {"json_data": "<string>"}.
    """
    r1 = requests.post(api_url, headers=_auth_headers(api_key), json=payload, timeout=timeout_s)
    if r1.status_code == 200:
        return r1
    wrapped = {"json_data": json.dumps(payload)}
    r2 = requests.post(api_url, headers=_auth_headers(api_key), json=wrapped, timeout=timeout_s)
    return r2


def _iter_grid_centers(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    step_km: float,
    east_first: bool = True,
) -> List[Tuple[float, float]]:
    """
    Generate scan centers on a lat/lon grid roughly spaced by step_km.
    Lon step is adjusted by cos(lat).
    If east_first=True (default), iterate East-to-West so populated East Coast
    is scanned first (avoids hundreds of empty ocean requests at startup).
    """
    centers: List[Tuple[float, float]] = []
    lat_step = float(step_km) / 111.32
    lat = float(min_lat)
    while lat <= max_lat + 1e-12:
        coslat = max(0.15, math.cos(math.radians(lat)))
        lon_step = float(step_km) / (111.32 * coslat)
        lon = float(min_lon)
        lons: List[float] = []
        while lon <= max_lon + 1e-12:
            lons.append(round(lon, 6))
            lon += lon_step
        if east_first:
            lons = list(reversed(lons))  # East (-66) first, then West (-125)
        for lon_val in lons:
            centers.append((round(lat, 6), lon_val))
        lat += lat_step
    return centers


def _ensure_centers_in_db(
    con,
    *,
    centers: List[Tuple[float, float]],
    radius_m: int,
) -> int:
    now = int(time.time())
    inserted = 0
    for (lat, lon) in centers:
        cur = con.execute(
            """
            INSERT OR IGNORE INTO scan_centers(lat, lon, radius_m, status, tries, last_error, updated_ts)
            VALUES(?, ?, ?, 'pending', 0, NULL, ?);
            """,
            (float(lat), float(lon), int(radius_m), now),
        )
        inserted += int(cur.rowcount or 0)
    return inserted


def _next_pending_center(con) -> Optional[Dict[str, Any]]:
    row = con.execute(
        """
        SELECT id, lat, lon, radius_m, tries
        FROM scan_centers
        WHERE status='pending'
        ORDER BY id ASC
        LIMIT 1;
        """
    ).fetchone()
    return dict(row) if row else None


def _mark_center(con, center_id: int, status: str, *, err: Optional[str] = None) -> None:
    now = int(time.time())
    con.execute(
        """
        UPDATE scan_centers
        SET status=?, tries=tries+1, last_error=?, updated_ts=?
        WHERE id=?;
        """,
        (status, (err or None), now, int(center_id)),
    )


def _parse_featurecollection(out: Any) -> Optional[Dict[str, Any]]:
    if isinstance(out, dict):
        fc = (out.get("results") or {}).get("points_in_radius")
        if isinstance(fc, dict) and fc.get("type") == "FeatureCollection":
            return fc
    return None


def _extract_points(fc: Dict[str, Any]) -> List[Tuple[float, float, str]]:
    """
    Returns list of (lat, lon, content_html).
    Geosetta features are sometimes geometry-like dicts:
      { "type":"Point", "coordinates":[lon, lat], "properties":{ "content": ... } }
    """
    out: List[Tuple[float, float, str]] = []
    features = fc.get("features") or []
    for f in features:
        if not isinstance(f, dict):
            continue
        if f.get("type") == "Feature" and isinstance(f.get("geometry"), dict):
            geom = f["geometry"]
            coords = geom.get("coordinates") if isinstance(geom, dict) else None
            props = f.get("properties") or {}
        else:
            coords = f.get("coordinates") or (f.get("geometry") or {}).get("coordinates")
            props = f.get("properties") or {}
        if not (isinstance(coords, list) and len(coords) >= 2):
            continue
        lon = coords[0]
        lat = coords[1]
        try:
            lat = float(lat)
            lon = float(lon)
        except Exception:
            continue
        content = ""
        if isinstance(props, dict):
            content = str(props.get("content") or "")
        out.append((lat, lon, content))
    return out


def main(argv: List[str]) -> int:
    _load_dotenv_if_present(os.path.join(PROJECT_ROOT, ".env"))

    ap = argparse.ArgumentParser(description="Crawl Geosetta and build a local borehole index DB.")
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="SQLite DB path")
    ap.add_argument("--api-url", default=os.getenv("GEOSETTA_API_URL", "https://geosetta.org/web_map/api_key/"))
    ap.add_argument("--radius-m", type=int, default=50000, help="Geosetta radius in meters (max 50000)")
    ap.add_argument("--step-km", type=float, default=35.0, help="Grid spacing between scan centers (km). Use 35 for denser coverage (more requests, better capture). 50≈28k boreholes; 35 may reach 50k+.")
    ap.add_argument("--sleep-s", type=float, default=0.35, help="Sleep between requests")
    ap.add_argument("--timeout-s", type=int, default=30)
    ap.add_argument("--max-requests", type=int, default=0, help="Stop after N successful requests (0 = no limit)")
    ap.add_argument("--bbox", default=None, help="min_lat,min_lon,max_lat,max_lon (overrides --conus)")
    ap.add_argument("--conus", action="store_true", help="Full CONUS: 24,-125,50,-66, East-to-West scan order")
    ap.add_argument("--prefer-region", default=None, help="Scan this bbox first (min_lat,min_lon,max_lat,max_lon), e.g. 38,-78,41,-74 for MD/VA")
    ap.add_argument("--west-first", action="store_true", help="Scan West-to-East (default is East-to-West)")
    ap.add_argument("--init-only", action="store_true", help="Only seed scan centers; do not crawl")
    ap.add_argument("--fresh", action="store_true", help="Delete DB and re-seed (use with --conus for East-first from scratch)")
    ap.add_argument("--retry-failed", action="store_true", help="Reset failed centers back to pending")
    ap.add_argument("--verify", action="store_true", help="After crawl, verify DB queries return data")
    args = ap.parse_args(argv)

    bbox_str = args.bbox
    if bbox_str is None and args.conus:
        bbox_str = "24,-125,50,-66"
    if bbox_str is None:
        bbox_str = "24,-125,50,-66"

    prefer_bbox = args.prefer_region
    if prefer_bbox is None and args.conus:
        prefer_bbox = "38,-78,41,-74"  # Maryland/Virginia - known data-rich

    api_key = os.getenv("GEOSETTA_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Missing GEOSETTA_API_KEY in environment/.env")

    db_path = os.path.abspath(args.db)
    if args.fresh:
        for p in [db_path, db_path + "-wal", db_path + "-shm"]:
            if os.path.exists(p):
                os.remove(p)
                print(f"[indexer] removed {p}")
    ensure_db(db_path)
    con = db_connect(db_path)
    try:
        bbox_parts = [p.strip() for p in str(bbox_str).split(",")]
        if len(bbox_parts) != 4:
            raise SystemExit("--bbox must be min_lat,min_lon,max_lat,max_lon")
        min_lat, min_lon, max_lat, max_lon = [float(x) for x in bbox_parts]

        east_first = not bool(args.west_first)
        radius_m = int(args.radius_m)
        step_km = float(args.step_km)

        # Seed prefer region first (gets lower IDs, processed first)
        total_added = 0
        if prefer_bbox:
            pr = [p.strip() for p in str(prefer_bbox).split(",")]
            if len(pr) == 4:
                pmin_lat, pmin_lon, pmax_lat, pmax_lon = [float(x) for x in pr]
                prefer_centers = _iter_grid_centers(
                    pmin_lat, pmin_lon, pmax_lat, pmax_lon,
                    step_km, east_first=east_first,
                )
                added = _ensure_centers_in_db(con, centers=prefer_centers, radius_m=radius_m)
                total_added += added
                print(f"[indexer] prefer region ({prefer_bbox}): {len(prefer_centers)} centers (new: {added})")

        centers = _iter_grid_centers(
            min_lat, min_lon, max_lat, max_lon,
            step_km, east_first=east_first,
        )
        added = _ensure_centers_in_db(con, centers=centers, radius_m=radius_m)
        total_added += added
        con.commit()
        print(f"[indexer] main bbox: {len(centers)} centers (new: {added}), total new: {total_added}")

        if args.retry_failed:
            now = int(time.time())
            n = con.execute(
                "UPDATE scan_centers SET status='pending', last_error=NULL, updated_ts=? WHERE status='failed';",
                (now,),
            ).rowcount
            con.commit()
            print(f"[indexer] reset failed -> pending: {n}")

        if args.init_only:
            return 0

        ok_requests = 0
        while True:
            if args.max_requests and ok_requests >= int(args.max_requests):
                print("[indexer] reached --max-requests limit.")
                break

            center = _next_pending_center(con)
            if not center:
                print("[indexer] no pending centers left.")
                break

            cid = int(center["id"])
            lat = float(center["lat"])
            lon = float(center["lon"])
            radius_m = int(center["radius_m"])

            payload = {
                "deliverableType": "Return_Historic_Data_In_Radius",
                "data": {"points": [{"latitude": lat, "longitude": lon, "radius_m": radius_m}]},
            }

            try:
                r = _post_geosetta(str(args.api_url), api_key, payload, timeout_s=int(args.timeout_s))
                if r.status_code != 200:
                    _mark_center(con, cid, "failed", err=f"HTTP {r.status_code}: {r.text[:240]}")
                    con.commit()
                    print(f"[indexer] center {cid} failed: HTTP {r.status_code}")
                    time.sleep(float(args.sleep_s))
                    continue

                out = r.json()
                fc = _parse_featurecollection(out)
                if not fc:
                    _mark_center(con, cid, "failed", err="missing results.points_in_radius FeatureCollection")
                    con.commit()
                    print(f"[indexer] center {cid} failed: missing FeatureCollection")
                    time.sleep(float(args.sleep_s))
                    continue

                pts = _extract_points(fc)
                seen_ts = int(time.time())
                for (plat, plon, content) in pts:
                    provider, depth_ft = extract_provider_and_depth_ft_from_content(content)
                    upsert_borehole(
                        con,
                        lat=plat,
                        lon=plon,
                        provider=provider,
                        depth_ft=depth_ft,
                        content_html=content,
                        seen_ts=seen_ts,
                    )

                _mark_center(con, cid, "done", err=None)
                con.commit()

                ok_requests += 1
                if ok_requests % 10 == 0:
                    row = con.execute("SELECT COUNT(1) AS c FROM boreholes;").fetchone()
                    print(f"[indexer] ok_requests={ok_requests} total_boreholes={int(row['c']) if row else 0}")
                else:
                    print(f"[indexer] done center {cid}: +{len(pts)} point(s)")

            except Exception as e:
                _mark_center(con, cid, "failed", err=str(e)[:240])
                con.commit()
                print(f"[indexer] center {cid} exception: {e}")

            time.sleep(float(args.sleep_s))

        if args.verify or ok_requests > 0:
            _verify_db(con, db_path)

        return 0
    finally:
        con.close()


def _verify_db(con, db_path: str) -> None:
    """Quick verification that DB queries return correct data."""
    from geosetta_index_db import query_points_in_bbox, query_clusters_in_bbox

    total = con.execute("SELECT COUNT(1) AS c FROM boreholes").fetchone()["c"]
    print(f"[verify] total boreholes: {total}")

    if total == 0:
        print("[verify] no data to verify")
        return

    # Sample bbox (Maryland area - known to have data)
    pts = query_points_in_bbox(
        con,
        min_lat=38.5,
        min_lon=-77.5,
        max_lat=40.0,
        max_lon=-76.0,
        limit=100,
    )
    print(f"[verify] points in MD bbox (38.5,-77.5,40,-76): {len(pts)}")
    if pts:
        sample = pts[0]
        print(f"[verify] sample: lat={sample.get('lat')}, lon={sample.get('lon')}, provider={sample.get('provider')}")

    clusters = query_clusters_in_bbox(
        con,
        min_lat=24.0,
        min_lon=-125.0,
        max_lat=50.0,
        max_lon=-66.0,
        grid_deg=1.0,
        limit=20,
    )
    print(f"[verify] clusters (grid 1°) in CONUS: {len(clusters)}")
    if clusters:
        c = clusters[0]
        print(f"[verify] sample cluster: count={c.get('count')}, lat={c.get('lat')}, lon={c.get('lon')}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

