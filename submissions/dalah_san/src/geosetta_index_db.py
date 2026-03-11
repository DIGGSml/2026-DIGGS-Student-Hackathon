from __future__ import annotations

import os
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple


DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), "data", "geosetta_index.sqlite")


def _now_ts() -> int:
    return int(time.time())


def _qdeg(x: float, scale: int = 1_000_000) -> int:
    # Quantize degrees to micro-degrees (≈0.11 m lat)
    return int(round(float(x) * scale))


def _safe_float(x: Any) -> Optional[float]:
    try:
        v = float(x)
        if v != v:  # NaN
            return None
        return v
    except Exception:
        return None


def extract_provider_and_depth_ft_from_content(content_html: str) -> Tuple[str, Optional[float]]:
    s = str(content_html or "")
    provider = ""
    depth_ft = None

    m = re.search(r"Source:\s*([^<\n]+)", s, re.IGNORECASE)
    if m:
        provider = m.group(1).strip()

    m2 = re.search(r"Total\s*Depth:\s*([0-9.]+)\s*ft", s, re.IGNORECASE)
    if m2:
        depth_ft = _safe_float(m2.group(1))

    return provider, depth_ft


def ensure_db(db_path: str = DEFAULT_DB_PATH) -> None:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    try:
        con.execute("PRAGMA journal_mode=WAL;")
        con.execute("PRAGMA synchronous=NORMAL;")
        con.execute("PRAGMA temp_store=MEMORY;")

        # Main table
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS boreholes (
              id INTEGER PRIMARY KEY,
              lat REAL NOT NULL,
              lon REAL NOT NULL,
              lat_q INTEGER NOT NULL,
              lon_q INTEGER NOT NULL,
              provider TEXT NOT NULL DEFAULT '',
              depth_ft REAL,
              content_html TEXT,
              first_seen_ts INTEGER NOT NULL,
              last_seen_ts INTEGER NOT NULL
            );
            """
        )
        con.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_boreholes_key
            ON boreholes(lat_q, lon_q, provider, COALESCE(depth_ft, -999999.0));
            """
        )

        # Spatial index via RTree (bounds stored in degrees)
        con.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS borehole_rtree USING rtree(
              id,
              min_lat, max_lat,
              min_lon, max_lon
            );
            """
        )

        # Crawl bookkeeping (resume-able)
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS scan_centers (
              id INTEGER PRIMARY KEY,
              lat REAL NOT NULL,
              lon REAL NOT NULL,
              radius_m INTEGER NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              tries INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              updated_ts INTEGER NOT NULL
            );
            """
        )
        con.execute("CREATE INDEX IF NOT EXISTS ix_scan_centers_status ON scan_centers(status);")
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_centers ON scan_centers(lat, lon, radius_m);"
        )
        con.commit()
    finally:
        con.close()


def db_connect(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    ensure_db(db_path)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def upsert_borehole(
    con: sqlite3.Connection,
    *,
    lat: float,
    lon: float,
    provider: str = "",
    depth_ft: Optional[float] = None,
    content_html: str = "",
    seen_ts: Optional[int] = None,
) -> int:
    seen_ts = int(seen_ts or _now_ts())
    lat = float(lat)
    lon = float(lon)
    provider = (provider or "").strip()
    lat_q = _qdeg(lat)
    lon_q = _qdeg(lon)

    # Insert-or-ignore by unique index, then update last_seen and content if newer.
    con.execute(
        """
        INSERT OR IGNORE INTO boreholes(
          lat, lon, lat_q, lon_q, provider, depth_ft, content_html, first_seen_ts, last_seen_ts
        ) VALUES(?,?,?,?,?,?,?,?,?);
        """,
        (lat, lon, lat_q, lon_q, provider, depth_ft, content_html, seen_ts, seen_ts),
    )
    # Fetch id (either inserted or existing)
    row = con.execute(
        """
        SELECT id FROM boreholes
        WHERE lat_q=? AND lon_q=? AND provider=? AND COALESCE(depth_ft, -999999.0)=COALESCE(?, -999999.0)
        LIMIT 1;
        """,
        (lat_q, lon_q, provider, depth_ft),
    ).fetchone()
    if not row:
        raise RuntimeError("Failed to upsert borehole row.")
    bh_id = int(row["id"])

    con.execute(
        """
        UPDATE boreholes
        SET last_seen_ts=?, content_html=CASE WHEN ? IS NOT NULL AND length(?)>0 THEN ? ELSE content_html END
        WHERE id=?;
        """,
        (seen_ts, content_html, content_html, content_html, bh_id),
    )

    # Keep rtree in sync
    con.execute(
        "INSERT OR REPLACE INTO borehole_rtree(id, min_lat, max_lat, min_lon, max_lon) VALUES(?,?,?,?,?);",
        (bh_id, lat, lat, lon, lon),
    )
    return bh_id


def query_points_in_bbox(
    con: sqlite3.Connection,
    *,
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int = 20000,
) -> List[Dict[str, Any]]:
    rows = con.execute(
        """
        SELECT b.id, b.lat, b.lon, b.provider, b.depth_ft
        FROM borehole_rtree r
        JOIN boreholes b ON b.id = r.id
        WHERE r.min_lat >= ? AND r.max_lat <= ? AND r.min_lon >= ? AND r.max_lon <= ?
        LIMIT ?;
        """,
        (float(min_lat), float(max_lat), float(min_lon), float(max_lon), int(limit)),
    ).fetchall()
    return [dict(r) for r in rows]


def query_clusters_in_bbox(
    con: sqlite3.Connection,
    *,
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    grid_deg: float,
    limit: int = 5000,
) -> List[Dict[str, Any]]:
    """
    Return cluster bubbles inside bbox by grouping points into lat/lon bins of size grid_deg.
    """
    grid = float(grid_deg)
    if grid <= 0:
        raise ValueError("grid_deg must be > 0")

    # Group by integer bins; do clustering in SQL to avoid pulling huge point sets.
    # We anchor bins at -90/-180 to keep stable across sessions.
    rows = con.execute(
        """
        SELECT
          CAST(((b.lat + 90.0) / ?) AS INTEGER) AS bin_lat,
          CAST(((b.lon + 180.0) / ?) AS INTEGER) AS bin_lon,
          COUNT(1) AS count,
          AVG(b.lat) AS lat,
          AVG(b.lon) AS lon
        FROM borehole_rtree r
        JOIN boreholes b ON b.id = r.id
        WHERE r.min_lat >= ? AND r.max_lat <= ? AND r.min_lon >= ? AND r.max_lon <= ?
        GROUP BY bin_lat, bin_lon
        ORDER BY count DESC
        LIMIT ?;
        """,
        (grid, grid, float(min_lat), float(max_lat), float(min_lon), float(max_lon), int(limit)),
    ).fetchall()
    return [dict(r) for r in rows]

