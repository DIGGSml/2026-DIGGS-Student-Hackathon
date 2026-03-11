import os
import pdfplumber
import re
import logging

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Reversed-text helper
# ─────────────────────────────────────────────────────────────────────────────
_REVERSED_KEYWORDS = {"HTPED", "SWOLB", "LIOS", "NOITAVELE", "TNETNOC",
                      "EVISSERPMOC", "HTGNERTS", "LOBMYS", "SELPMAS",
                      "EPYT", "TSET", "YTICITSALP", "XEDNI"}

def _is_reversed(text):
    text_upper = text.upper()
    return any(kw in text_upper for kw in _REVERSED_KEYWORDS)

def _maybe_reverse(text):
    if text and _is_reversed(text):
        return text[::-1]
    return text


# ─────────────────────────────────────────────────────────────────────────────
# Metadata extraction
# ─────────────────────────────────────────────────────────────────────────────

_PROJECT_PATTERNS = [
    re.compile(r"PROJECT\s*(?:#|NAME|NO\.?)?:?\s*(.+)", re.IGNORECASE),
    re.compile(r"PROJ(?:ECT)?\.?\s*(?:No\.?|#)?:?\s*(.+)", re.IGNORECASE),
    re.compile(r"(?:JOB|SITE)\s*(?:NAME|NO\.?)?:?\s*(.+)", re.IGNORECASE),
]

_BOREHOLE_PATTERNS = [
    re.compile(r"(?:LOG\s+OF\s+BORING|BORING\s+LOG)\s+NO\.?\s*([A-Z0-9\-]+)", re.IGNORECASE),
    re.compile(r"\b((?:BH|B|TH|MW|SB|SS|BOR|TP|CPT|PZ)-?\s*\d+[A-Za-z]?)\b"),
]

_DATE_PATTERNS = [
    re.compile(r"Date(?:s)?\s+Drilled\s*:\s*([\d/\-]+)", re.IGNORECASE),
    re.compile(r"DATE\s+DRILLED\s*:\s*([\d/\-]+)", re.IGNORECASE),
    re.compile(r"Boring\s+(?:Started|Completed)\s*:\s*([\d/\-]+)", re.IGNORECASE),
    re.compile(r"Drilled\s*:\s*([\d/\-]+)", re.IGNORECASE),
    re.compile(r"DRILLING\s+DATE\s*:\s*([\d/\-]+)", re.IGNORECASE),
]

_LAT_PATTERNS = [
    re.compile(r"LATITUDE\s*:\s*([\d.]+)", re.IGNORECASE),
    re.compile(r"N\s*([\d]{2,3}\.[\d]+)\s*[oO°]?\s*[,\s]", re.IGNORECASE),
    re.compile(r"(?:GPS|Coordinates?).*?N\s+([\d.]+)", re.IGNORECASE),
    # bare decimal only when labeled with LATITUDE or N prefix (handled above)
    # removed greedy r"^([2-5]\d\.\d+)" — too likely to match depths or blow counts
]

_LON_PATTERNS = [
    re.compile(r"LONGITUDE\s*:\s*([\d.]+)", re.IGNORECASE),
    re.compile(r"W\s*([\d]{2,3}\.[\d]+)\s*[oO°]?(?:\s|$|,)", re.IGNORECASE),
    re.compile(r",\s*(-?\d{2,3}\.\d+)"),  # e.g. ", -98.652" in GPS text
]

_FILENAME_COORD_PATTERN = re.compile(
    r"(-?[\d]{1,3}\.[\d]+)[;,_](-?[\d]{1,3}\.[\d]+)"
)

_ELEV_PATTERNS = [
    re.compile(r"ELEVATION\s*:\s*([\d.]+)", re.IGNORECASE),
    re.compile(r"ELEV\.?\s*(?:FT\.?)?\s*[=:]\s*([\d.]+)", re.IGNORECASE),
]

_TOTAL_DEPTH_PATTERNS = [
    re.compile(r"DEPTH\s+(?:DRILLED|BORED)\s*:\s*([\d.]+)", re.IGNORECASE),
    re.compile(r"Boring\s+[Tt]erminated\s+at\s+(?:a\s+depth\s+of\s+)?([\d.]+)", re.IGNORECASE),
    re.compile(r"terminated\s+at\s+([\d.]+)\s*(?:feet|ft)", re.IGNORECASE),
    re.compile(r"Boring\s+Terminated\s+at\s+([\d.]+)\s*(?:feet|ft|Feet)", re.IGNORECASE),
]


