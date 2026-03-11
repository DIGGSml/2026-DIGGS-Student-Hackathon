import base64
import io
import numpy as np
import pandas as pd
from flask import Blueprint, request, jsonify, send_file

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


liquefaction_bp = Blueprint('liquefaction', __name__)
liquefaction_plot_bp = Blueprint('liquefaction_plot', __name__, url_prefix='/api')


def _sanitize_for_json(obj):
    """Replace inf, -inf, nan with JSON-safe values (None → null)."""
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_for_json(v) for v in obj]
    if isinstance(obj, (int, str, bool)) or obj is None:
        return obj
    if isinstance(obj, (float, np.floating)):
        if np.isnan(obj) or np.isposinf(obj) or np.isneginf(obj):
            return None
        return float(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


@liquefaction_bp.route('/calculate', methods=['POST'])
def calculate():
    """
    Route handler for liquefaction triggering analysis.
    Expects JSON:
    {
      "pga": 0.5,
      "mw": 7.8,
      "gwt": 2.0,
      "ce": 0.60,
      "layers": [{"depth":1.5,"spt_n":5,"fc":10,"gamma":18.0}, ...],
      "methods": ["IB2014","NCEER2001"]
    }
    """
    try:
        data = request.json or {}

        # 1. Global parameters
        test_type = (data.get('test_type') or 'SPT').upper()
        pga = float(data.get('pga', 0.4))
        mw = float(data.get('mw', 7.5))
        # Groundwater levels:
        # - gwt_drill: drilling/measurement condition (used for CPT normalization)
        # - gwt_design: design/earthquake condition (used for CSR / effective stress during shaking)
        gwt_drill = float(data.get('gwt_drill', data.get('gwt', 1.5)))
        gwt_design = float(data.get('gwt_design', data.get('gwt', 1.5)))
        ce = float(data.get('ce', 0.60))  # Energy Ratio (default 0.60 = 60%)
        layers = data.get('layers', [])
        unit_system = (data.get('unit_system') or 'imperial').lower()

        # Multi-tag / multi-borehole mode:
        # Accept a list of boreholes/soundings so the UI can run batch analysis across all tags.
        # Expected:
        #   {"boreholes":[{id,name,gwt_drill,gwt_design,layers:[...]}, ...]} (SPT)
        #   {"boreholes":[{id,name,gwt_drill,gwt_design,cpt_data:[...],cpt_params:{...}}, ...]} (CPT)
        boreholes = data.get('boreholes')
        if isinstance(boreholes, list) and len(boreholes) > 0:
            # ---------------------------------------------------------
            # CPT batch
            # ---------------------------------------------------------
            if test_type == 'CPT':
                out_bhs = []
                for bh in boreholes:
                    try:
                        bh_id = str(bh.get('id') or bh.get('name') or 'CPT')
                        bh_name = str(bh.get('name') or bh_id)
                        bh_gwt_drill = float(bh.get('gwt_drill', data.get('gwt_drill', data.get('gwt', 1.5))))
                        bh_gwt_design = float(bh.get('gwt_design', data.get('gwt_design', data.get('gwt', 1.5))))
                        cpt_params = (bh.get('cpt_params') or {}) if isinstance(bh, dict) else {}

                        an = cpt_params.get('net_area_ratio')
                        if an is None:
                            an = cpt_params.get('netAreaRatio')
                        try:
                            an = float(an) if an is not None else 0.8
                        except Exception:
                            an = 0.8

                        # Build DataFrame (depth, qc, fs, u2) from per-borehole `cpt_data`
                        cpt_rows = (bh.get('cpt_data') or bh.get('layers') or []) if isinstance(bh, dict) else []
                        if not cpt_rows:
                            continue

                        df_cpt = pd.DataFrame(cpt_rows)
                        for col in ['depth', 'qc', 'fs']:
                            if col not in df_cpt.columns:
                                raise ValueError(f"CPT data missing required column: {col}")
                        conversions = []
                        if 'u2' not in df_cpt.columns:
                            df_cpt['u2'] = 0.0
                        else:
                            try:
                                df_cpt['u2'] = pd.to_numeric(df_cpt['u2'], errors='coerce').fillna(0.0)
                                if unit_system == 'imperial':
                                    u2_head_m = df_cpt['u2'] * 0.3048
                                else:
                                    u2_head_m = df_cpt['u2']
                                df_cpt['u2'] = u2_head_m * 9.81
                                conversions.append('u2_head_to_kpa')
                            except Exception:
                                df_cpt['u2'] = 0.0

                        if unit_system == 'imperial':
                            df_cpt['depth'] = pd.to_numeric(df_cpt['depth'], errors='coerce') * 0.3048
                            gwl_drill_ft = bh_gwt_drill
                            gwl_design_ft = bh_gwt_design
                            conversions.append('depth_ft_to_m')
                            TSF_TO_KPA = 95.7605
                            df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * TSF_TO_KPA
                            df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * TSF_TO_KPA
                            conversions.append('qc_fs_tsf_to_kpa')
                        else:
                            gwl_drill_ft = bh_gwt_drill / 0.3048
                            gwl_design_ft = bh_gwt_design / 0.3048

                        if unit_system != 'imperial':
                            try:
                                qc_med = float(pd.to_numeric(df_cpt['qc'], errors='coerce').median())
                                if qc_med > 0 and qc_med < 200:
                                    df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * 1000.0
                                    df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * 1000.0
                                    conversions.append('mpa_to_kpa')
                            except Exception:
                                pass

                        df_out, total_settlement_m = calculate_cpt_liquefaction_bi2014(
                            df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                            mw=mw,
                            pga=pga,
                            gwl_drill_ft=gwl_drill_ft,
                            gwl_design_ft=gwl_design_ft,
                            an=an
                        )

                        # Compute min FS for quick summary: use Factor of Safety column 'FS' only (not 'fs' = sleeve friction)
                        try:
                            if 'FS' in df_out.columns:
                                fs_vals = pd.to_numeric(df_out['FS'], errors='coerce').dropna()
                                min_fs = float(fs_vals.min()) if len(fs_vals) else None
                            else:
                                min_fs = None
                        except Exception:
                            min_fs = None

                        out_bhs.append({
                            "id": bh_id,
                            "name": bh_name,
                            "gwt_drill": bh_gwt_drill,
                            "gwt_design": bh_gwt_design,
                            "cpt_params": {"net_area_ratio": an, **({} if not isinstance(cpt_params, dict) else cpt_params)},
                            "metadata": {
                                "method": "Boulanger & Idriss (2014) - CPT",
                                "method_short": "B&I 2014 (CPT)",
                                "pga": pga,
                                "mw": mw,
                                "gwt_drill": bh_gwt_drill,
                                "gwt_design": bh_gwt_design,
                                "net_area_ratio": an,
                                "unit_system": unit_system,
                                "conversions": conversions,
                                "total_settlement_m": total_settlement_m,
                            },
                            "min_fs": min_fs,
                            "results": _sanitize_for_json(df_out.to_dict(orient='records'))
                        })
                    except Exception as e:
                        # Skip a broken borehole but keep batch alive
                        out_bhs.append({
                            "id": str(bh.get('id') or bh.get('name') or 'CPT'),
                            "name": str(bh.get('name') or bh.get('id') or 'CPT'),
                            "error": str(e)
                        })

                if not out_bhs:
                    return jsonify({"status": "error", "message": "No CPT data"}), 400

                return jsonify(_sanitize_for_json({
                    "status": "success",
                    "metadata": {
                        "test_type": "CPT",
                        "method": "Boulanger & Idriss (2014) - CPT",
                        "method_short": "B&I 2014 (CPT)",
                        "pga": pga,
                        "mw": mw,
                        "unit_system": unit_system,
                    },
                    "results": {
                        "boreholes": out_bhs
                    }
                }))

            # ---------------------------------------------------------
            # SPT batch (supports multi-method)
            # ---------------------------------------------------------
            methods = data.get('methods') or []
            if not methods:
                method = data.get('method', 'IB2014')
                if isinstance(method, list):
                    methods = method
                else:
                    methods = [method] if method in ['IB2014', 'NCEER2001'] else ['IB2014', 'NCEER2001']

            valid_methods = [m for m in methods if m in ['IB2014', 'NCEER2001']]
            if not valid_methods:
                valid_methods = ['IB2014', 'NCEER2001']

            def _stress_profile_for_layers(df_layers: pd.DataFrame, gwt_design_val: float, unit_sys='imperial'):
                """Expects depth (m) and gamma (kN/m³). Converts from imperial (ft, pcf) if needed."""
                FT_TO_M = 0.3048
                PCF_TO_KN_M3 = 0.157087
                df = df_layers.copy()
                if unit_sys == 'imperial':
                    df['depth'] = pd.to_numeric(df['depth'], errors='coerce') * FT_TO_M
                    df['gamma'] = pd.to_numeric(df['gamma'], errors='coerce') * PCF_TO_KN_M3
                    gwt_design_val = gwt_design_val * FT_TO_M
                sigma_v_list = []
                sigma_ve_list = []
                current_sigma_v = 0.0
                prev_depth = 0.0
                unit_water = 9.81
                for _, row in df.iterrows():
                    depth = float(row.get('depth', 0.0))
                    gamma = float(row.get('gamma', 18.0))
                    if np.isnan(depth) or np.isinf(depth) or depth < 0:
                        continue
                    if np.isnan(gamma) or np.isinf(gamma) or gamma <= 0:
                        gamma = 18.0
                    if depth <= prev_depth:
                        depth = prev_depth + 0.5
                    thickness = depth - prev_depth
                    if thickness <= 0:
                        continue
                    current_sigma_v += thickness * gamma
                    u = (depth - gwt_design_val) * unit_water if depth > gwt_design_val else 0.0
                    sigma_ve = current_sigma_v - u
                    if np.isnan(current_sigma_v) or np.isinf(current_sigma_v):
                        current_sigma_v = 0.0
                    if np.isnan(sigma_ve) or np.isinf(sigma_ve):
                        sigma_ve = current_sigma_v
                    sigma_v_list.append(current_sigma_v)
                    sigma_ve_list.append(sigma_ve)
                    prev_depth = depth
                return sigma_v_list, sigma_ve_list

            out_bhs = []
            method_details_global = {}
            for method in valid_methods:
                if method == 'NCEER2001':
                    method_details_global[method] = {
                        "method": "NCEER (Youd et al., 2001)",
                        "method_short": "NCEER 2001",
                        "pga": pga,
                        "mw": mw,
                    }
                else:
                    method_details_global[method] = {
                        "method": "Idriss & Boulanger (2014)",
                        "method_short": "I&B 2014",
                        "pga": pga,
                        "mw": mw,
                    }

            for bh in boreholes:
                try:
                    bh_id = str(bh.get('id') or bh.get('name') or 'BH')
                    bh_name = str(bh.get('name') or bh_id)
                    bh_gwt_drill = float(bh.get('gwt_drill', data.get('gwt_drill', data.get('gwt', 1.5))))
                    bh_gwt_design = float(bh.get('gwt_design', data.get('gwt_design', data.get('gwt', 1.5))))
                    bh_layers = (bh.get('layers') or []) if isinstance(bh, dict) else []
                    if not bh_layers:
                        continue

                    df = pd.DataFrame(bh_layers)
                    sigma_v_list, sigma_ve_list = _stress_profile_for_layers(df, bh_gwt_design, unit_system)

                    results_by_method = {}
                    min_fs_by_method = {}
                    for method in valid_methods:
                        if method == 'NCEER2001':
                            model = NCEER2001(Mw=mw, PGA=pga, CE=ce)
                        else:
                            model = IdrissBoulanger2014(Mw=mw, PGA=pga, CE=ce)

                        results = []
                        for i, row in df.iterrows():
                            if i < len(sigma_v_list) and i < len(sigma_ve_list):
                                res = model.analyze_layer(
                                    depth=float(row['depth']),
                                    N_measured=float(row['spt_n']),
                                    sigma_v_total=sigma_v_list[i],
                                    sigma_v_eff=sigma_ve_list[i],
                                    FC=float(row['fc'])
                                )
                                results.append(res)
                        results_by_method[method] = results
                        try:
                            # Factor of Safety only: use key 'FS', not 'fs' (sleeve friction)
                            fs_vals = pd.to_numeric([r.get('FS', np.nan) for r in results], errors='coerce').dropna()
                            min_fs = float(fs_vals.min()) if len(fs_vals) else None
                        except Exception:
                            min_fs = None
                        min_fs_by_method[method] = min_fs

                    out_bhs.append({
                        "id": bh_id,
                        "name": bh_name,
                        "gwt_drill": bh_gwt_drill,
                        "gwt_design": bh_gwt_design,
                        "min_fs_by_method": min_fs_by_method,
                        "results_by_method": results_by_method,
                    })
                except Exception as e:
                    out_bhs.append({
                        "id": str(bh.get('id') or bh.get('name') or 'BH'),
                        "name": str(bh.get('name') or bh.get('id') or 'BH'),
                        "error": str(e)
                    })

            if not out_bhs:
                return jsonify({"status": "error", "message": "No layer data"}), 400

            return jsonify({
                "status": "success",
                "metadata": {
                    "test_type": "SPT",
                    "methods": valid_methods,
                    "method_details": method_details_global,
                    "pga": pga,
                    "mw": mw,
                    "unit_system": unit_system,
                },
                "results": {
                    "boreholes": out_bhs
                }
            })

        if not layers:
            return jsonify({"status": "error", "message": "No layer data"}), 400

        # =========================================================
        # CPT path: Boulanger & Idriss (2014) liquefaction (backend)
        # =========================================================
        if test_type == 'CPT':
            cpt_params = data.get('cpt_params') or {}

            # net area ratio
            an = cpt_params.get('net_area_ratio')
            if an is None:
                an = cpt_params.get('netAreaRatio')
            try:
                an = float(an) if an is not None else 0.8
            except Exception:
                an = 0.8

            # Build DataFrame (depth, qc, fs, u2) from `layers` or `cpt_data`
            cpt_rows = data.get('cpt_data') or layers
            df_cpt = pd.DataFrame(cpt_rows)
            # enforce required cols
            for col in ['depth', 'qc', 'fs']:
                if col not in df_cpt.columns:
                    return jsonify({"status": "error", "message": f"CPT data missing required column: {col}"}), 400
            # Try unit heuristics (keep conservative and transparent)
            conversions = []

            if 'u2' not in df_cpt.columns:
                df_cpt['u2'] = 0.0
            # CPT input: u2 is treated as water head (length). Convert to pressure (kPa) for qt correction / BI2014.
            else:
                try:
                    df_cpt['u2'] = pd.to_numeric(df_cpt['u2'], errors='coerce').fillna(0.0)
                    if unit_system == 'imperial':
                        u2_head_m = df_cpt['u2'] * 0.3048  # ft -> m
                    else:
                        u2_head_m = df_cpt['u2']  # m
                    df_cpt['u2'] = u2_head_m * 9.81  # kPa (since 1 kN/m^2 = 1 kPa)
                    conversions.append('u2_head_to_kpa')
                except Exception:
                    df_cpt['u2'] = 0.0
            if unit_system == 'imperial':
                # depth & gwl are in ft -> convert to m for the CPT model
                df_cpt['depth'] = df_cpt['depth'].astype(float) * 0.3048
                gwl_drill_ft = gwt_drill
                gwl_design_ft = gwt_design
                conversions.append('depth_ft_to_m')
                # qc/fs are in tsf -> convert to kPa for the CPT model
                TSF_TO_KPA = 95.7605
                df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * TSF_TO_KPA
                df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * TSF_TO_KPA
                conversions.append('qc_fs_tsf_to_kpa')
            else:
                # metric
                gwl_drill_ft = gwt_drill / 0.3048
                gwl_design_ft = gwt_design / 0.3048

            # qc/fs heuristic (metric only): if user entered MPa, convert to kPa
            if unit_system != 'imperial':
                try:
                    qc_med = float(pd.to_numeric(df_cpt['qc'], errors='coerce').median())
                    if qc_med > 0 and qc_med < 200:  # likely MPa range (e.g. 5~20)
                        df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * 1000.0
                        df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * 1000.0
                        conversions.append('mpa_to_kpa')
                except Exception:
                    pass

            cpt_methods = data.get('cpt_methods') or data.get('methods')
            if not isinstance(cpt_methods, list):
                cpt_methods = [cpt_methods] if cpt_methods in ['Youd2001', 'IB2014'] else ['Youd2001', 'IB2014']
            valid_cpt_methods = [m for m in cpt_methods if m in ['Youd2001', 'IB2014']]
            if not valid_cpt_methods:
                valid_cpt_methods = ['Youd2001', 'IB2014']

            results_by_method = {}
            total_settlement_by_method = {}
            for cpt_m in valid_cpt_methods:
                if cpt_m == 'Youd2001':
                    df_out, total_settlement_m = calculate_cpt_liquefaction_youd2001(
                        df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                        mw=mw, pga=pga,
                        gwl_drill_ft=gwl_drill_ft, gwl_design_ft=gwl_design_ft, an=an
                    )
                else:
                    df_out, total_settlement_m = calculate_cpt_liquefaction_bi2014(
                        df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                        mw=mw, pga=pga,
                        gwl_drill_ft=gwl_drill_ft, gwl_design_ft=gwl_design_ft, an=an
                    )
                results_by_method[cpt_m] = _sanitize_for_json(df_out.to_dict(orient='records'))
                total_settlement_by_method[cpt_m] = total_settlement_m

            method_display = 'Youd (2001) & I&B (2014)' if len(valid_cpt_methods) > 1 else (
                'Youd et al. (2001) - CPT' if valid_cpt_methods[0] == 'Youd2001' else 'Boulanger & Idriss (2014) - CPT'
            )
            payload = {
                "status": "success",
                "metadata": {
                    "method": method_display,
                    "method_short": "CPT multi" if len(valid_cpt_methods) > 1 else ("Youd 2001 (CPT)" if valid_cpt_methods[0] == 'Youd2001' else "B&I 2014 (CPT)"),
                    "cpt_methods": valid_cpt_methods,
                    "pga": pga, "mw": mw,
                    "gwt_drill": gwt_drill, "gwt_design": gwt_design,
                    "net_area_ratio": an,
                    "unit_system": unit_system,
                    "conversions": conversions,
                    "total_settlement_m": total_settlement_by_method.get('IB2014', total_settlement_by_method.get('Youd2001', 0)),
                    "total_settlement_by_method": total_settlement_by_method
                },
                "results": results_by_method.get('IB2014', results_by_method.get('Youd2001', [])),
                "results_by_method": results_by_method
            }
            return jsonify(_sanitize_for_json(payload))

        # Methods (support multi-method)
        methods = data.get('methods', [])
        if not methods:
            # Backward compatible: use `method`
            method = data.get('method', 'IB2014')
            if isinstance(method, list):
                methods = method
            else:
                methods = [method] if method in ['IB2014', 'NCEER2001'] else ['IB2014', 'NCEER2001']

        valid_methods = [m for m in methods if m in ['IB2014', 'NCEER2001']]
        if not valid_methods:
            valid_methods = ['IB2014', 'NCEER2001']

        # 2. Convert to DataFrame
        df = pd.DataFrame(layers)

        # 3. Stress profile (total/effective)
        sigma_v_list = []
        sigma_ve_list = []
        current_sigma_v = 0.0
        prev_depth = 0.0
        unit_water = 9.81

        for index, row in df.iterrows():
            try:
                depth = float(row['depth'])
                gamma = float(row['gamma'])

                if np.isnan(depth) or np.isinf(depth) or depth < 0:
                    continue
                if np.isnan(gamma) or np.isinf(gamma) or gamma <= 0:
                    gamma = 18.0

                if depth <= prev_depth:
                    depth = prev_depth + 0.5

                thickness = depth - prev_depth
                if thickness <= 0:
                    continue

                current_sigma_v += thickness * gamma
                # Use design groundwater level for earthquake-effective stress
                u = (depth - gwt_design) * unit_water if depth > gwt_design else 0.0
                sigma_ve = current_sigma_v - u

                if np.isnan(current_sigma_v) or np.isinf(current_sigma_v):
                    current_sigma_v = 0.0
                if np.isnan(sigma_ve) or np.isinf(sigma_ve):
                    sigma_ve = current_sigma_v

                sigma_v_list.append(current_sigma_v)
                sigma_ve_list.append(sigma_ve)
                prev_depth = depth
            except (ValueError, KeyError) as e:
                print(f"Error processing layer data (index {index}): {e}")
                continue

        # 4. Run analysis for each method
        all_results = {}
        all_metadata = {}

        for method in valid_methods:
            if method == 'NCEER2001':
                model = NCEER2001(Mw=mw, PGA=pga, CE=ce)
                method_name = "NCEER (Youd et al., 2001)"
                method_short = "NCEER 2001"
            else:
                model = IdrissBoulanger2014(Mw=mw, PGA=pga, CE=ce)
                method_name = "Idriss & Boulanger (2014)"
                method_short = "I&B 2014"

            results = []
            for i, row in df.iterrows():
                if i < len(sigma_v_list) and i < len(sigma_ve_list):
                    res = model.analyze_layer(
                        depth=float(row['depth']),
                        N_measured=float(row['spt_n']),
                        sigma_v_total=sigma_v_list[i],
                        sigma_v_eff=sigma_ve_list[i],
                        FC=float(row['fc'])
                    )
                    results.append(res)

            all_results[method] = _sanitize_for_json(results)
            all_metadata[method] = {
                "method": method_name,
                "method_short": method_short,
                "pga": pga,
                "mw": mw,
                "gwt_drill": gwt_drill,
                "gwt_design": gwt_design
            }

        # 5. Response (keep backward compatibility for single method)
        if len(valid_methods) == 1:
            method = valid_methods[0]
            return jsonify(_sanitize_for_json({
                "status": "success",
                "metadata": all_metadata[method],
                "results": all_results[method]
            }))

        return jsonify(_sanitize_for_json({
            "status": "success",
            "metadata": {
                "methods": valid_methods,
                "method_details": all_metadata,
                "pga": pga,
                "mw": mw,
                    "gwt_drill": gwt_drill,
                    "gwt_design": gwt_design
            },
            "results": all_results
        }))

    except Exception as e:
        print(f"Calculation Error: {e}")
        return jsonify({"status": "error", "message": f"Calculation failed: {str(e)}"}), 500


# ==========================================
# Plot and export routes (url_prefix /api)
# ==========================================

@liquefaction_plot_bp.route('/plot', methods=['POST'])
def generate_plot():
    """Generate liquefaction analysis plot from calculation results."""
    try:
        data = request.json
        test_type = str(data.get('test_type', 'SPT')).upper()
        pga = float(data.get('pga', 0.4))
        mw = float(data.get('mw', 7.5))
        gwt_drill = float(data.get('gwt_drill', data.get('gwt', 1.5)))
        gwt_design = float(data.get('gwt_design', data.get('gwt', 1.5)))
        ce = float(data.get('ce', 0.60))
        layers = data.get('layers', [])
        project_name = data.get('project_name', 'Liquefaction Analysis')

        if not layers:
            return jsonify({"status": "error", "message": "No layer data"}), 400

        if test_type == 'CPT':
            unit_system = data.get('unit_system', 'imperial')
            cpt_params = data.get('cpt_params') or {}
            an = cpt_params.get('net_area_ratio', 0.8)
            try:
                an = float(an)
            except Exception:
                an = 0.8

            cpt_rows = data.get('cpt_data') or layers or []
            df_cpt = pd.DataFrame(cpt_rows)
            for col in ['depth', 'qc', 'fs']:
                if col not in df_cpt.columns:
                    return jsonify({"status": "error", "message": f"CPT data missing required column: {col}"}), 400
            if 'u2' not in df_cpt.columns:
                df_cpt['u2'] = 0.0

            if str(unit_system).lower() == 'imperial':
                df_cpt['depth'] = pd.to_numeric(df_cpt['depth'], errors='coerce') * 0.3048
                gwl_drill_ft = gwt_drill
                gwl_design_ft = gwt_design
                TSF_TO_KPA = 95.7605
                df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * TSF_TO_KPA
                df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * TSF_TO_KPA
            else:
                df_cpt['depth'] = pd.to_numeric(df_cpt['depth'], errors='coerce')
                gwl_drill_ft = gwt_drill / 0.3048
                gwl_design_ft = gwt_design / 0.3048

            try:
                df_cpt['u2'] = pd.to_numeric(df_cpt['u2'], errors='coerce').fillna(0.0)
                if str(unit_system).lower() == 'imperial':
                    u2_head_m = df_cpt['u2'] * 0.3048
                else:
                    u2_head_m = df_cpt['u2']
                df_cpt['u2'] = u2_head_m * 9.81
            except Exception:
                df_cpt['u2'] = 0.0

            if str(unit_system).lower() != 'imperial':
                qc_med = float(pd.to_numeric(df_cpt['qc'], errors='coerce').median())
                if qc_med > 0 and qc_med < 200:
                    df_cpt['qc'] = pd.to_numeric(df_cpt['qc'], errors='coerce') * 1000.0
                    df_cpt['fs'] = pd.to_numeric(df_cpt['fs'], errors='coerce') * 1000.0

            df_out, total_settlement_m = calculate_cpt_liquefaction_bi2014(
                df_input=df_cpt[['depth', 'qc', 'fs', 'u2']].copy(),
                mw=mw, pga=pga,
                gwl_drill_ft=gwl_drill_ft,
                gwl_design_ft=gwl_design_ft,
                an=an
            )
            img_bytes = plot_cpt_liquefaction_results(
                df_out,
                total_settlement_m=total_settlement_m,
                project_name=project_name,
                unit_system=('imperial' if str(unit_system).lower() == 'imperial' else 'metric')
            )
            img_base64 = base64.b64encode(img_bytes.read()).decode('utf-8')
            return jsonify({"status": "success", "image": f"data:image/png;base64,{img_base64}"})

        df = pd.DataFrame(layers)
        df = calculate_stress_profile(df, gwt_design)
        method = data.get('method', 'IB2014')
        if method == 'NCEER2001':
            model = NCEER2001(Mw=mw, PGA=pga, CE=ce)
        else:
            model = IdrissBoulanger2014(Mw=mw, PGA=pga, CE=ce)

        csr_list, crr_list, fs_list, n1_60cs_list = [], [], [], []
        for i, row in df.iterrows():
            res = model.analyze_layer(
                depth=float(row['depth']),
                N_measured=float(row['spt_n']),
                sigma_v_total=float(row['sigma_v']),
                sigma_v_eff=float(row['sigma_ve']),
                FC=float(row['fc'])
            )
            csr_list.append(res['CSR'])
            crr_list.append(res['CRR'])
            fs_list.append(res['FS'])
            n1_60cs = model.solve_N1_60cs(float(row['spt_n']), float(row['sigma_ve']), float(row['fc']))
            n1_60cs_list.append(float(n1_60cs.get('N1_60cs', 0)) if isinstance(n1_60cs, dict) else float(n1_60cs))
        df['CSR'] = csr_list
        df['CRR'] = crr_list
        df['FS'] = fs_list
        df['N1_60cs'] = n1_60cs_list

        method_display = 'NCEER 2001' if method == 'NCEER2001' else 'I&B 2014'
        unit_system = data.get('unit_system', 'imperial')
        img_bytes = plot_liquefaction_analysis(df, project_name=project_name, method=method_display, unit_system=unit_system)
        img_base64 = base64.b64encode(img_bytes.read()).decode('utf-8')
        return jsonify({"status": "success", "image": f"data:image/png;base64,{img_base64}"})
    except Exception as e:
        print(f"Plot generation error: {e}")
        return jsonify({"status": "error", "message": f"Plot generation failed: {str(e)}"}), 500


@liquefaction_plot_bp.route('/export-excel', methods=['POST'])
def export_excel():
    """Export liquefaction analysis to Excel."""
    from liquefaction_export import run_export_excel
    return run_export_excel(request.json)
