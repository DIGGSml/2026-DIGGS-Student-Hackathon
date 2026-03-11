#!/usr/bin/env python3
"""
Geosetta API probe script (safe, no hardcoded API keys).

What this script does:
- Calls Geosetta endpoints with a provided API key (via env or CLI flag).
- Prints a compact summary to stdout.
- Saves raw JSON responses to ./tools/_geosetta_out/ for inspection.
- Extracts and prints any URLs found in Historic-in-Radius `properties.content`.

Usage examples:
  export GEOSETTA_API_KEY="your_api_key_here"
  python tools/geosetta_probe.py historic --lat 39.2188444 --lon -76.8434642 --radius-m 1000
  python tools/geosetta_probe.py predict-spt --lat 39.38708 --lon -76.81348 --depth-ft 50
  python tools/geosetta_probe.py site-report --format json --polygon-square --lat 38.1125 --lon -78.4275 --size-deg 0.005

Notes:
- This script intentionally does NOT embed API keys in code or files.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import requests


OUT_DIR = os.path.join(os.path.dirname(__file__), "_geosetta_out")
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))


def _load_dotenv_if_present(dotenv_path: str) -> bool:
    """
    Minimal .env loader (no extra deps).
    Loads KEY=VALUE pairs into os.environ ONLY if the key is not already set.
    """
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
                if k not in os.environ:
                    os.environ[k] = v
        return True
    except Exception:
        return False


def _ensure_out_dir() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)


def _write_json(filename: str, data: Any) -> str:
    _ensure_out_dir()
    path = os.path.join(OUT_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def _write_bytes(filename: str, b: bytes) -> str:
    _ensure_out_dir()
    path = os.path.join(OUT_DIR, filename)
    with open(path, "wb") as f:
        f.write(b)
    return path


def _now_stamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def _get_api_key(cli_key: Optional[str]) -> str:
    k = (
        cli_key
        or os.environ.get("GEOSETTA_API_KEY")  # project convention
        or os.environ.get("GEOSSETTA_API_KEY")  # tolerated alias
        or os.environ.get("GEOSSETTA_KEY")
    )
    if not k:
        raise SystemExit(
            "Missing API key. Provide --api-key or set GEOSETTA_API_KEY env var.\n"
            "Example:\n"
            "  export GEOSETTA_API_KEY='YOUR_KEY'\n"
            "  python tools/geosetta_probe.py historic --lat ... --lon ... --radius-m 1000\n"
        )
    return k.strip()


def _auth_headers(api_key: str) -> Dict[str, str]:
    # Docs show Bearer; we use that by default.
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def _post_json(url: str, api_key: str, payload: Dict[str, Any], timeout_s: int = 60) -> Tuple[int, Any]:
    r = requests.post(url, json=payload, headers=_auth_headers(api_key), timeout=timeout_s)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"_non_json_body": r.text}


def _post_json_wrapped(url: str, api_key: str, json_payload: Dict[str, Any], timeout_s: int = 60) -> Tuple[int, Any]:
    # Some examples show wrapping inside {"json_data": json.dumps(payload)}.
    wrapped = {"json_data": json.dumps(json_payload)}
    r = requests.post(url, json=wrapped, headers=_auth_headers(api_key), timeout=timeout_s)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"_non_json_body": r.text}


def _extract_urls(text: str) -> List[str]:
    if not text:
        return []
    # Conservative URL regex
    urls = re.findall(r"https?://[^\s\"'<>]+", text)
    # Dedup preserve order
    seen = set()
    out = []
    for u in urls:
        if u not in seen:
            out.append(u)
            seen.add(u)
    return out


def _guess_ext(content_type: str, url: str) -> str:
    ct = (content_type or "").lower()
    u = (url or "").lower()
    if "application/zip" in ct or u.endswith(".zip"):
        return ".zip"
    if "application/xml" in ct or "text/xml" in ct or u.endswith(".xml"):
        return ".xml"
    if "application/json" in ct or u.endswith(".json"):
        return ".json"
    if "text/html" in ct or u.endswith(".html") or u.endswith(".htm"):
        return ".html"
    if "application/octet-stream" in ct:
        # Unknown binary; prefer zip then xml guess by URL
        if "diggs" in u:
            return ".xml"
        return ".bin"
    return ".txt"


def _get_url(url: str, api_key: Optional[str], timeout_s: int = 60) -> requests.Response:
    # Try without auth first (often public), then retry with Bearer if forbidden.
    sess = requests.Session()
    r = sess.get(url, allow_redirects=True, timeout=timeout_s)
    if r.status_code in (401, 403) and api_key:
        r = sess.get(url, allow_redirects=True, timeout=timeout_s, headers={"Authorization": f"Bearer {api_key}"})
    return r


def cmd_fetch_url(args: argparse.Namespace) -> int:
    api_key = None
    if args.use_api_key:
        api_key = _get_api_key(args.api_key)
    stamp = _now_stamp()

    url = args.url.strip()
    r = _get_url(url, api_key=api_key, timeout_s=args.timeout_s)
    ct = r.headers.get("content-type", "")
    final_url = str(r.url)
    size = len(r.content or b"")

    print("[fetch-url] status:", r.status_code)
    print("[fetch-url] content-type:", ct)
    print("[fetch-url] final url:", final_url)
    print("[fetch-url] size bytes:", size)

    # Save body for inspection
    ext = _guess_ext(ct, final_url)
    out_name = f"{stamp}_fetch_{re.sub(r'[^a-zA-Z0-9]+', '_', final_url)[:60]}_{r.status_code}{ext}"
    out_path = _write_bytes(out_name, r.content or b"")
    print("[fetch-url] saved body:", out_path)

    # Print head
    head = (r.content or b"")[: args.head_bytes]
    if not head:
        return 0

    if ext in (".xml", ".html", ".json", ".txt"):
        try:
            txt = head.decode("utf-8", errors="replace")
        except Exception:
            txt = repr(head)
        print(f"\n[fetch-url] first {args.head_bytes} bytes (decoded):")
        print(txt)
    else:
        print(f"\n[fetch-url] first {args.head_bytes} bytes (hex):")
        print(head.hex())

    return 0


def cmd_historic(args: argparse.Namespace) -> int:
    api_key = _get_api_key(args.api_key)
    stamp = _now_stamp()

    url = "https://geosetta.org/web_map/api_key/"
    json_payload = {
        "deliverableType": "Return_Historic_Data_In_Radius",
        "data": {
            "points": [
                {
                    "latitude": args.lat,
                    "longitude": args.lon,
                    "radius_m": args.radius_m,
                }
            ]
        },
    }

    # Try both payload styles because docs show both
    status1, data1 = _post_json(url, api_key, json_payload)
    status2, data2 = _post_json_wrapped(url, api_key, json_payload)

    p1 = _write_json(f"{stamp}_historic_direct_status{status1}.json", data1)
    p2 = _write_json(f"{stamp}_historic_wrapped_status{status2}.json", data2)

    print(f"[historic] saved direct:  {p1}")
    print(f"[historic] saved wrapped: {p2}")

    # Pick the better-looking response
    best = data1 if isinstance(data1, dict) and data1.get("results") else data2
    fc = None
    try:
        fc = best.get("results", {}).get("points_in_radius")
    except Exception:
        fc = None

    if not isinstance(fc, dict):
        print("[historic] Could not find results.points_in_radius as FeatureCollection.")
        return 0

    features = fc.get("features") or []
    print(f"[historic] features: {len(features)}")

    # Print a compact summary + URL extraction
    for i, f in enumerate(features[: args.max_features]):
        props = (f or {}).get("properties") or {}
        content = str(props.get("content") or "")
        coords = (f or {}).get("coordinates") or (f or {}).get("geometry", {}).get("coordinates")
        urls = _extract_urls(content)
        print(f"\n--- feature {i+1} ---")
        if coords:
            print(f"coords: {coords}")
        print("content (first 240 chars):")
        print(content[:240].replace("\n", "\\n") + ("..." if len(content) > 240 else ""))
        if urls:
            print("urls:")
            for u in urls:
                print(f"  - {u}")

    return 0


def cmd_predict_spt(args: argparse.Namespace) -> int:
    api_key = _get_api_key(args.api_key)
    stamp = _now_stamp()

    url = "https://geosetta.org/web_map/api_key/"
    json_payload = {
        "deliverableType": "SPT_Point_Prediction",
        "data": {
            "points": [
                {
                    "latitude": args.lat,
                    "longitude": args.lon,
                    "depth": args.depth_ft,
                    "surfaceelevation": None,
                }
            ]
        },
    }

    status1, data1 = _post_json(url, api_key, json_payload)
    status2, data2 = _post_json_wrapped(url, api_key, json_payload)

    p1 = _write_json(f"{stamp}_predict_spt_direct_status{status1}.json", data1)
    p2 = _write_json(f"{stamp}_predict_spt_wrapped_status{status2}.json", data2)
    print(f"[predict-spt] saved direct:  {p1}")
    print(f"[predict-spt] saved wrapped: {p2}")

    best = data1 if isinstance(data1, dict) and data1.get("results") else data2
    results = best.get("results")
    if not isinstance(results, list) or not results:
        print("[predict-spt] Could not find results[] array.")
        return 0

    r0 = results[0]
    gw = r0.get("groundwater") if isinstance(r0, dict) else None
    profiles = r0.get("profiles") if isinstance(r0, dict) else None
    print(f"[predict-spt] profiles rows: {len(profiles) if isinstance(profiles, list) else 0}")
    if isinstance(gw, dict):
        print(f"[predict-spt] groundwater: {gw.get('depth_label')} / deviation: {gw.get('deviation_label')}")
        probs = gw.get("depth_probabilities") or {}
        if isinstance(probs, dict) and probs:
            print(f"[predict-spt] depth probabilities: {probs}")
    return 0


def _square_polygon(lon: float, lat: float, size_deg: float) -> Dict[str, Any]:
    # GeoJSON polygon coordinates are [lon, lat]
    half = float(size_deg) / 2.0
    nw = [lon - half, lat + half]
    ne = [lon + half, lat + half]
    se = [lon + half, lat - half]
    sw = [lon - half, lat - half]
    return {"type": "Polygon", "coordinates": [[nw, ne, se, sw, nw]]}


def cmd_site_report(args: argparse.Namespace) -> int:
    api_key = _get_api_key(args.api_key)
    stamp = _now_stamp()

    url = "https://geosetta.org/web_map/api/generate_site_report/"
    if args.polygon_square:
        poly = _square_polygon(args.lon, args.lat, args.size_deg)
    else:
        # minimal triangle fallback (should be replaced by user polygon)
        poly = _square_polygon(args.lon, args.lat, args.size_deg)

    request_body = {
        "geojson": json.dumps(poly),
        "format": args.format,
    }

    status, data = _post_json(url, api_key, request_body, timeout_s=120)
    p = _write_json(f"{stamp}_site_report_{args.format}_status{status}.json", data)
    print(f"[site-report] saved: {p}")

    if status != 200:
        print(f"[site-report] non-200: {status}")
        return 0

    if isinstance(data, dict) and data.get("status") == "success" and args.format == "pdf":
        b64 = data.get("pdf")
        if isinstance(b64, str) and b64:
            pdf_bytes = base64.b64decode(b64)
            out_pdf = _write_bytes(f"{stamp}_geosetta_site_report.pdf", pdf_bytes)
            print(f"[site-report] wrote pdf: {out_pdf} ({len(pdf_bytes)} bytes)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Probe Geosetta endpoints and save raw responses.")
    p.add_argument("--api-key", default=None, help="Geosetta API key (prefer env GEOSSETTA_API_KEY)")

    sub = p.add_subparsers(dest="cmd", required=True)

    p_fetch = sub.add_parser("fetch-url", help="Fetch a URL (e.g. DIGGS link) and dump response info")
    p_fetch.add_argument("--url", required=True, help="URL to fetch (e.g. https://geosetta.org/web_map/DIGGS/lat;lon)")
    p_fetch.add_argument("--use-api-key", action="store_true", help="Retry with Bearer GEOSETTA_API_KEY if 401/403")
    p_fetch.add_argument("--timeout-s", type=int, default=60)
    p_fetch.add_argument("--head-bytes", type=int, default=600)
    p_fetch.set_defaults(func=cmd_fetch_url)

    p_hist = sub.add_parser("historic", help="Return_Historic_Data_In_Radius probe")
    p_hist.add_argument("--lat", type=float, required=True)
    p_hist.add_argument("--lon", type=float, required=True)
    p_hist.add_argument("--radius-m", type=int, default=1000)
    p_hist.add_argument("--max-features", type=int, default=10)
    p_hist.set_defaults(func=cmd_historic)

    p_pred = sub.add_parser("predict-spt", help="SPT_Point_Prediction probe")
    p_pred.add_argument("--lat", type=float, required=True)
    p_pred.add_argument("--lon", type=float, required=True)
    p_pred.add_argument("--depth-ft", type=int, default=50)
    p_pred.set_defaults(func=cmd_predict_spt)

    p_rep = sub.add_parser("site-report", help="generate_site_report probe")
    p_rep.add_argument("--format", choices=["json", "pdf"], default="json")
    p_rep.add_argument("--polygon-square", action="store_true", help="Generate a square polygon around --lat/--lon")
    p_rep.add_argument("--lat", type=float, required=True)
    p_rep.add_argument("--lon", type=float, required=True)
    p_rep.add_argument("--size-deg", type=float, default=0.005, help="Square size in degrees (approx, for quick probe)")
    p_rep.set_defaults(func=cmd_site_report)

    return p


def main(argv: List[str]) -> int:
    # Allow local .env (project root) for convenience.
    _load_dotenv_if_present(os.path.join(PROJECT_ROOT, ".env"))
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