def _first_match(patterns, text):
    for pat in patterns:
        m = pat.search(text)
        if m:
            return m.group(1).strip()
    return None


def extract_header_from_tables(tables, pdf_path=None, original_filename=None):
    metadata = {
        "project_name": "Unknown Project",
        "borehole_id": "Unknown",
        "date": None,
        "total_depth_ft": None,
        "location": {
            "lat": None,
            "lon": None,
            "elevation_ft": None,
            "srs": "EPSG:4326",
        },
    }

    all_cells = []
    for table in tables:
        for row in table:
            for cell in row:
                if not cell:
                    continue
                raw = str(cell).strip()
                all_cells.append(raw)
                rev = _maybe_reverse(raw)
                if rev != raw:
                    all_cells.append(rev)

    full_text = "\n".join(all_cells)

    # Project name
    for pat in _PROJECT_PATTERNS:
        m = pat.search(full_text)
        if m:
            candidate = m.group(1).split("|")[0].split("\n")[0].strip()
            # Require space (multi-word) OR more than 8 chars to avoid matching project numbers
            if candidate and (" " in candidate or len(candidate) > 8):
                metadata["project_name"] = candidate
                break

    # Borehole ID
    for pat in _BOREHOLE_PATTERNS:
        m = pat.search(full_text)
        if m:
            metadata["borehole_id"] = m.group(1).strip().replace(" ", "")
            break

    # Date
    date_val = _first_match(_DATE_PATTERNS, full_text)
    if date_val:
        metadata["date"] = date_val

    # Total depth
    depth_val = _first_match(_TOTAL_DEPTH_PATTERNS, full_text)
    if depth_val:
        try:
            metadata["total_depth_ft"] = float(depth_val)
        except ValueError:
            pass

    # Location — first try from full text
    lat_val = _first_match(_LAT_PATTERNS, full_text)
    if lat_val:
        try:
            metadata["location"]["lat"] = float(lat_val)
        except ValueError:
            pass

    lon_val = _first_match(_LON_PATTERNS, full_text)
    if lon_val:
        try:
            val = float(lon_val)
            if "W" in full_text and val > 0:
                val = -val
            metadata["location"]["lon"] = val
        except ValueError:
            pass

    elev_val = _first_match(_ELEV_PATTERNS, full_text)
    if elev_val:
        try:
            metadata["location"]["elevation_ft"] = float(elev_val)
        except ValueError:
            pass

    # Fallback: parse lat/lon from the PDF filename itself (e.g. '29.7421;-98.652.pdf')
    # Prefer original_filename (before secure_filename strips semicolons) over pdf_path
    if (metadata["location"]["lat"] is None or metadata["location"]["lon"] is None):
        # Try original filename first (unsanitized — preserves ';' separator)
        for fname_candidate in [original_filename, pdf_path]:
            if not fname_candidate:
                continue
            fname = os.path.splitext(os.path.basename(fname_candidate))[0]
            m = _FILENAME_COORD_PATTERN.search(fname)
            if m:
                try:
                    v1, v2 = float(m.group(1)), float(m.group(2))
                    if abs(v1) <= 90 and abs(v2) > 90:
                        metadata["location"]["lat"] = v1
                        metadata["location"]["lon"] = v2
                    elif abs(v2) <= 90 and abs(v1) > 90:
                        metadata["location"]["lat"] = v2
                        metadata["location"]["lon"] = v1
                    else:
                        metadata["location"]["lat"] = v1
                        metadata["location"]["lon"] = v2
                    logger.info(f"Coordinates from filename '{fname_candidate}': {v1}, {v2}")
                    break  # success — stop trying
                except ValueError:
                    pass

    logger.info(f"Extracted Metadata: {metadata}")
    return metadata


# ─────────────────────────────────────────────────────────────────────────────
# SPT parsing helpers
# ─────────────────────────────────────────────────────────────────────────────

def _parse_n_value(raw):
    """Parse a blow-count string like '23', '50/2\"', 'N=47', '8-16-31' → int or None."""
    if not raw:
        return None
    raw = str(raw).strip()
    # N=XX format
    m = re.match(r"N\s*=\s*(\d+)", raw, re.IGNORECASE)
    if m:
        return int(m.group(1))
    # Refusal: 50/X
    if re.match(r"50\s*/", raw):
        return 50
    # 3-set blows like "8-16-31" → last two sets sum
    m3 = re.match(r"(\d+)-(\d+)-(\d+)$", raw)
    if m3:
        return int(m3.group(2)) + int(m3.group(3))
    # Plain integer
    try:
        return int(raw)
    except ValueError:
        return None


