"""
3D Soil Profile Visualization — Geosetta-Like
Diggs Hackathon

Generates interactive 3D borehole visualizations from Excel borehole data.
Phase 1: Per-upload isolation — shows only the converted PDF's borehole(s).
Phase 2: Cylinder rendering — smooth colored tubes, SPT profile, rich hover.
Phase 3: Real GPS positioning — lat/lon → local East/North feet.
Phase 4: Cross-section — built from real extracted borehole data.
"""

import pandas as pd
import numpy as np
import plotly.graph_objects as go
import re
import math
import os
import logging

log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Soil color palette
# ─────────────────────────────────────────────────────────────────────────────
SOIL_COLORS = {
    "Sand":                       "#F4A460",
    "Silt":                       "#D2B48C",
    "Clay":                       "#A0522D",
    "Rock":                       "#808080",
    "Fill":                       "#9E9E9E",
    "Gravel":                     "#BDB76B",
    "Mixed":                      "#DEB887",
    "Inferred: Loose (SPT)":      "#93C5FD",
    "Inferred: Med Dense (SPT)":  "#FBBF24",
    "Inferred: Dense/Hard (SPT)": "#B45309",
    "Unknown":                    "#CCCCCC",
}

def get_soil_color(soil_type_str):
    """Map a soil type string to a hex color."""
    if not isinstance(soil_type_str, str):
        return "#CCCCCC"
    s = soil_type_str.strip().title()
    for key, color in SOIL_COLORS.items():
        if key in s:
            return color
    return "#CCCCCC"


def classify_soil(desc, n_val):
    """
    Classify soil type from description text first.
    Falls back to SPT N-value range if no recognizable keyword.
    Falls back to 'Unknown' if no data at all.
    """
    if isinstance(desc, str) and desc.strip():
        for kw in ["Sand", "Silt", "Clay", "Rock", "Fill", "Gravel"]:
            if kw.upper() in desc.upper():
                return kw
    try:
        n = float(n_val)
        if n < 10:
            return "Inferred: Loose (SPT)"
        elif n <= 30:
            return "Inferred: Med Dense (SPT)"
        else:
            return "Inferred: Dense/Hard (SPT)"
    except (TypeError, ValueError):
        return "Unknown"


# ─────────────────────────────────────────────────────────────────────────────
# GPS → local feet conversion (Phase 3)
# ─────────────────────────────────────────────────────────────────────────────

def latlon_to_local_ft(lat, lon, origin_lat, origin_lon):
    """
    Convert lat/lon to local East/North offsets in feet.
    Uses spherical Earth approximation — accurate enough for site-scale distances.
    """
    north_ft = (lat - origin_lat) * 364000.0
    east_ft  = (lon - origin_lon) * math.cos(math.radians(origin_lat)) * 364000.0
    return float(east_ft), float(north_ft)


# ─────────────────────────────────────────────────────────────────────────────
# Cylinder segment builder (Phase 2)
# ─────────────────────────────────────────────────────────────────────────────

def build_cylinder_segment(x0, y0, elev, top_ft, bottom_ft,
                           color, bh_id, soil, desc, uscs, n_val,
                           radius=4, n_theta=36):
    """
    Build a Plotly Surface trace for one colored cylinder layer segment.
    The cylinder side surface is parameterized as a 2×n_theta grid:
      row 0 = top ring, row 1 = bottom ring.
    """
    theta = np.linspace(0, 2 * np.pi, n_theta)

    # Absolute elevation of top and bottom of this layer
    top_z    = elev - top_ft
    bottom_z = elev - bottom_ft

    xs = np.array([x0 + radius * np.cos(theta),
                   x0 + radius * np.cos(theta)])
    ys = np.array([y0 + radius * np.sin(theta),
                   y0 + radius * np.sin(theta)])
    zs = np.array([[top_z]    * n_theta,
                   [bottom_z] * n_theta])

    # Force uniform color (surfacecolor = constant array + two-stop colorscale)
    scolor = np.zeros_like(zs)

    thickness = round(bottom_ft - top_ft, 1)
    n_str     = f"{int(n_val)} blows/ft" if n_val is not None else "N/A"
    uscs_str  = f" ({uscs})" if uscs else ""
    desc_short = str(desc)[:80] if isinstance(desc, str) else ""

    hover = (
        f"<b>{bh_id}</b><br>"
        f"Soil: {soil}{uscs_str}<br>"
        f"Depth: {top_ft} – {bottom_ft} ft  ({thickness} ft thick)<br>"
        f"Elevation: {top_z:.1f} – {bottom_z:.1f} ft AMSL<br>"
        f"SPT N-Value: {n_str}<br>"
        f"<i>{desc_short}</i>"
        "<extra></extra>"
    )

    return go.Surface(
        x=xs, y=ys, z=zs,
        surfacecolor=scolor,
        colorscale=[[0, color], [1, color]],
        showscale=False,
        opacity=0.88,
        name=soil,
        showlegend=False,        # legend managed via dummy Scatter3d
        legendgroup=soil,
        hovertemplate=hover,
    )


