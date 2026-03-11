"""
Liquefaction Excel export logic (extracted from app.py).
"""
import io
import numpy as np
import pandas as pd
from flask import jsonify, send_file

from liquefaction import (
    IdrissBoulanger2014,
    NCEER2001,
    calculate_stress_profile,
    calculate_cpt_liquefaction_bi2014,
    calculate_cpt_liquefaction_youd2001,
    convert_to_imperial,
    plot_liquefaction_analysis,
    plot_cpt_liquefaction_results,
    generate_multi_method_excel,
    _create_symbol_description_sheet,
    _create_cpt_methodology_sheet,
    _write_cpt_methodology_to_worksheet,
    _create_spt_methodology_sheet,
)


def run_export_excel(data):
    if data is None:
        return jsonify({"status": "error", "message": "Request body is required (JSON)"}), 400
    try:
        # 1. 
        pga = float(data.get('pga', 0.4))
        mw = float(data.get('mw', 7.5))
        gwt_drill = float(data.get('gwt_drill', data.get('gwt', 1.5)))
        gwt_design = float(data.get('gwt_design', data.get('gwt', 1.5)))
        ce = float(data.get('ce', 0.60))  # Energy Ratio (default 0.60 = 60%)
        layers = data.get('layers', [])
        unit_system = data.get('unit_system', 'imperial')  # 
        test_type = str(data.get('test_type', 'SPT')).upper()
        boreholes = data.get('boreholes') if isinstance(data, dict) else None
        
        # （）
        methods = data.get('methods', [])
        if not methods:
            # ：methods，method
            method = data.get('method', 'IB2014')
            if isinstance(method, list):
                methods = method
            else:
                methods = [method] if method in ['IB2014', 'NCEER2001'] else ['IB2014', 'NCEER2001']
        
        # （）
        valid_methods = [m for m in methods if m in ['IB2014', 'NCEER2001']]
        if not valid_methods:
            valid_methods = ['IB2014', 'NCEER2001']

        # =========================================================
        # Multi-tag export (SPT/CPT batch)
        # =========================================================
        if isinstance(boreholes, list) and len(boreholes) > 0:
            output = io.BytesIO()
            download_name = 'Liquefaction_Batch_Report.xlsx'
            with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
                wb = writer.book
                title_fmt = wb.add_format({'bold': True, 'font_size': 14})
                header_fmt = wb.add_format({'bold': True, 'border': 1, 'border_color': '#D9D9D9'})
                normal_fmt = wb.add_format({'border': 1, 'border_color': '#D9D9D9'})

                def _safe_sheet_name(name: str) -> str:
                    s = ''.join(ch for ch in (name or '') if ch not in '[]:*?/\\')
                    s = s.strip() or 'Sheet'
                    return s[:31]

                used_sheet_names = set()
                def _unique_sheet_name(base: str) -> str:
                    base = _safe_sheet_name(base)
                    name = base
                    i = 2
                    while name in used_sheet_names:
                        suffix = f"_{i}"
                        name = (base[: max(0, 31 - len(suffix))] + suffix) if len(base) + len(suffix) > 31 else (base + suffix)
                        i += 1
                    used_sheet_names.add(name)
                    return name

                # ----------------------------
                # Batch CPT export
                # ----------------------------
                if test_type == 'CPT':
                    # Helper: backend intermediate (same as single export, simplified)
                    def _compute_cpt_intermediate_backend(cpt_rows, gwt_val, unit_sys, net_area_ratio):
                        TSF_TO_KPA = 95.7605
                        FT_TO_M = 0.3048
                        gamma_kN_m3 = 18.0
                        gamma_w = 9.81
                        an = float(net_area_ratio) if net_area_ratio is not None else 0.8

                        def to_float(x):
                            try:
                                return float(x)
                            except Exception:
                                return None

                        gwt_m = float(gwt_val) * FT_TO_M if str(unit_sys).lower() == 'imperial' else float(gwt_val)

                        rows_si = []
                        for r in cpt_rows or []:
                            d = to_float(r.get('depth'))
                            qc = to_float(r.get('qc'))
                            fs0 = to_float(r.get('fs'))
                            u2_head = to_float(r.get('u2')) if r.get('u2') is not None else None
                            if d is None or qc is None or fs0 is None:
                                continue
                            if str(unit_sys).lower() == 'imperial':
                                u2_head_m = (u2_head * FT_TO_M) if u2_head is not None else None
                                rows_si.append({
                                    "depth_m": d * FT_TO_M,
                                    "qc_kpa": qc * TSF_TO_KPA,
                                    "fs_kpa": fs0 * TSF_TO_KPA,
                                    "u2_head_m": u2_head_m,
                                    "u2_kpa": (u2_head_m * gamma_w) if u2_head_m is not None else None
                                })
                            else:
                                u2_head_m = u2_head
                                rows_si.append({
                                    "depth_m": d,
                                    "qc_kpa": qc,
                                    "fs_kpa": fs0,
                                    "u2_head_m": u2_head_m,
                                    "u2_kpa": (u2_head_m * gamma_w) if u2_head_m is not None else None
                                })
                        rows_si.sort(key=lambda x: x["depth_m"])

                        sigma_v0 = 0.0
                        prev_depth = 0.0
                        out_rows = []
                        for r in rows_si:
                            depth = r["depth_m"]
                            thickness = max(0.0, depth - prev_depth)
                            sigma_v0 += thickness * gamma_kN_m3
                            u = (depth - gwt_m) * gamma_w if depth > gwt_m else 0.0
                            sigma_v0_eff = max(0.0001, sigma_v0 - u)
                            qt_kpa = r["qc_kpa"] if r["u2_kpa"] is None else (r["qc_kpa"] + (1.0 - an) * r["u2_kpa"])
                            denom = max(0.0001, qt_kpa - sigma_v0)
                            Qt = denom / sigma_v0_eff
                            Fr = (r["fs_kpa"] / denom) * 100.0
                            Ic = None
                            if Qt > 0 and Fr > 0:
                                Ic = float(np.sqrt((3.47 - np.log10(Qt))**2 + (np.log10(Fr) + 1.22)**2))

                            if str(unit_sys).lower() == 'imperial':
                                out_rows.append({
                                    "depth": depth / FT_TO_M,
                                    "qc": r["qc_kpa"] / TSF_TO_KPA,
                                    "fs": r["fs_kpa"] / TSF_TO_KPA,
                                    "u2": (r["u2_head_m"] / FT_TO_M) if r.get("u2_head_m") is not None else None,
                                    "qt": qt_kpa / TSF_TO_KPA,
                                    "sigma_v0": sigma_v0 / TSF_TO_KPA,
                                    "sigma_v0_eff": sigma_v0_eff / TSF_TO_KPA,
                                    "Qt": Qt,
                                    "Fr": Fr,
                                    "Ic": Ic
                                })
                            else:
                                out_rows.append({
                                    "depth": depth,
                                    "qc": r["qc_kpa"],
                                    "fs": r["fs_kpa"],
                                    "u2": r.get("u2_head_m"),
                                    "qt": qt_kpa,
                                    "sigma_v0": sigma_v0,
                                    "sigma_v0_eff": sigma_v0_eff,
                                    "Qt": Qt,
                                    "Fr": Fr,
                                    "Ic": Ic
                                })
                            prev_depth = depth

                        return {"unitSystem": unit_sys, "assumptions": {"net_area_ratio": an}, "rows": out_rows}

                    length_unit = 'ft' if str(unit_system).lower() == 'imperial' else 'm'
                    stress_unit = 'tsf' if str(unit_system).lower() == 'imperial' else 'kPa'
                    unit_weight_unit = 'pcf' if str(unit_system).lower() == 'imperial' else 'kN/m³'
                    subhead_fmt = wb.add_format({'bold': True})
                    italic_fmt = wb.add_format({'italic': True})

                    # Tab 1 & 2: Per-method sheets (methodology at top + computed data per tag)
                    # Tab 3: Plots (both methods per tag)
                    # Tab 4: Symbol Description
                    batch_valid_cpt = ['Youd2001', 'IB2014']
                    ws_robertson = wb.add_worksheet('Results (Robertson 2009)')
                    writer.sheets['Results (Robertson 2009)'] = ws_robertson
                    ws_bi = wb.add_worksheet('Results (B&I 2014)')
                    writer.sheets['Results (B&I 2014)'] = ws_bi
                    ws_plot = wb.add_worksheet('CPT Plots')
                    writer.sheets['CPT Plots'] = ws_plot

                    # Write methodology at top of each method sheet
                    next_row_r = _write_cpt_methodology_to_worksheet(ws_robertson, wb, 'Youd2001', start_row=0)
                    next_row_b = _write_cpt_methodology_to_worksheet(ws_bi, wb, 'IB2014', start_row=0)

                    KPA_PER_TSF, FT_PER_M, PCF_PER_KN_M3 = 95.7605, 3.28084, 6.36588
                    rename_map = {
                        'depth': f'depth_{length_unit}', 'qc': f'qc_{stress_unit}', 'fs': f'fs_{stress_unit}',
                        'u2': f'u2_{stress_unit}', 'qt': f'qt_{stress_unit}',
                        'sigma_v': f'sigma_v0_{stress_unit}', 'sigma_ve': f"sigma_v0_eff_{stress_unit}",
                        'sigma_ve_design': f"sigma_v0_eff_design_{stress_unit}",
                        'gamma': f'gamma_{unit_weight_unit}', 'Settlement_m': 'Settlement_ft',
                    } if str(unit_system).lower() == 'imperial' else {}

                    plot_row = 2
                    cpt_boreholes_with_data = 0
                    for bh_i, bh in enumerate(boreholes, start=1):
                        tag = str((bh or {}).get('name') or (bh or {}).get('id') or f'CPT-{bh_i}')
                        bh_gwt_drill = float((bh or {}).get('gwt_drill', gwt_drill))
                        bh_gwt_design = float((bh or {}).get('gwt_design', gwt_design))
                        cpt_raw = (bh or {}).get('cpt_data') or (bh or {}).get('layers') or []
                        # Fallback: use top-level cpt_data/layers when borehole has none (frontend may structure differently)
                        if not cpt_raw:
                            cpt_raw = data.get('cpt_data') or data.get('layers') or []
                        if not cpt_raw:
                            continue
                        cpt_boreholes_with_data += 1
                        cpt_params = (bh or {}).get('cpt_params') or {}
                        an = cpt_params.get('net_area_ratio', cpt_params.get('netAreaRatio', 0.8))
                        try:
                            an = float(an)
                        except Exception:
                            an = 0.8

                        # Compute intermediate and BI2014
                        cpt_intermediate = _compute_cpt_intermediate_backend(cpt_raw, bh_gwt_drill, unit_system, an)
                        df_details = pd.DataFrame(cpt_intermediate.get('rows', []))
                        df_raw = pd.DataFrame(cpt_raw)

                        df_cpt = pd.DataFrame(cpt_raw or [])
                        if 'u2' not in df_cpt.columns:
                            df_cpt['u2'] = 0.0

                        # Convert to SI for BI2014 (depth=m, qc/fs/u2=kPa)
                        if str(unit_system).lower() == 'imperial':
                            df_cpt['depth'] = pd.to_numeric(df_cpt['depth'], errors='coerce') * 0.3048
                            gwl_drill_ft = bh_gwt_drill
                            gwl_design_ft = bh_gwt_design
                            TSF_TO_KPA = 95.7605
                            df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * TSF_TO_KPA
                            df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * TSF_TO_KPA
                        else:
                            df_cpt['depth'] = pd.to_numeric(df_cpt['depth'], errors='coerce')
                            gwl_drill_ft = bh_gwt_drill / 0.3048
                            gwl_design_ft = bh_gwt_design / 0.3048

                        try:
                            df_cpt['u2'] = pd.to_numeric(df_cpt['u2'], errors='coerce').fillna(0.0)
                            if str(unit_system).lower() == 'imperial':
                                u2_head_m = df_cpt['u2'] * 0.3048
                            else:
                                u2_head_m = df_cpt['u2']
                            df_cpt['u2'] = u2_head_m * 9.81
                        except Exception:
                            df_cpt['u2'] = 0.0

                        # Heuristic MPa -> kPa (metric)
                        if str(unit_system).lower() != 'imperial':
                            try:
                                qc_med = float(pd.to_numeric(df_cpt['qc'], errors='coerce').median())
                                if qc_med > 0 and qc_med < 200:
                                    df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * 1000.0
                                    df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * 1000.0
                            except Exception:
                                pass

                        # Batch CPT: 
                        batch_cpt_methods = data.get('cpt_methods') or data.get('methods')
                        if not isinstance(batch_cpt_methods, list):
                            batch_cpt_methods = ['Youd2001', 'IB2014']
                        batch_valid_cpt = [m for m in batch_cpt_methods if m in ['Youd2001', 'IB2014']]
                        if not batch_valid_cpt:
                            batch_valid_cpt = ['Youd2001', 'IB2014']

                        cpt_batch_results = {}
                        for cpt_m in batch_valid_cpt:
                            if cpt_m == 'Youd2001':
                                dfo, tsm = calculate_cpt_liquefaction_youd2001(
                                    df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                                    mw=mw, pga=pga, gwl_drill_ft=gwl_drill_ft, gwl_design_ft=gwl_design_ft, an=an
                                )
                            else:
                                dfo, tsm = calculate_cpt_liquefaction_bi2014(
                                    df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                                    mw=mw, pga=pga, gwl_drill_ft=gwl_drill_ft, gwl_design_ft=gwl_design_ft, an=an
                                )
                            cpt_batch_results[cpt_m] = (dfo, tsm)

                        # （ per-method ）
                        if str(unit_system).lower() == 'imperial':
                            KPA_PER_TSF = 95.7605
                            FT_PER_M = 3.28084
                            PCF_PER_KN_M3 = 6.36588
                            rename_map = {
                                'depth': f'depth_{length_unit}', 'qc': f'qc_{stress_unit}', 'fs': f'fs_{stress_unit}',
                                'u2': f'u2_{stress_unit}', 'qt': f'qt_{stress_unit}',
                                'sigma_v': f'sigma_v0_{stress_unit}', 'sigma_ve': f"sigma_v0_eff_{stress_unit}",
                                'sigma_ve_design': f"sigma_v0_eff_design_{stress_unit}",
                                'gamma': f'gamma_{unit_weight_unit}', 'Settlement_m': 'Settlement_ft',
                            }
                        else:
                            KPA_PER_TSF = FT_PER_M = PCF_PER_KN_M3 = 1.0
                            rename_map = {}

                        # --- Tab 1 & 2: Append tag data to each method sheet ---
                        for cpt_m in batch_valid_cpt:
                            dfo_b, _ = cpt_batch_results[cpt_m]
                            ws_m = ws_robertson if cpt_m == 'Youd2001' else ws_bi
                            next_row = next_row_r if cpt_m == 'Youd2001' else next_row_b
                            next_row += 1
                            ws_m.write(next_row, 0, f'Tag: {tag}', title_fmt)
                            next_row += 1
                            ws_m.write(next_row, 0, f'PGA={pga} g, Mw={mw}, GWL(drill)={bh_gwt_drill} {length_unit}, GWL(design)={bh_gwt_design} {length_unit}, a_n={an}', subhead_fmt)
                            next_row += 1
                            dfo_exp_b = dfo_b.copy()
                            if str(unit_system).lower() == 'imperial':
                                def _cmb(col, f):
                                    if col in dfo_exp_b.columns:
                                        dfo_exp_b[col] = pd.to_numeric(dfo_exp_b[col], errors='coerce') * f
                                _cmb('depth', FT_PER_M)
                                for c in ['qc', 'fs', 'u2', 'qt', 'sigma_v', 'sigma_ve', 'sigma_ve_design']:
                                    _cmb(c, 1.0 / KPA_PER_TSF)
                                _cmb('gamma', PCF_PER_KN_M3)
                                _cmb('Settlement_m', FT_PER_M)
                                dfo_exp_b = dfo_exp_b.rename(columns={k: v for k, v in rename_map.items() if k in dfo_exp_b.columns})
                            else:
                                dfo_exp_b = dfo_exp_b.rename(columns={'sigma_v': 'sigma_v0_kPa', 'sigma_ve': "sigma_v0_eff_kPa", 'sigma_ve_design': "sigma_v0_eff_design_kPa", 'Settlement_m': 'Settlement_m'})
                            sh_name = 'Results (Robertson 2009)' if cpt_m == 'Youd2001' else 'Results (B&I 2014)'
                            dfo_exp_b.to_excel(writer, sheet_name=sh_name, startrow=next_row, startcol=0, index=False)
                            for c in range(len(dfo_exp_b.columns)):
                                ws_m.write(next_row, c, dfo_exp_b.columns[c], header_fmt)
                            next_row += len(dfo_exp_b.index) + 4
                            if cpt_m == 'Youd2001':
                                next_row_r = next_row
                            else:
                                next_row_b = next_row

                        # --- Tab 3: Plots (both methods per tag) ---
                        ws_plot.write(plot_row, 0, f'Tag: {tag}', title_fmt)
                        plot_row += 1
                        ws_plot.write(plot_row, 0, f'PGA={pga} g, Mw={mw}, GWL(drill)={bh_gwt_drill} {length_unit}, GWL(design)={bh_gwt_design} {length_unit}', subhead_fmt)
                        plot_row += 1
                        for cpt_m in batch_valid_cpt:
                            dfo_plt, tsm_plt = cpt_batch_results[cpt_m]
                            method_label = 'Robertson (2009)' if cpt_m == 'Youd2001' else 'Boulanger & Idriss (2014)'
                            plot_bytes = plot_cpt_liquefaction_results(
                                dfo_plt,
                                total_settlement_m=tsm_plt,
                                project_name=f"{data.get('project_name', 'Liquefaction Analysis')} - {tag} — {method_label}",
                                unit_system=('imperial' if str(unit_system).lower() == 'imperial' else 'metric')
                            )
                            anchor_cell = f"A{plot_row + 1}"
                            safe_img = ''.join(ch if (ch.isalnum() or ch in ('_', '-')) else '_' for ch in str(tag))[:24] or 'CPT'
                            ws_plot.insert_image(anchor_cell, f'cpt_plot_{safe_img}_{cpt_m}.png', {'image_data': plot_bytes, 'x_scale': 0.85, 'y_scale': 0.85})
                            plot_row += 40

                    if cpt_boreholes_with_data == 0:
                        return jsonify({"status": "error", "message": "No CPT data found in boreholes. Ensure each tag has depth, qc, fs columns."}), 400

                    # Tab 4: Symbol Description
                    _create_symbol_description_sheet(wb, unit_system=unit_system, test_type='CPT')

                    download_name = 'Liquefaction_CPT_Batch_Report.xlsx'

                else:
                    # ----------------------------
                    # Batch SPT export (multi-method)
                    #  user ： Results (I&B 2014)  Results (NCEER 2001)  tab
                    #  Methodology tab  Symbol Description tab
                    # ----------------------------
                    spt_plot_list = []  # (tag, method_code, method_display, plot_bytes_io, gwt_drill, gwt_design)
                    results_by_method = {m: [] for m in valid_methods}  # {method: [(tag, df_out), ...]}

                    for bh_i, bh in enumerate(boreholes, start=1):
                        tag = str((bh or {}).get('name') or (bh or {}).get('id') or f'BH-{bh_i}')
                        bh_gwt_drill = float((bh or {}).get('gwt_drill', gwt_drill))
                        bh_gwt_design = float((bh or {}).get('gwt_design', gwt_design))
                        bh_layers = (bh or {}).get('layers') or []
                        if not bh_layers:
                            continue
                        df_in = pd.DataFrame(bh_layers)

                        pi_col = None
                        for cand in ['pi', 'PI', 'Pi', 'plasticity_index', 'PlasticityIndex']:
                            if cand in df_in.columns:
                                pi_col = cand
                                break

                        if str(unit_system).lower() == 'imperial':
                            FT_TO_M = 0.3048
                            PCF_TO_KN_M3 = 0.157087
                            df_in['depth'] = pd.to_numeric(df_in['depth'], errors='coerce') * FT_TO_M
                            df_in['gamma'] = pd.to_numeric(df_in['gamma'], errors='coerce') * PCF_TO_KN_M3
                            bh_gwt_design_si = float(bh_gwt_design) * FT_TO_M
                        else:
                            df_in['depth'] = pd.to_numeric(df_in['depth'], errors='coerce')
                            df_in['gamma'] = pd.to_numeric(df_in['gamma'], errors='coerce')
                            bh_gwt_design_si = float(bh_gwt_design)

                        df_in['spt_n'] = pd.to_numeric(df_in['spt_n'], errors='coerce')
                        df_in['fc'] = pd.to_numeric(df_in['fc'], errors='coerce')
                        df_in = calculate_stress_profile(df_in, bh_gwt_design_si)

                        if str(unit_system).lower() == 'imperial':
                            try:
                                df_in = convert_to_imperial(df_in, unit_system='imperial')
                            except Exception:
                                pass

                        for mi, method in enumerate(valid_methods):
                            if method == 'NCEER2001':
                                model = NCEER2001(Mw=mw, PGA=pga, CE=ce)
                                method_display = 'NCEER 2001'
                            else:
                                model = IdrissBoulanger2014(Mw=mw, PGA=pga, CE=ce)
                                method_display = 'I&B 2014'

                            results_list = []
                            for _, row in df_in.iterrows():
                                PI_val = float(row.get(pi_col)) if pi_col and row.get(pi_col) is not None else None
                                try:
                                    PI_val = float(PI_val) if PI_val is not None else None
                                except Exception:
                                    PI_val = None
                                res = model.analyze_layer(
                                    depth=float(row['depth']) * 0.3048 if str(unit_system).lower() == 'imperial' else float(row['depth']),
                                    N_measured=float(row['spt_n']),
                                    sigma_v_total=float(row['sigma_v']) * 95.7605 if str(unit_system).lower() == 'imperial' else float(row['sigma_v']),
                                    sigma_v_eff=float(row['sigma_ve']) * 95.7605 if str(unit_system).lower() == 'imperial' else float(row['sigma_ve']),
                                    FC=float(row['fc']),
                                    PI=PI_val
                                )
                                res['depth'] = float(row['depth'])
                                res['spt_n'] = float(row['spt_n'])
                                res['fc'] = float(row['fc'])
                                res['gamma'] = float(row['gamma'])
                                res['sigma_v'] = float(row['sigma_v'])
                                res['sigma_ve'] = float(row['sigma_ve'])
                                res['soil_class'] = row.get('soil_class', '')
                                if PI_val is not None:
                                    res['PI'] = PI_val
                                results_list.append(res)

                            df_out = pd.DataFrame(results_list)
                            if str(unit_system).lower() == 'imperial' and not df_out.empty:
                                try:
                                    df_out = convert_to_imperial(df_out, unit_system='imperial')
                                except Exception:
                                    pass
                            results_by_method[method].append((tag, df_out))

                            # Add plot for every selected method (not only the first one)
                            try:
                                plot_io = plot_liquefaction_analysis(
                                    df_out, project_name=tag, method=method_display, unit_system=unit_system
                                )
                                plot_io.seek(0)
                                spt_plot_list.append(
                                    (
                                        tag,
                                        method,
                                        method_display,
                                        io.BytesIO(plot_io.getvalue()),
                                        bh_gwt_drill,
                                        bh_gwt_design,
                                    )
                                )
                            except Exception:
                                pass

                    #  Results tab
                    method_sheet_names = {'IB2014': 'Results (I&B 2014)', 'NCEER2001': 'Results (NCEER 2001)'}
                    for method in valid_methods:
                        sheet_name = method_sheet_names.get(method, f'Results ({method})')
                        ws = wb.add_worksheet(sheet_name)
                        writer.sheets[sheet_name] = ws
                        ws.write(0, 0, f'Liquefaction Results — {method_sheet_names.get(method, method)}', title_fmt)
                        ws.write(1, 0, f'PGA={pga} g, Mw={mw}, Unit System={unit_system}', wb.add_format({'italic': True}))
                        start_row = 3
                        for tag, df_out in results_by_method[method]:
                            ws.write(start_row, 0, f'Tag: {tag}', wb.add_format({'bold': True}))
                            start_row += 1
                            df_out.to_excel(writer, sheet_name=sheet_name, startrow=start_row, startcol=0, index=False)
                            for c in range(len(df_out.columns)):
                                ws.write(start_row, c, df_out.columns[c], header_fmt)
                            start_row += len(df_out.index) + 3

                    # SPT Plots sheet
                    ws_spt_plot = wb.add_worksheet('SPT Plots')
                    writer.sheets['SPT Plots'] = ws_spt_plot
                    subhead_fmt = wb.add_format({'bold': True})
                    ws_spt_plot.write(0, 0, 'SPT Liquefaction Analysis Plots (all tags)', title_fmt)
                    length_unit = 'ft' if str(unit_system).lower() == 'imperial' else 'm'
                    plot_row = 2
                    for item in spt_plot_list:
                        tag = item[0]
                        method_code = item[1] if len(item) > 1 else ''
                        method_display = item[2] if len(item) > 2 else method_code
                        plot_io = item[3] if len(item) > 3 else None
                        gd = item[4] if len(item) > 4 else ''
                        ge = item[5] if len(item) > 5 else ''
                        try:
                            if plot_io is None:
                                plot_row += 1
                                continue
                            plot_io.seek(0)
                            ws_spt_plot.write(plot_row, 0, f'Tag: {tag}', wb.add_format({'bold': True}))
                            plot_row += 1
                            ws_spt_plot.write(plot_row, 0, f'Method: {method_display}', subhead_fmt)
                            plot_row += 1
                            ws_spt_plot.write(plot_row, 0, f'PGA={pga} g, Mw={mw}, GWL(drill)={gd} {length_unit}, GWL(design)={ge} {length_unit}', subhead_fmt)
                            plot_row += 1
                            anchor = f'A{plot_row + 1}'
                            safe_tag = ''.join(ch if (ch.isalnum() or ch in ('_', '-')) else '_' for ch in str(tag))[:24] or 'BH'
                            safe_method = ''.join(ch if (ch.isalnum() or ch in ('_', '-')) else '_' for ch in str(method_code))[:16] or 'method'
                            ws_spt_plot.insert_image(anchor, f'spt_plot_{safe_tag}_{safe_method}.png', {'image_data': plot_io, 'x_scale': 0.85, 'y_scale': 0.85})
                            plot_row += 42
                        except Exception:
                            plot_row += 2
                    # SPT ： methodology tab
                    for method in valid_methods:
                        _create_spt_methodology_sheet(wb, method, unit_system=unit_system)
                    # Symbol Description sheet
                    _create_symbol_description_sheet(wb, unit_system=unit_system)

                    download_name = 'Liquefaction_SPT_Batch_Report.xlsx'

            # ExcelWriter flushes on exit; must read buffer AFTER with block
            output.seek(0)
            excel_bytes = output.getvalue()
            if len(excel_bytes) < 500:
                return jsonify({"status": "error", "message": "Excel generation failed: file is empty or invalid"}), 500
            return send_file(
                io.BytesIO(excel_bytes),
                mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                as_attachment=True,
                download_name=download_name
            )

        # =========================================================
        # CPT （ SPT-only ， SPT  gamma/spt_n/fc）
        # =========================================================
        if test_type == 'CPT':
            cpt_raw = data.get('cpt_data') or layers or []
            cpt_intermediate = data.get('cpt_intermediate') or {}
            cpt_meta = data.get('cpt_intermediate_meta') or {}
            cpt_params = data.get('cpt_params') or {}
            usgs_seismic = data.get('usgs_seismic') or {}

            #  cpt_intermediate，，
            def _compute_cpt_intermediate_backend(cpt_rows, gwt_val, unit_sys, net_area_ratio):
                TSF_TO_KPA = 95.7605
                FT_TO_M = 0.3048
                gamma_kN_m3 = 18.0
                gamma_w = 9.81
                an = float(net_area_ratio) if net_area_ratio is not None else 0.8

                def to_float(x):
                    try:
                        return float(x)
                    except Exception:
                        return None

                gwt_m = float(gwt_val) * FT_TO_M if str(unit_sys or '').lower() == 'imperial' else float(gwt_val)

                rows_si = []
                for r in cpt_rows or []:
                    d = to_float(r.get('depth'))
                    qc = to_float(r.get('qc'))
                    fs = to_float(r.get('fs'))
                    # CPT input: u2 is water head (length). Convert to pressure (kPa) for qt correction.
                    u2_head = to_float(r.get('u2')) if r.get('u2') is not None else None
                    if d is None or qc is None or fs is None:
                        continue
                    if str(unit_sys or '').lower() == 'imperial':
                        u2_head_m = (u2_head * FT_TO_M) if u2_head is not None else None
                        rows_si.append({
                            "depth_m": d * FT_TO_M,
                            "qc_kpa": qc * TSF_TO_KPA,
                            "fs_kpa": fs * TSF_TO_KPA,
                            "u2_head_m": u2_head_m,
                            "u2_kpa": (u2_head_m * gamma_w) if u2_head_m is not None else None
                        })
                    else:
                        u2_head_m = u2_head
                        rows_si.append({
                            "depth_m": d,
                            "qc_kpa": qc,
                            "fs_kpa": fs,
                            "u2_head_m": u2_head_m,
                            "u2_kpa": (u2_head_m * gamma_w) if u2_head_m is not None else None
                        })
                rows_si.sort(key=lambda x: x["depth_m"])

                sigma_v0 = 0.0
                prev_depth = 0.0
                out = []
                for r in rows_si:
                    depth = r["depth_m"]
                    thickness = max(0.0, depth - prev_depth)
                    sigma_v0 += thickness * gamma_kN_m3  # kPa
                    u = (depth - gwt_m) * gamma_w if depth > gwt_m else 0.0
                    sigma_v0_eff = max(0.0001, sigma_v0 - u)

                    qt_kpa = r["qc_kpa"] if r["u2_kpa"] is None else (r["qc_kpa"] + (1.0 - an) * r["u2_kpa"])
                    denom = max(0.0001, qt_kpa - sigma_v0)
                    Qt = denom / sigma_v0_eff
                    Fr = (r["fs_kpa"] / denom) * 100.0
                    Ic = None
                    if Qt > 0 and Fr > 0:
                        Ic = float(np.sqrt((3.47 - np.log10(Qt))**2 + (np.log10(Fr) + 1.22)**2))

                    if str(unit_sys or '').lower() == 'imperial':
                        out.append({
                            "depth": depth / FT_TO_M,
                            "qc": r["qc_kpa"] / TSF_TO_KPA,
                            "fs": r["fs_kpa"] / TSF_TO_KPA,
                            "u2": (r["u2_head_m"] / FT_TO_M) if r.get("u2_head_m") is not None else None,
                            "qt": qt_kpa / TSF_TO_KPA,
                            "sigma_v0": sigma_v0 / TSF_TO_KPA,
                            "sigma_v0_eff": sigma_v0_eff / TSF_TO_KPA,
                            "Qt": Qt,
                            "Fr": Fr,
                            "Ic": Ic
                        })
                    else:
                        out.append({
                            "depth": depth,
                            "qc": r["qc_kpa"],
                            "fs": r["fs_kpa"],
                            "u2": r.get("u2_head_m"),
                            "qt": qt_kpa,
                            "sigma_v0": sigma_v0,
                            "sigma_v0_eff": sigma_v0_eff,
                            "Qt": Qt,
                            "Fr": Fr,
                            "Ic": Ic
                        })
                    prev_depth = depth

                return {
                    "unitSystem": unit_sys,
                    "assumptions": {
                        "gamma_assumed_kN_m3": gamma_kN_m3,
                        "gamma_w_kN_m3": gamma_w,
                        "net_area_ratio": an
                    },
                    "rows": out
                }

            if not isinstance(cpt_intermediate, dict) or not cpt_intermediate.get('rows'):
                net_area_ratio = cpt_params.get('net_area_ratio', 0.8)
                # CPT Details uses drilling GWL for normalization/effective stress in the intermediate table
                cpt_intermediate = _compute_cpt_intermediate_backend(cpt_raw, gwt_drill, unit_system, net_area_ratio)

            output = io.BytesIO()
            with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
                wb = writer.book
                # Target layout (3 tabs):
                # 1) CPT Raw Data
                # 2) CPT Plots (all plots live here; label clearly)
                # 3) CPT Computed (full intermediate + results + symbol legend at bottom)

                length_unit = 'ft' if str(unit_system).lower() == 'imperial' else 'm'
                stress_unit = 'tsf' if str(unit_system).lower() == 'imperial' else 'kPa'
                unit_weight_unit = 'pcf' if str(unit_system).lower() == 'imperial' else 'kN/m³'

                title_fmt = wb.add_format({'bold': True, 'font_size': 14})
                header_fmt = wb.add_format({'bold': True, 'border': 1, 'border_color': '#D9D9D9'})
                subhead_fmt = wb.add_format({'bold': True})
                italic_fmt = wb.add_format({'italic': True})

                # --- CPT BI2014: full triggering + settlement table (computed in backend) ---
                # Compute in SI: (m, kPa). Our CPT routine expects gwl in ft, so we convert.
                df_cpt = pd.DataFrame(cpt_raw or [])
                if not df_cpt.empty and all(c in df_cpt.columns for c in ['depth', 'qc', 'fs']):
                    if 'u2' not in df_cpt.columns:
                        df_cpt['u2'] = 0.0

                    # Convert depth to meters for computation
                    if str(unit_system).lower() == 'imperial':
                        df_cpt['depth'] = pd.to_numeric(df_cpt['depth'], errors='coerce') * 0.3048
                        gwl_drill_ft = gwt_drill
                        gwl_design_ft = gwt_design
                        # qc/fs are in tsf in the UI -> convert to kPa for BI2014
                        TSF_TO_KPA = 95.7605
                        df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * TSF_TO_KPA
                        df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * TSF_TO_KPA
                    else:
                        df_cpt['depth'] = pd.to_numeric(df_cpt['depth'], errors='coerce')
                        gwl_drill_ft = gwt_drill / 0.3048
                        gwl_design_ft = gwt_design / 0.3048

                    # CPT input: u2 is water head (length). Convert to pressure (kPa) for BI2014.
                    try:
                        df_cpt['u2'] = pd.to_numeric(df_cpt['u2'], errors='coerce').fillna(0.0)
                        if str(unit_system).lower() == 'imperial':
                            u2_head_m = df_cpt['u2'] * 0.3048  # ft -> m
                        else:
                            u2_head_m = df_cpt['u2']  # m
                        df_cpt['u2'] = u2_head_m * 9.81  # kPa
                    except Exception:
                        df_cpt['u2'] = 0.0

                    # Heuristic: MPa -> kPa (metric only; avoid mis-detecting tsf as MPa)
                    if str(unit_system).lower() != 'imperial':
                        qc_med = float(pd.to_numeric(df_cpt['qc'], errors='coerce').median())
                        if qc_med > 0 and qc_med < 200:
                            df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * 1000.0
                            df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * 1000.0
                    else:
                        df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce')
                        df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce')
                        df_cpt['u2'] = pd.to_numeric(df_cpt['u2'], errors='coerce').fillna(0.0)

                    an = cpt_params.get('net_area_ratio', 0.8)
                    try:
                        an = float(an)
                    except Exception:
                        an = 0.8

                    cpt_methods = data.get('cpt_methods') or data.get('methods')
                    if not isinstance(cpt_methods, list):
                        cpt_methods = [cpt_methods] if cpt_methods in ['Youd2001', 'IB2014'] else ['Youd2001', 'IB2014']
                    valid_cpt_methods = [m for m in cpt_methods if m in ['Youd2001', 'IB2014']]
                    if not valid_cpt_methods:
                        valid_cpt_methods = ['Youd2001', 'IB2014']

                    cpt_results = {}
                    for cpt_m in valid_cpt_methods:
                        if cpt_m == 'Youd2001':
                            df_out, total_settlement_m = calculate_cpt_liquefaction_youd2001(
                                df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                                mw=mw, pga=pga, gwl_drill_ft=gwl_drill_ft, gwl_design_ft=gwl_design_ft, an=an
                            )
                        else:
                            df_out, total_settlement_m = calculate_cpt_liquefaction_bi2014(
                                df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                                mw=mw, pga=pga, gwl_drill_ft=gwl_drill_ft, gwl_design_ft=gwl_design_ft, an=an
                            )
                        cpt_results[cpt_m] = (df_out, total_settlement_m)

                    # --- Tab 1 & 2: Per-method sheets (methodology at top + full computed data) ---
                    for idx, cpt_m in enumerate(valid_cpt_methods):
                        dfo, tsm = cpt_results[cpt_m]
                        method_label = 'Robertson (2009)' if cpt_m == 'Youd2001' else 'Boulanger & Idriss (2014)'
                        sheet_name = 'Results (Robertson 2009)' if cpt_m == 'Youd2001' else 'Results (B&I 2014)'
                        ws_m = wb.add_worksheet(sheet_name)
                        writer.sheets[sheet_name] = ws_m
                        next_row = _write_cpt_methodology_to_worksheet(ws_m, wb, cpt_m, start_row=0)
                        next_row += 1
                        ws_m.write(next_row, 0, f'CPT Computed Data ({method_label})', subhead_fmt)
                        next_row += 1
                        dfo_exp = dfo.copy()
                        if str(unit_system).lower() == 'imperial':
                            KPA_PER_TSF, FT_PER_M, PCF_PER_KN_M3 = 95.7605, 3.28084, 6.36588
                            def _col_mul(col, factor):
                                if col in dfo_exp.columns:
                                    dfo_exp[col] = pd.to_numeric(dfo_exp[col], errors='coerce') * factor
                            _col_mul('depth', FT_PER_M)
                            for c in ['qc', 'fs', 'u2', 'qt', 'sigma_v', 'sigma_ve', 'sigma_ve_design']:
                                _col_mul(c, 1.0 / KPA_PER_TSF)
                            _col_mul('gamma', PCF_PER_KN_M3)
                            _col_mul('Settlement_m', FT_PER_M)
                            rename_map = {
                                'depth': f'depth_{length_unit}', 'qc': f'qc_{stress_unit}', 'fs': f'fs_{stress_unit}',
                                'u2': f'u2_{stress_unit}', 'qt': f'qt_{stress_unit}',
                                'sigma_v': f'sigma_v0_{stress_unit}', 'sigma_ve': f"sigma_v0_eff_{stress_unit}",
                                'sigma_ve_design': f"sigma_v0_eff_design_{stress_unit}",
                                'gamma': f'gamma_{unit_weight_unit}', 'Settlement_m': 'Settlement_ft',
                            }
                            dfo_exp = dfo_exp.rename(columns={k: v for k, v in rename_map.items() if k in dfo_exp.columns})
                        else:
                            dfo_exp = dfo_exp.rename(columns={
                                'sigma_v': 'sigma_v0_kPa', 'sigma_ve': "sigma_v0_eff_kPa",
                                'sigma_ve_design': "sigma_v0_eff_design_kPa", 'Settlement_m': 'Settlement_m',
                            })
                        dfo_exp.to_excel(writer, sheet_name=sheet_name, startrow=next_row, startcol=0, index=False)
                        for c in range(len(dfo_exp.columns)):
                            ws_m.write(next_row, c, dfo_exp.columns[c], header_fmt)

                    # --- Tab 3: CPT Plots (both methods) ---
                    ws_plot = wb.add_worksheet('CPT Plots')
                    writer.sheets['CPT Plots'] = ws_plot
                    ws_plot.write(0, 0, 'CPT Liquefaction Plots (Both Methods)', title_fmt)
                    plot_row = 2
                    for cpt_m in valid_cpt_methods:
                        dfo_plt, tsm_plt = cpt_results[cpt_m]
                        method_label = 'Robertson (2009)' if cpt_m == 'Youd2001' else 'Boulanger & Idriss (2014)'
                        plot_bytes = plot_cpt_liquefaction_results(
                            dfo_plt,
                            total_settlement_m=tsm_plt,
                            project_name=f"{data.get('project_name', 'Liquefaction Analysis')} — {method_label}",
                            unit_system=('imperial' if str(unit_system).lower() == 'imperial' else 'metric')
                        )
                        ws_plot.write(plot_row, 0, f'{method_label}', subhead_fmt)
                        plot_row += 1
                        anchor = f'A{plot_row + 1}'
                        ws_plot.insert_image(anchor, f'cpt_plot_{cpt_m}.png', {'image_data': plot_bytes, 'x_scale': 0.85, 'y_scale': 0.85})
                        plot_row += 38
                    info_row = plot_row + 2
                    ws_plot.write(info_row, 0, 'Project Information', title_fmt)
                    info_row += 2

                    # Used values in analysis
                    project_name = data.get('project_name', 'Liquefaction Analysis')
                    ws_plot.write(info_row, 0, 'Project', header_fmt); ws_plot.write(info_row, 1, project_name); info_row += 1
                    ws_plot.write(info_row, 0, 'Test Type', header_fmt); ws_plot.write(info_row, 1, 'CPT'); info_row += 1
                    method_str = '; '.join(['Robertson (2009)' if m == 'Youd2001' else 'Boulanger & Idriss (2014)' for m in valid_cpt_methods])
                    ws_plot.write(info_row, 0, 'Analysis Method', header_fmt); ws_plot.write(info_row, 1, method_str); info_row += 1
                    ws_plot.write(info_row, 0, 'Unit System', header_fmt); ws_plot.write(info_row, 1, f"{unit_system} (depth={length_unit}, stress={stress_unit})"); info_row += 1
                    ws_plot.write(info_row, 0, 'PGA used (g)', header_fmt); ws_plot.write(info_row, 1, pga); info_row += 1
                    ws_plot.write(info_row, 0, 'Mw used', header_fmt); ws_plot.write(info_row, 1, mw); info_row += 1
                    ws_plot.write(info_row, 0, f'Drilling GWL ({length_unit})', header_fmt); ws_plot.write(info_row, 1, gwt_drill); info_row += 1
                    ws_plot.write(info_row, 0, f'Design GWL ({length_unit})', header_fmt); ws_plot.write(info_row, 1, gwt_design); info_row += 2

                    # CPT device/model parameters
                    ws_plot.write(info_row, 0, 'CPT / Model Parameters', title_fmt); info_row += 2
                    ws_plot.write(info_row, 0, 'Net Area Ratio (a_n)', header_fmt); ws_plot.write(info_row, 1, cpt_params.get('net_area_ratio', 0.8)); info_row += 1
                    ws_plot.write(info_row, 0, 'Gamma Method', header_fmt); ws_plot.write(info_row, 1, cpt_params.get('gamma_method', 'robertson_cabal_2010')); info_row += 2

                    # Seismic background (USGS, if available)
                    ws_plot.write(info_row, 0, 'Seismic Background (if fetched from USGS)', title_fmt); info_row += 2
                    try:
                        lat_val = data.get('latitude', None)
                        lon_val = data.get('longitude', None)
                        ws_plot.write(info_row, 0, 'Latitude', header_fmt); ws_plot.write(info_row, 1, lat_val); info_row += 1
                        ws_plot.write(info_row, 0, 'Longitude', header_fmt); ws_plot.write(info_row, 1, lon_val); info_row += 1
                        ws_plot.write(info_row, 0, 'Design/Code Model', header_fmt); ws_plot.write(info_row, 1, data.get('design_code', '')); info_row += 1
                        if isinstance(usgs_seismic, dict) and usgs_seismic:
                            ws_plot.write(info_row, 0, 'USGS Deagg Model', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('deaggModel', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Vs30 (m/s)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('deaggVs30', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Site Class (auto)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('siteClass', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'PGA_M (USGS, g)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('pgaM', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Mean Mw (475yr)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('meanMw475', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Mean r (475yr, km)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('meanDistanceKm475', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Mean ε0 (475yr)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('meanEpsilon475', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Mean Mw (2475yr)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('meanMw2475', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Mean r (2475yr, km)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('meanDistanceKm2475', '')); info_row += 1
                            ws_plot.write(info_row, 0, 'Mean ε0 (2475yr)', header_fmt); ws_plot.write(info_row, 1, usgs_seismic.get('meanEpsilon2475', '')); info_row += 1
                    except Exception:
                        # If any reporting fails, keep export alive.
                        pass

                    # Settlement note (per method)
                    info_row += 2
                    for cpt_m in valid_cpt_methods:
                        _, tsm = cpt_results[cpt_m]
                        ml = 'Robertson (2009)' if cpt_m == 'Youd2001' else 'Boulanger & Idriss (2014)'
                        if str(unit_system).lower() == 'imperial':
                            ws_plot.write(info_row, 0, f"{ml}: Total settlement = {tsm * 39.3701:.2f} in")
                        else:
                            ws_plot.write(info_row, 0, f"{ml}: Total settlement = {tsm * 100.0:.2f} cm")
                        info_row += 1

                    # --- Tab 4: Symbol Description ---
                    _create_symbol_description_sheet(wb, unit_system=unit_system, test_type='CPT')

            output.seek(0)
            excel_bytes = output.getvalue()
            if len(excel_bytes) < 500:
                return jsonify({"status": "error", "message": "Excel generation failed: file is empty or invalid"}), 500
            return send_file(
                io.BytesIO(excel_bytes),
                mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                as_attachment=True,
                download_name='Liquefaction_CPT_Report.xlsx'
            )
        
        if not layers:
            return jsonify({"status": "error", "message": "No layer data (layers required)"}), 400

        # 2. （； SI：depth=m, gamma=kN/m³, stress=kPa）
        df = pd.DataFrame(layers)
        required_cols = ['depth', 'gamma', 'spt_n', 'fc']
        missing = [c for c in required_cols if c not in df.columns]
        if missing:
            return jsonify({"status": "error", "message": f"Layer data missing required columns: {', '.join(missing)}"}), 400

        # Optional clay-like gatekeeper input
        pi_col = None
        for cand in ['pi', 'PI', 'Pi', 'plasticity_index', 'PlasticityIndex']:
            if cand in df.columns:
                pi_col = cand
                break

        # Convert to SI for calculations if user units are imperial
        if str(unit_system).lower() == 'imperial':
            FT_TO_M = 0.3048
            PCF_TO_KN_M3 = 0.157087  # 1 pcf = 0.157087 kN/m³
            df['depth'] = pd.to_numeric(df['depth'], errors='coerce') * FT_TO_M
            df['gamma'] = pd.to_numeric(df['gamma'], errors='coerce') * PCF_TO_KN_M3
            gwt_design_si = float(gwt_design) * FT_TO_M
            gwt_drill_si = float(gwt_drill) * FT_TO_M
        else:
            df['depth'] = pd.to_numeric(df['depth'], errors='coerce')
            df['gamma'] = pd.to_numeric(df['gamma'], errors='coerce')
            gwt_design_si = float(gwt_design)
            gwt_drill_si = float(gwt_drill)

        df['spt_n'] = pd.to_numeric(df['spt_n'], errors='coerce')
        df['fc'] = pd.to_numeric(df['fc'], errors='coerce')

        # Use design groundwater level for earthquake-effective stress (in meters)
        df = calculate_stress_profile(df, gwt_design_si)
        
        # 3. 
        method_results = {}
        for method in valid_methods:
            # 
            if method == 'NCEER2001':
                model = NCEER2001(Mw=mw, PGA=pga, CE=ce)
                method_display = 'NCEER 2001'
            else:
                model = IdrissBoulanger2014(Mw=mw, PGA=pga, CE=ce)
                method_display = 'I&B 2014'
            
            # 
            results_list = []
            for i, row in df.iterrows():
                PI_val = None
                if pi_col is not None:
                    try:
                        PI_val = float(row.get(pi_col))
                    except Exception:
                        PI_val = None
                res = model.analyze_layer(
                    depth=float(row['depth']),
                    N_measured=float(row['spt_n']),
                    sigma_v_total=float(row['sigma_v']),
                    sigma_v_eff=float(row['sigma_ve']),
                    FC=float(row['fc']),
                    PI=PI_val
                )
                # 
                if method == 'NCEER2001':
                    res['rd'] = model.calc_rd(float(row['depth']))
                else:
                    res['rd'] = model.calculate_rd(float(row['depth']))
                
                # 
                res['depth'] = float(row['depth'])
                res['spt_n'] = float(row['spt_n'])
                res['fc'] = float(row['fc'])
                res['gamma'] = float(row['gamma'])
                res['sigma_v'] = float(row['sigma_v'])
                res['sigma_ve'] = float(row['sigma_ve'])
                res['soil_class'] = row.get('soil_class', '')
                if PI_val is not None:
                    res['PI'] = PI_val
                
                results_list.append(res)
            
            result_df = pd.DataFrame(results_list)

            # Convert back to display units if imperial (plots + Excel should match user's unit_system)
            if str(unit_system).lower() == 'imperial' and not result_df.empty:
                # Convert depth/sigma/gamma back; dimensionless ratios remain unchanged
                try:
                    result_df = convert_to_imperial(result_df, unit_system='imperial')
                except Exception:
                    pass
                # Also convert the stored input columns that we added for output
                try:
                    if 'depth' in result_df.columns:
                        result_df['depth'] = pd.to_numeric(result_df['depth'], errors='coerce')  # convert_to_imperial already did m->ft if depth present
                except Exception:
                    pass
            
            # （）
            plot_bytes_io = plot_liquefaction_analysis(result_df, project_name=data.get('project_name', 'Liquefaction Analysis'), method=method_display, unit_system=unit_system)
            plot_bytes_io.seek(0)
            
            # metadata
            metadata = {
                'Project': data.get('project_name', 'Liquefaction Analysis'),
                'Lat': data.get('latitude', 'N/A'),
                'Lon': data.get('longitude', 'N/A'),
                'Code': data.get('design_code', 'ASCE 7-22'),
                'Mw': mw,
                'PGA': pga,
                # GWT is reported in the user's unit system (input values)
                'GWT': gwt_design,
                'GWT_Drill': gwt_drill,
                'GWT_Design': gwt_design,
                'Method': method_display,
                'UnitSystem': unit_system  # 
            }
            
            method_results[method] = {
                'df': result_df,
                'metadata': metadata,
                'plot': plot_bytes_io
            }

        # 4.  Excel（）
        excel_file = generate_multi_method_excel(method_results, unit_system=unit_system)
        
        # 5. （ getvalue() ，）
        excel_file.seek(0)
        excel_bytes = excel_file.getvalue()
        if len(excel_bytes) < 500:
            return jsonify({"status": "error", "message": "Excel generation failed: file is empty or invalid"}), 500
        return send_file(
            io.BytesIO(excel_bytes),
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name='Liquefaction_Analysis_Report.xlsx'
        )
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Excel export error: {e}")
        return jsonify({"status": "error", "message": f"Excel : {str(e)}"}), 500