def _compute_spt_interval(depths):
    """Estimate SPT interval from a list of depth floats. Default 1.5 ft."""
    if len(depths) < 2:
        return 1.5
    intervals = [abs(depths[i+1] - depths[i]) for i in range(len(depths)-1)]
    intervals.sort()
    # True median: average of two middle values for even-length lists
    n = len(intervals)
    mid = n // 2
    median = (intervals[mid - 1] + intervals[mid]) / 2 if n % 2 == 0 else intervals[mid]
    return median if 0.5 <= median <= 10.0 else 1.5


def parse_spt_from_cells(depth_cell, blow_cell):
    """Parse SPT from two newline-separated cells (columnar format)."""
    tests = []
    if not depth_cell or not blow_cell:
        return tests

    depths_raw = [d.strip() for d in depth_cell.strip().split("\n") if d.strip()]
    blows_raw  = [b.strip() for b in blow_cell.strip().split("\n") if b.strip()]

    # Only keep depth entries that are actual numbers
    depth_pairs = []
    for d in depths_raw:
        try:
            depth_pairs.append(float(d))
        except ValueError:
            pass

    # Only keep blow entries that look like actual numbers
    blow_pairs = []
    for b in blows_raw:
        if re.match(r"^\d+", b) or b.startswith("50/"):
            blow_pairs.append(b)

    if not depth_pairs or not blow_pairs:
        return tests

    interval = _compute_spt_interval(depth_pairs)

    for i in range(min(len(depth_pairs), len(blow_pairs))):
        d_val = depth_pairs[i]
        n_value = _parse_n_value(blow_pairs[i])
        tests.append({
            "type": "SPT",
            "depth_top_ft": d_val,
            "depth_bottom_ft": round(d_val + interval, 2),
            "n_value": n_value,
            "blow_counts": blow_pairs[i],
        })
    return tests


# ─────────────────────────────────────────────────────────────────────────────
# Stratigraphy parsing
# ─────────────────────────────────────────────────────────────────────────────
_DEPTH_ELEV_HEADER = re.compile(r"^(\d+\.?\d*)\s*/\s*\d+\.?\d*")  # "0.0 / 659.6"


def parse_stratigraphy_cell(cell_text):
    """Parse stratigraphy from a description cell with depth/elev format."""
    layers = []
    if not cell_text:
        return layers

    lines = [l.strip() for l in cell_text.split("\n") if l.strip()]
    current_layer = None

    for line in lines:
        m = _DEPTH_ELEV_HEADER.match(line)
        if m:
            if current_layer:
                layers.append(current_layer)
            # First number in "top / elevation" is the top depth, not bottom
            top_depth = float(m.group(1))
            current_layer = {"top_ft": top_depth, "description_lines": [], "uscs_code": ""}
            remainder = line[m.end():].strip()
            if remainder:
                current_layer["description_lines"].append(remainder)
            continue
        if current_layer:
            current_layer["description_lines"].append(line)

    if current_layer:
        layers.append(current_layer)

    final_layers = []
    # Sort by top depth ascending and compute bottom = next layer's top
    layers.sort(key=lambda x: x["top_ft"])

    for i, layer in enumerate(layers):
        layer["bottom_ft"] = layers[i + 1]["top_ft"] if i + 1 < len(layers) else layer["top_ft"]
        layer["description"] = " ".join(layer["description_lines"]).strip()

        uscs_match = re.search(r"\b([A-Z]{2,3})\b(?:\))?$", layer["description"])
        if not uscs_match:
            uscs_match = re.search(r"\(([A-Z]{2,3})\)", layer["description"])
        if uscs_match:
            layer["uscs_code"] = uscs_match.group(1)

        del layer["description_lines"]
        final_layers.append(layer)

    return final_layers


# ─────────────────────────────────────────────────────────────────────────────
# Column identification
# ─────────────────────────────────────────────────────────────────────────────