# ─────────────────────────────────────────────────────────────────────────────
# SPT N-value profile sidebar (Phase 2)
# ─────────────────────────────────────────────────────────────────────────────

def build_spt_profile(bh_id, x0, y0, elev, layers, radius=4):
    """
    Build a Scatter3d line showing SPT N-values as horizontal offset
    from the borehole cylinder — a vertical profile of soil stiffness.
    """
    xs, ys, zs, texts = [], [], [], []

    for layer in layers:
        if layer.get("n_value") is None:
            continue
        n   = layer["n_value"]
        mid = (layer["top"] + layer["bottom"]) / 2.0
        z   = elev - mid
        # Offset to right: radius + 1 gap + n/5 (max ~10 ft for N=50)
        x_offset = x0 + radius + 1.5 + min(n / 5.0, 12.0)
        xs.append(x_offset)
        ys.append(y0)
        zs.append(z)
        texts.append(f"N={int(n)}")

    if not xs:
        return None

    return go.Scatter3d(
        x=xs, y=ys, z=zs,
        mode="lines+markers+text",
        line=dict(color="#60A5FA", width=2),
        marker=dict(size=4, color="#60A5FA"),
        text=texts,
        textposition="middle right",
        textfont=dict(size=9, color="#60A5FA"),
        name=f"{bh_id} SPT",
        showlegend=False,
        hoverinfo="skip",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Data loaders
# ─────────────────────────────────────────────────────────────────────────────

def _parse_layers_from_df(df):
    """Extract layer list from a borehole Excel dataframe.
    Skips zero-thickness layers (top == bottom) to avoid rendering artefacts.
    """
    layers = []
    for _, row in df.iterrows():
        top    = row.get("Top Depth (ft)")
        bottom = row.get("Bottom Depth (ft)")
        if not (pd.notna(top) and pd.notna(bottom)):
            continue
        top, bottom = float(top), float(bottom)
        # Skip zero-thickness layers — they cause jagged cross-sections
        if bottom <= top:
            continue
        desc      = row.get("Soil Description", "")
        uscs      = row.get("USCS Code", "")
        n_val_raw = row.get("N-Value (SPT)")
        n_val     = float(n_val_raw) if pd.notna(n_val_raw) else None
        soil      = classify_soil(desc, n_val)
        layers.append({
            "top":         top,
            "bottom":      bottom,
            "soil":        soil,
            "description": str(desc).strip() if isinstance(desc, str) and desc.strip() else "No description",
            "uscs":        str(uscs).strip() if isinstance(uscs, str) else "",
            "n_value":     n_val,
        })
    return layers


def load_from_single_excel(excel_path):
    """
    Phase 1 — load a per-borehole Excel for a single-upload visualization.

    The per-borehole Excel (from xml_to_excel.py) has two sheets:
      Sheet 1 "Borehole Info"      — key-value metadata (row 3+: Label | Value)
      Sheet 2 "Stratigraphy & SPT" — tabular layer data with column headers

    Returns (layers_map, coords) where coords stores (east_ft, north_ft, elev).
    Single borehole is placed at origin (0, 0).
    """
    # ── Sheet 1: metadata (key-value pairs starting at row 3, col A=label, col B=value) ──
    df_meta = pd.read_excel(excel_path, sheet_name=0, header=None)
    meta = {}
    for _, row in df_meta.iterrows():
        label = str(row.iloc[0]).strip() if pd.notna(row.iloc[0]) else ""
        value = row.iloc[1] if len(row) > 1 else None
        if label and label not in ("BOREHOLE SUMMARY",) and not label.startswith("Project:"):
            meta[label] = value

    bh_id   = str(meta.get("Borehole ID", "Unknown"))
    elev_raw = meta.get("Elevation (ft)", 0.0)
    elev    = float(elev_raw) if pd.notna(elev_raw) else 0.0

    # ── Sheet 2: layer data (Stratigraphy & SPT) ──
    try:
        df_layers = pd.read_excel(excel_path, sheet_name=1, header=0)
    except Exception:
        df_layers = pd.DataFrame()

    coords     = {bh_id: (0.0, 0.0, elev)}
    layers_map = {bh_id: _parse_layers_from_df(df_layers)}
    return layers_map, coords


def load_from_master_excel(master_path):
    """
    Load master multi-borehole Excel.
    Phase 3: uses real GPS → local ft for positioning.
    Falls back to synthetic 100 ft grid if GPS is unavailable.
    """
    df = pd.read_excel(master_path, sheet_name=0, header=0)
    layers_map, coords = {}, {}

    if df.empty:
        return layers_map, coords

    bh_groups = df.groupby("Borehole ID")
    bh_list   = list(bh_groups.groups.keys())

    # Origin = first borehole lat/lon
    first_row  = bh_groups.get_group(bh_list[0]).iloc[0]
    origin_lat = first_row.get("Latitude")
    origin_lon = first_row.get("Longitude")

    for idx, bh_id in enumerate(bh_list):
        group = bh_groups.get_group(bh_id)
        row0  = group.iloc[0]

        lat      = row0.get("Latitude")
        lon      = row0.get("Longitude")
        elev_raw = row0.get("Elevation (ft)", 0.0)
        elev     = float(elev_raw) if pd.notna(elev_raw) else 0.0

        # Real GPS positioning
        if (pd.notna(lat) and pd.notna(lon) and
                pd.notna(origin_lat) and pd.notna(origin_lon)):
            east_ft, north_ft = latlon_to_local_ft(
                float(lat), float(lon), float(origin_lat), float(origin_lon)
            )
        else:
            # Synthetic grid fallback
            cols     = math.ceil(math.sqrt(len(bh_list)))
            east_ft  = (idx % cols) * 100.0
            north_ft = (idx // cols) * 100.0

        coords[bh_id] = (east_ft, north_ft, elev)
        layers_map[bh_id] = _parse_layers_from_df(group)

    return layers_map, coords


# ─────────────────────────────────────────────────────────────────────────────
# Phase 5 — Volumetric Interpolation (2+ boreholes)
# ─────────────────────────────────────────────────────────────────────────────

def build_interpolated_volume(layers_map, coords):
    """
    Phase 5 — When 2+ boreholes exist, interpolate soil types between them
    and render semi-transparent isosurface volumes (Geosetta-like filled geology).

    Uses scipy.interpolate.griddata to build a 3D soil probability grid,
    then renders each soil class as a go.Volume trace.
    """
    try:
        from scipy.interpolate import griddata
    except ImportError:
        log.warning("scipy not installed — skipping volumetric interpolation (pip install scipy)")
        return []

    # Collect all boreholes that have coordinates + layers
    bh_ids = [b for b in layers_map if b in coords and layers_map[b]]
    if len(bh_ids) < 2:
        return []

    # Build a numeric soil code lookup
    all_soils = sorted({l["soil"] for b in bh_ids for l in layers_map[b]})
    soil_code  = {s: i for i, s in enumerate(all_soils)}

    # Sample points: for each borehole, sample the soil at regular depth steps
    xs, ys, zs, codes = [], [], [], []
    for bh_id in bh_ids:
        x0, y0, elev = coords[bh_id]
        for layer in layers_map[bh_id]:
            top_z    = elev - layer["top"]
            bottom_z = elev - layer["bottom"]
            n_samples = max(2, int((layer["bottom"] - layer["top"]) / 0.5))
            for z in np.linspace(top_z, bottom_z, n_samples):
                xs.append(x0);  ys.append(y0)
                zs.append(z);   codes.append(soil_code[layer["soil"]])

    if len(xs) < 4:
        return []

    points = np.column_stack([xs, ys, zs])

    # Build a regular 3D grid spanning the borehole field
    all_x = [coords[b][0] for b in bh_ids]
    all_y = [coords[b][1] for b in bh_ids]
    all_z = zs

    xi = np.linspace(min(all_x), max(all_x), 20)
    yi = np.linspace(min(all_y), max(all_y), 20)
    zi = np.linspace(min(all_z), max(all_z), 30)
    Xg, Yg, Zg = np.meshgrid(xi, yi, zi)
    grid_pts = np.column_stack([Xg.ravel(), Yg.ravel(), Zg.ravel()])

    # Interpolate soil codes onto the grid
    values = griddata(points, codes, grid_pts, method="nearest")
    Vg = values.reshape(Xg.shape)

    traces = []
    for soil, code in soil_code.items():
        color = get_soil_color(soil)
        mask  = (np.abs(Vg - code) < 0.5)
        if not mask.any():
            continue
        traces.append(go.Volume(
            x=Xg[mask].ravel(), y=Yg[mask].ravel(), z=Zg[mask].ravel(),
            value=Vg[mask].ravel(),
            isomin=code - 0.4, isomax=code + 0.4,
            opacity=0.12,
            surface_count=1,
            colorscale=[[0, color], [1, color]],
            showscale=False,
            name=f"{soil} (volume)",
            showlegend=False,
            hoverinfo="skip",
        ))

    return traces


# ─────────────────────────────────────────────────────────────────────────────
# 3D Cylinder Borehole Plot (Phase 2 + 5 + 6)
# ─────────────────────────────────────────────────────────────────────────────

def build_3d_borehole_plot(layers_map, coords, title_suffix="XML-Converted Data"):
    """
    Build Geosetta-like 3D cylinder borehole plot.
    Each borehole = stack of colored cylinder segments.
    Graceful degradation if data is incomplete.
    """
    fig = go.Figure()
    legend_added = set()

    for bh_id, layers in layers_map.items():
        if bh_id not in coords:
            continue
        x0, y0, elev = coords[bh_id]

        # ── Graceful degradation: no layers at all ──────────────────────────
        if not layers:
            fig.add_trace(go.Scatter3d(
                x=[x0, x0], y=[y0, y0], z=[elev, elev - 20],
                mode="lines",
                line=dict(color="#888", width=4, dash="dash"),
                name=bh_id,
                showlegend=False,
                hovertemplate=f"<b>{bh_id}</b><br>No layer data available<extra></extra>",
            ))
            fig.add_trace(go.Scatter3d(
                x=[x0], y=[y0], z=[elev + 3],
                mode="text",
                text=[f"{bh_id}\n(no data)"],
                textfont=dict(size=11, color="#aaa", family="Arial"),
                showlegend=False, hoverinfo="skip",
            ))
            continue

        # ── Cylinder segments per layer ─────────────────────────────────────
        for layer in layers:
            soil  = layer["soil"]
            color = get_soil_color(soil)

            seg = build_cylinder_segment(
                x0, y0, elev,
                layer["top"], layer["bottom"],
                color, bh_id, soil,
                layer["description"], layer["uscs"], layer["n_value"]
            )
            fig.add_trace(seg)

            # Dummy Scatter3d for legend (Surface traces don't appear in legend)
            if soil not in legend_added:
                legend_added.add(soil)
                fig.add_trace(go.Scatter3d(
                    x=[None], y=[None], z=[None],
                    mode="markers",
                    marker=dict(size=10, color=color, symbol="square"),
                    name=soil,
                    showlegend=True,
                    legendgroup=soil,
                ))

        # ── SPT N-value profile sidebar ─────────────────────────────────────
        spt_trace = build_spt_profile(bh_id, x0, y0, elev, layers)
        if spt_trace:
            fig.add_trace(spt_trace)

        # ── Borehole label at surface ───────────────────────────────────────
        fig.add_trace(go.Scatter3d(
            x=[x0], y=[y0], z=[elev + 3],
            mode="text",
            text=[bh_id],
            textfont=dict(size=13, color="white", family="Arial Black"),
            showlegend=False,
            hoverinfo="skip",
        ))

    # ── Phase 5: Volumetric interpolation (2+ boreholes) ────────────────────
    if len(layers_map) >= 2:
        interp_traces = build_interpolated_volume(layers_map, coords)
        for t in interp_traces:
            fig.add_trace(t)

    # ── Compute depth range for clipping slider ──────────────────────────────
    all_bottoms = [
        layer["bottom"]
        for layers in layers_map.values()
        for layer in layers
    ]
    max_depth = max(all_bottoms) if all_bottoms else 20.0
    all_elevs  = [c[2] for c in coords.values()]
    max_elev   = max(all_elevs) if all_elevs else 0.0
    min_elev   = max_elev - max_depth

    # ── Phase 6: Camera preset buttons ──────────────────────────────────────
    camera_buttons = [
        dict(
            label="3D View",
            method="relayout",
            args=[{"scene.camera": {"eye": {"x": 1.8, "y": 1.8, "z": 1.2}}}],
        ),
        dict(
            label="Top View",
            method="relayout",
            args=[{"scene.camera": {"eye": {"x": 0, "y": 0, "z": 3.0}}}],
        ),
        dict(
            label="Side View",
            method="relayout",
            args=[{"scene.camera": {"eye": {"x": 2.5, "y": 0, "z": 0.3}}}],
        ),
        dict(
            label="Front View",
            method="relayout",
            args=[{"scene.camera": {"eye": {"x": 0, "y": 2.5, "z": 0.3}}}],
        ),
    ]

    # ── Phase 6: Depth clipping slider ──────────────────────────────────────
    n_steps  = 20
    z_steps  = np.linspace(max_elev, min_elev, n_steps)
    sliders  = [dict(
        active=n_steps - 1,
        pad={"t": 50},
        x=0.05, len=0.9,
        currentvalue=dict(
            prefix="Clip depth: elevation ",
            suffix=" ft AMSL",
            visible=True,
            font=dict(color="white", size=12),
        ),
        steps=[
            dict(
                method="relayout",
                label=f"{z:.0f}",
                args=[{"scene.zaxis.range": [z, max_elev + 5]}],
            )
            for z in z_steps
        ],
    )]

    fig.update_layout(
        title=dict(
            text=f"<b>3D Borehole Soil Profile</b><br><sup>Diggs Hackathon — {title_suffix}</sup>",
            x=0.5,
            font=dict(size=22, color="white"),
        ),
        scene=dict(
            xaxis=dict(title="East (ft)", backgroundcolor="#1a1a2e",
                       gridcolor="#444", zerolinecolor="#666"),
            yaxis=dict(title="North (ft)", backgroundcolor="#1a1a2e",
                       gridcolor="#444", zerolinecolor="#666"),
            zaxis=dict(title="Elevation (ft AMSL)", backgroundcolor="#1a1a2e",
                       gridcolor="#444", zerolinecolor="#666"),
            bgcolor="#1a1a2e",
            camera=dict(eye=dict(x=1.8, y=1.8, z=1.2)),
        ),
        updatemenus=[
            dict(
                type="buttons",
                direction="right",
                x=0.0, y=1.12,
                showactive=True,
                bgcolor="#1e2a4a",
                bordercolor="#555",
                font=dict(color="white", size=11),
                buttons=camera_buttons,
            )
        ],
        sliders=sliders,
        paper_bgcolor="#0a0a1a",
        font=dict(color="white", family="Arial"),
        legend=dict(
            title="<b>Soil Type</b>",
            bgcolor="rgba(30,30,60,0.8)",
            bordercolor="#555",
            borderwidth=1,
            font=dict(size=12),
        ),
        margin=dict(l=0, r=0, b=80, t=80),
    )
    return fig


# ─────────────────────────────────────────────────────────────────────────────
# Cross-Section from real borehole data (Phase 4)
# ─────────────────────────────────────────────────────────────────────────────

def _dark_layout(title, xlabel, ylabel, zlabel):
    """Shared dark theme layout dict."""
    return dict(
        title=dict(
            text=f"<b>{title}</b><br><sup>Diggs Hackathon — Real Borehole Data</sup>",
            x=0.5,
            font=dict(size=20, color="white"),
        ),
        scene=dict(
            xaxis=dict(title=xlabel, backgroundcolor="#0d1b2a", gridcolor="#334"),
            yaxis=dict(title=ylabel, backgroundcolor="#0d1b2a", gridcolor="#334"),
            zaxis=dict(title=zlabel, backgroundcolor="#0d1b2a", gridcolor="#334"),
            bgcolor="#0d1b2a",
            camera=dict(eye=dict(x=1.6, y=-1.8, z=0.9)),
        ),
        paper_bgcolor="#060f1a",
        font=dict(color="white", family="Arial"),
        legend=dict(
            title="<b>Soil Type</b>",
            bgcolor="rgba(10,20,40,0.85)",
            bordercolor="#445",
            borderwidth=1,
        ),
        margin=dict(l=0, r=0, b=0, t=80),
    )


def build_cross_section_from_boreholes(layers_map, coords):
    """
    Phase 4 — build a 3D cross-section from real extracted borehole data.

    Single borehole  → vertical soil profile panel (side-on slice view).
    Multiple boreholes → ribbon panels connecting adjacent boreholes,
                         linearly interpolating layer boundaries.
    No longer depends on data/profile_analysis.xlsx.
    """
    fig = go.Figure()
    legend_added = set()

    # Sort by East position (left → right along profile)
    sorted_bhs = sorted(
        [(bh_id, coords[bh_id]) for bh_id in layers_map if bh_id in coords],
        key=lambda x: x[1][0],
    )

    if not sorted_bhs:
        return fig

    # ── Single borehole: vertical profile panel ─────────────────────────────
    if len(sorted_bhs) == 1:
        bh_id, (x0, y0, elev) = sorted_bhs[0]
        layers = layers_map[bh_id]
        hw = 20  # half-width of the profile panel in ft

        for layer in layers:
            soil     = layer["soil"]
            color    = get_soil_color(soil)
            top_z    = elev - layer["top"]
            bottom_z = elev - layer["bottom"]

            xs = [x0-hw, x0+hw, x0+hw, x0-hw,  x0-hw, x0+hw, x0+hw, x0-hw]
            ys = [0,      0,     0,     0,       0,     0,     0,     0    ]
            zs = [top_z,  top_z, top_z, top_z,   bottom_z, bottom_z, bottom_z, bottom_z]

            show_legend = soil not in legend_added
            if show_legend:
                legend_added.add(soil)

            fig.add_trace(go.Mesh3d(
                x=xs, y=ys, z=zs,
                i=[0,0,0,0,1,5,4,0,2,6,5,1],
                j=[1,2,4,5,2,6,5,3,3,7,6,2],
                k=[2,3,5,6,5,7,6,4,7,4,7,6],
                color=color, opacity=0.82, flatshading=True,
                name=soil, showlegend=show_legend, legendgroup=soil,
                hovertemplate=(
                    f"<b>{bh_id}</b><br>"
                    f"Soil: {soil}<br>"
                    f"Depth: {layer['top']} – {layer['bottom']} ft<br>"
                    f"<i>{layer['description'][:60]}</i>"
                    "<extra></extra>"
                ),
            ))

        fig.update_layout(**_dark_layout(
            "Vertical Soil Profile (Single Borehole)",
            "East (ft)", "North (ft)", "Elevation (ft AMSL)"
        ))
        return fig

    # ── Multiple boreholes: interpolated ribbon cross-section ───────────────
    for i in range(len(sorted_bhs) - 1):
        bh_id_a, (xa, ya, elev_a) = sorted_bhs[i]
        bh_id_b, (xb, yb, elev_b) = sorted_bhs[i + 1]
        layers_a = layers_map[bh_id_a]
        layers_b = layers_map[bh_id_b]
        n_layers = min(len(layers_a), len(layers_b))
        hw = 30  # lateral half-width of ribbon

        for j in range(n_layers):
            la   = layers_a[j]
            lb   = layers_b[j]
            soil = la["soil"]
            color = get_soil_color(soil)

            top_z_a    = elev_a - la["top"]
            bottom_z_a = elev_a - la["bottom"]
            top_z_b    = elev_b - lb["top"]
            bottom_z_b = elev_b - lb["bottom"]

            xs = [xa, xb, xb, xa,  xa, xb, xb, xa]
            ys = [-hw,-hw, hw, hw,  -hw,-hw, hw, hw]
            zs = [top_z_a, top_z_b, top_z_b, top_z_a,
                  bottom_z_a, bottom_z_b, bottom_z_b, bottom_z_a]

            show_legend = soil not in legend_added
            if show_legend:
                legend_added.add(soil)

            fig.add_trace(go.Mesh3d(
                x=xs, y=ys, z=zs,
                i=[0,0,0,0,1,5,4,0,2,6,5,1],
                j=[1,2,4,5,2,6,5,3,3,7,6,2],
                k=[2,3,5,6,5,7,6,4,7,4,7,6],
                color=color, opacity=0.82, flatshading=True,
                name=soil, showlegend=show_legend, legendgroup=soil,
                hovertemplate=(
                    f"<b>{bh_id_a} → {bh_id_b}</b><br>"
                    f"Soil: {soil}<br>"
                    f"Depth: {la['top']} – {la['bottom']} ft<br>"
                    "<extra></extra>"
                ),
            ))

    fig.update_layout(**_dark_layout(
        "3D Geological Cross-Section Profile",
        "East (ft)", "North (ft)", "Elevation (ft AMSL)"
    ))
    return fig


# ─────────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────────

def regenerate_plots(
    output_dir="output/plots",
    borehole_excel_path=None,           # Phase 1: per-upload specific file
    master_path="output/excel/master_boreholes.xlsx",
    sample_grid_path="data/BOREHOLE EXCEL.xlsx",
):
    """
    Regenerate both HTML plot files.

    Priority order for Borehole Grid data:
      1. borehole_excel_path  — the just-converted PDF's Excel (per-upload view)
      2. master_boreholes.xlsx — cumulative all-boreholes view
      3. data/BOREHOLE EXCEL.xlsx — legacy sample data fallback

    Cross-Section is always built from the same data source as the Grid
    (no more dependency on data/profile_analysis.xlsx).
    """
    os.makedirs(output_dir, exist_ok=True)

    # ── Choose data source ───────────────────────────────────────────────────
    layers_map, coords, title_suffix = {}, {}, "No Data"

    if borehole_excel_path and os.path.exists(borehole_excel_path):
        log.info(f"Per-upload 3D: {borehole_excel_path}")
        layers_map, coords = load_from_single_excel(borehole_excel_path)
        bh_id = list(layers_map.keys())[0] if layers_map else "Unknown"
        title_suffix = f"Borehole {bh_id}"

    elif os.path.exists(master_path):
        log.info(f"Master 3D: {master_path}")
        layers_map, coords = load_from_master_excel(master_path)
        title_suffix = "All Converted Boreholes"

    elif os.path.exists(sample_grid_path):
        log.info(f"Sample fallback 3D: {sample_grid_path}")
        layers_map, coords = load_borehole_excel(sample_grid_path)
        title_suffix = "Sample Data"

    # ── Borehole Grid ────────────────────────────────────────────────────────
    out1 = os.path.join(output_dir, "3d_borehole_grid.html")
    if layers_map:
        fig1 = build_3d_borehole_plot(layers_map, coords, title_suffix=title_suffix)
        fig1.write_html(out1, include_plotlyjs="cdn")
        log.info(f"Grid plot written: {out1}")

    # ── Cross-Section (from real borehole data) ──────────────────────────────
    out2 = os.path.join(output_dir, "3d_cross_section.html")
    if layers_map:
        fig2 = build_cross_section_from_boreholes(layers_map, coords)
        fig2.write_html(out2, include_plotlyjs="cdn")
        log.info(f"Cross-section written: {out2}")

    return out1, out2


# ─────────────────────────────────────────────────────────────────────────────
# Legacy sample Excel loader (kept for backward compatibility)
# ─────────────────────────────────────────────────────────────────────────────

def load_borehole_excel(path="data/BOREHOLE EXCEL.xlsx"):
    """Original sample Excel loader — kept for backward compatibility."""
    df_raw = pd.read_excel(path, header=None)
    coords, layers_map, current_bh = {}, {}, None

    for _, row in df_raw.iterrows():
        bh_coord = row.iloc[12]
        x_val    = row.iloc[13]
        y_val    = row.iloc[14]
        if isinstance(bh_coord, str) and bh_coord.startswith("BH"):
            coords[bh_coord] = (float(x_val), float(y_val), 0.0)

        bh_id  = row.iloc[3]
        top    = row.iloc[4]
        bottom = row.iloc[5]
        soil   = row.iloc[6]

        if isinstance(bh_id, str) and bh_id.startswith("BH"):
            current_bh = bh_id
            if current_bh not in layers_map:
                layers_map[current_bh] = []

        if pd.notna(top) and pd.notna(bottom) and pd.notna(soil) and current_bh:
            try:
                layers_map[current_bh].append({
                    "top":         float(top),
                    "bottom":      float(bottom),
                    "soil":        str(soil).strip(),
                    "description": str(soil).strip(),
                    "uscs":        "",
                    "n_value":     None,
                })
            except (ValueError, TypeError):
                pass

    return layers_map, coords


# ─────────────────────────────────────────────────────────────────────────────
# Run directly to regenerate plots
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Regenerating 3D plots...")
    out1, out2 = regenerate_plots()
    print(f"\n✅ Done!")
    print(f"   1. {out1}")
    print(f"   2. {out2}")