def _identify_columns(table):
    """Identify depth, blows, and stratigraphy columns from table headers."""
    roles = {"depth_col": None, "blows_col": None, "strat_col": None}

    depth_kw  = {"DEPTH", "HTPED", ",HTPED", "TF,HTPED"}
    blows_kw  = {"BLOWS", "SWOLB", "N-VALUE", "EULAV-N", "BLOWS PER FT", "TF REP SWOLB"}
    strat_kw  = {"DESCRIPTION", "DESCRIPTION OF MATERIAL", "DESCRIPTION OF STRATUM",
                 "FIELD DESCRIPTION", "MATERIAL", "STRATA"}

    def _cell_matches(cell, keywords):
        if not cell:
            return False
        t = str(cell).upper().replace("\n", " ").replace("|", " ").strip()
        tr = t[::-1]
        for kw in keywords:
            if kw in t or kw in tr:
                return True
        return False

    for row in table[:8]:
        if not row:
            continue
        for ci, cell in enumerate(row):
            if _cell_matches(cell, depth_kw) and roles["depth_col"] is None:
                roles["depth_col"] = ci
                logger.info(f"Depth column: {ci}")
            if _cell_matches(cell, blows_kw) and roles["blows_col"] is None:
                roles["blows_col"] = ci
                logger.info(f"Blows column: {ci}")
            if _cell_matches(cell, strat_kw) and roles["strat_col"] is None:
                roles["strat_col"] = ci
                logger.info(f"Stratigraphy column: {ci}")

    return roles


def _get_depth_floats_from_cell(cell):
    """Extract a list of float depth values from a cell (newline-separated)."""
    if not cell:
        return []
    vals = []
    for v in str(cell).split("\n"):
        v = v.strip()
        try:
            f = float(v)
            if 0 <= f <= 500:
                vals.append(f)
        except ValueError:
            pass
    return vals


# ─────────────────────────────────────────────────────────────────────────────
# Main extraction entry point
# ─────────────────────────────────────────────────────────────────────────────

_N_PATTERN = re.compile(r"N\s*=\s*(\d+)(?:/\d+[\"']?)?", re.IGNORECASE)
_SKIP_STRAT_PATTERNS = re.compile(
    r"(terminated|drilling|description|remarks|boring|groundwater|no free water|"
    r"stratification|abandonment|advancement|driller|drill rig|boring started|"
    r"project no|exhibit|figure|tbpe|surface capped|backfilled|water level)",
    re.IGNORECASE
)


def extract_data_from_pdf(pdf_path, original_filename=None):
    extracted_data = {"metadata": {}, "stratigraphy": [], "tests": []}

    with pdfplumber.open(pdf_path) as pdf:
        all_tables = []
        for page in pdf.pages:
            tables = page.extract_tables()
            all_tables.extend(tables)

        # 1. Metadata — pass original_filename for coordinate fallback
        extracted_data["metadata"] = extract_header_from_tables(
            all_tables, pdf_path=pdf_path, original_filename=original_filename
        )

        # 2. Per-table extraction
        for table in all_tables:
            if not table:
                continue

            roles = _identify_columns(table)
            depth_col = roles["depth_col"]
            blows_col = roles["blows_col"]
            strat_col = roles["strat_col"]

            # Build per-row depth map from the depth column
            depth_map = {}  # row_index -> [float, ...]
            if depth_col is not None:
                for ri, row in enumerate(table):
                    if not row or depth_col >= len(row):
                        continue
                    vals = _get_depth_floats_from_cell(row[depth_col])
                    if vals:
                        depth_map[ri] = vals

            # ── Strategy A: Columnar SPT (depth_col + blows_col) ──────────────
            if depth_col is not None and blows_col is not None:
                for ri, row in enumerate(table):
                    if not row:
                        continue
                    if depth_col >= len(row) or blows_col >= len(row):
                        continue
                    d_cell = row[depth_col]
                    b_cell = row[blows_col]
                    if not d_cell or not b_cell:
                        continue

                    d_str = str(d_cell).strip()
                    b_str = str(b_cell).strip()

                    # Need at least one newline to be multi-entry
                    if "\n" not in d_str and "\n" not in b_str:
                        continue

                    # Blows must start with a digit (not sample labels like S-1)
                    first_blow = b_str.split("\n")[0].strip()
                    if not re.match(r"^\d+", first_blow) and not first_blow.startswith("50/"):
                        continue

                    # Skip elevation columns (values > 200)
                    try:
                        if float(first_blow) > 200:
                            continue
                    except ValueError:
                        pass

                    tests = parse_spt_from_cells(d_str, b_str)
                    if tests:
                        logger.info(f"Strategy A: {len(tests)} SPT tests at r{ri}")
                        extracted_data["tests"].extend(tests)

            # ── Strategy B: Inline N=XX with cross-column depth lookup ─────────
            for ri, row in enumerate(table):
                if not row:
                    continue
                for ci, cell in enumerate(row):
                    if not cell:
                        continue
                    cell_str = str(cell)
                    if not _N_PATTERN.search(cell_str):
                        continue

                    # Gather depths from depth_col in same row, or nearby rows
                    row_depths = depth_map.get(ri, [])
                    if not row_depths:
                        for nearby in [ri - 1, ri - 2, ri + 1]:
                            if nearby in depth_map:
                                row_depths = depth_map[nearby]
                                break

                    # Also try other cells in the same row
                    if not row_depths:
                        for other_ci, other_cell in enumerate(row):
                            if other_ci == ci or not other_cell:
                                continue
                            vals = _get_depth_floats_from_cell(other_cell)
                            if vals:
                                row_depths = vals
                                break

                    # Parse all N=XX entries in this cell (newline-separated)
                    lines = [l.strip() for l in cell_str.split("\n") if l.strip()]
                    n_entries = []
                    for line in lines:
                        m = _N_PATTERN.search(line)
                        if m:
                            n_val = int(m.group(1))
                            n_entries.append((n_val, line))

                    if not n_entries:
                        continue

                    interval = 5.0  # default gap between SPT tests when inferred
                    if len(row_depths) >= 2:
                        interval = abs(row_depths[-1] - row_depths[0]) / (len(row_depths) - 1)
                        interval = max(1.5, interval)

                    for idx, (n_val, blow_str) in enumerate(n_entries):
                        if idx < len(row_depths):
                            depth = row_depths[idx]
                        elif row_depths:
                            depth = row_depths[-1] + interval * (idx - len(row_depths) + 1)
                        else:
                            depth = None

                        if depth is not None:
                            extracted_data["tests"].append({
                                "type": "SPT",
                                "depth_top_ft": depth,
                                "depth_bottom_ft": round(depth + 1.5, 2),
                                "n_value": n_val,
                                "blow_counts": blow_str,
                            })
                            logger.info(f"Strategy B: N={n_val} @ {depth}ft (r{ri} c{ci})")

            # ── Strategy C: Stratigraphy ───────────────────────────────────────
            if strat_col is not None:
                for ri, row in enumerate(table):
                    if not row or strat_col >= len(row):
                        continue
                    cell = row[strat_col]
                    if not cell or not str(cell).strip():
                        continue
                    cell_str = str(cell).strip()

                    # Format A: depth/elev format "0.0 / 659.6\nDescription..."
                    if re.search(r"\d+\.?\d*\s*/\s*\d+\.?\d*", cell_str):
                        layers = parse_stratigraphy_cell(cell_str)
                        if layers:
                            extracted_data["stratigraphy"].extend(layers)
                            logger.info(f"Strategy C-A: {len(layers)} strat layers at r{ri}")
                        continue

                    # Format B: Inline description text
                    if _SKIP_STRAT_PATTERNS.search(cell_str):
                        continue
                    if len(cell_str) < 8:
                        continue
                    if re.match(r"^[\d\s/.\-|]+$", cell_str):
                        continue

                    # Get depths from depth col for this row
                    depth_top = 0.0
                    depth_bot = 0.0
                    if depth_col is not None and depth_col < len(row) and row[depth_col]:
                        dep_vals = _get_depth_floats_from_cell(row[depth_col])
                        if dep_vals:
                            dep_vals.sort()
                            depth_top = dep_vals[0]
                            depth_bot = dep_vals[-1]

                    # Split multiline descriptions
                    desc_lines = [l.strip() for l in cell_str.split("\n") if l.strip()]
                    desc_lines = [l for l in desc_lines if (
                        len(l) > 7 and
                        not re.match(r"^[\d.\s]+$", l) and
                        not _SKIP_STRAT_PATTERNS.search(l)
                    )]

                    for dline in desc_lines:
                        uscs = ""
                        m = re.search(r"\(([A-Z]{2,3})\)", dline)
                        if m:
                            uscs = m.group(1)
                        else:
                            m2 = re.search(r"\b([A-Z]{2,3})\b$", dline)
                            if m2:
                                uscs = m2.group(1)

                        # BUG 5 fix: if top == bottom (single depth in cell), give a default thickness
                        effective_bottom = depth_bot if depth_bot > depth_top else depth_top + 1.5

                        extracted_data["stratigraphy"].append({
                            "top_ft": depth_top,
                            "bottom_ft": effective_bottom,
                            "description": dline,
                            "uscs_code": uscs,
                        })
                        logger.info(f"Strategy C-B: strat inline: {dline[:50]}")

        # ── Strategy D: Free-text soil descriptions (VDOT graphical log format) ──
        # Kicks in when table strategies found 0 stratigraphy layers.
        # VDOT PDFs put soil descriptions as floating text beside hatching symbols,
        # not inside table cells. We scan all page words for soil-keyword lines.
        if not extracted_data["stratigraphy"]:
            _SOIL_KW  = re.compile(
                r"\b(SAND|SILT|CLAY|GRAVEL|ROCK|FILL|PEAT|BEDROCK|SHALE|LIMESTONE|"
                r"RESIDUUM|IGM|WEATHERED|ALLUVIUM|TOPSOIL)\b", re.IGNORECASE
            )
            _USCS_PAT = re.compile(r"\b(SM|SP|SC|ML|CL|CH|MH|SW|GW|GM|GC|GP|OL|OH|PT|GF|SF)\b")
            _SKIP_FREE = re.compile(
                r"(PROJECT|BORING|BOREHOLE|PAGE|SHEET|DATE|DRILL|HAMMER|SAMPLER|"
                r"ELEVATION|LEGEND|STRATA|FIELD DESCRIPTION|GROUNDWATER|WATER TABLE)",
                re.IGNORECASE
            )

            for page in pdf.pages:
                words = page.extract_words(keep_blank_chars=False, x_tolerance=3, y_tolerance=3)
                if not words:
                    continue

                # Group words into lines by y-bucket (5pt tolerance)
                line_buckets = {}
                for w in words:
                    y_key = round(float(w["top"]) / 5) * 5
                    line_buckets.setdefault(y_key, []).append(w["text"])

                for y_key in sorted(line_buckets.keys()):
                    line_text = " ".join(line_buckets[y_key]).strip()
                    if len(line_text) < 12:
                        continue
                    if not _SOIL_KW.search(line_text):
                        continue
                    if _SKIP_FREE.search(line_text):
                        continue
                    # Must contain some alphabetic content (not just numbers)
                    if not re.search(r"[A-Za-z]{4,}", line_text):
                        continue

                    # Extract USCS code if present
                    uscs = ""
                    m_uscs = _USCS_PAT.search(line_text)
                    if m_uscs:
                        uscs = m_uscs.group(1)

                    # Depth range: span the full SPT depth range (fallback to 0→total_depth)
                    spt_tests = extracted_data["tests"]
                    if spt_tests:
                        top_ft = min(t["depth_top_ft"] for t in spt_tests)
                        bot_ft = max(t["depth_bottom_ft"] for t in spt_tests)
                    else:
                        top_ft = 0.0
                        bot_ft = extracted_data["metadata"].get("total_depth_ft") or 10.0

                    extracted_data["stratigraphy"].append({
                        "top_ft": top_ft,
                        "bottom_ft": bot_ft,
                        "description": line_text,
                        "uscs_code": uscs,
                    })
                    logger.info(f"Strategy D: free-text strat: {line_text[:80]}")

    # BUG 6 fix: Deduplicate SPT tests
    # Step 1: by exact (depth_top, n_value) to remove identical duplicates
    seen_exact = set()
    step1 = []
    for t in extracted_data["tests"]:
        key = (t.get("depth_top_ft"), t.get("n_value"))
        if key not in seen_exact:
            seen_exact.add(key)
            step1.append(t)

    # Step 2: by depth_top alone — keep highest n_value to resolve Strategy A vs B conflicts
    depth_best = {}  # depth_top -> test dict
    for t in step1:
        d = t.get("depth_top_ft")
        if d not in depth_best or (t.get("n_value") or 0) > (depth_best[d].get("n_value") or 0):
            depth_best[d] = t
    extracted_data["tests"] = sorted(depth_best.values(), key=lambda x: x.get("depth_top_ft") or 0)

    logger.info(
        f"Extraction complete. "
        f"Stratigraphy: {len(extracted_data['stratigraphy'])} layers, "
        f"SPT: {len(extracted_data['tests'])} tests"
    )
    return extracted_data
