"""
Supported Tag (retaining wall) API routes - lateral and basal heave analysis.
"""
import io
from flask import Blueprint, request, jsonify, send_file

from supported_tag import run_supported_tag_analysis, generate_supported_tag_excel


supported_tag_bp = Blueprint('supported_tag', __name__, url_prefix='/api/supported-tag')


@supported_tag_bp.route('/calculate', methods=['POST'])
def calculate_supported_tag():
    """
    Run supported retaining wall lateral stability analysis.
    Expects JSON: excavation_depth, wall_depth, water_level_active, water_level_passive,
    surcharge, layers (with thickness, type, gamma, c, phi, su), etc.
    """
    try:
        data = request.json
        result = run_supported_tag_analysis(data)
        return jsonify({"status": "success", **result})
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400
    except Exception as e:
        print(f"Supported tag calculation error: {e}")
        return jsonify({"status": "error", "message": f"Calculation failed: {str(e)}"}), 500


@supported_tag_bp.route('/export-excel', methods=['POST'])
def export_supported_tag_excel():
    """
    Export supported tag analysis Excel report.
    Expects same JSON format as /api/supported-tag/calculate.
    Optional: input_data for display.
    """
    try:
        data = request.json
        if data is None:
            return jsonify({"status": "error", "message": "Request body is required (JSON)"}), 400

        result = run_supported_tag_analysis(data)
        project_info = {
            'DesignCode': data.get('design_code', 'TWN-112 (2023)'),
            'Method': f"{str(data.get('ka_method') or 'Rankine')} / {str(data.get('kp_method') or 'Caquot-Kerisel')}",
            'surcharge_mode': data.get('surcharge_mode', 'manual'),
            'surcharge_q': data.get('surcharge_q', 0.0),
            'surcharge_sh': data.get('surcharge_sh', 0.0),
            'sub_records': data.get('sub_records', []),
        }
        input_data = data.get('input_data', {})
        if not input_data:
            input_data = {
                'ds': data.get('ds', 0),
                'de': abs(data.get('excavation_depth', 0)),
                'dl': abs(data.get('wall_depth', 0)),
                'fssR': data.get('fssR', 1.5),
                'fshR': data.get('fshR', 1.5)
            }
        excel_file = generate_supported_tag_excel(
            project_info,
            result['lateral_analysis'],
            result['heave_analysis'],
            data.get('layers', []),
            input_data=input_data
        )
        excel_file.seek(0)
        excel_bytes = excel_file.getvalue()
        if len(excel_bytes) < 500:
            return jsonify({"status": "error", "message": "Excel generation failed: file is empty or invalid"}), 500
        return send_file(
            io.BytesIO(excel_bytes),
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name='Supported_Tag_Analysis_Report.xlsx'
        )
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400
    except Exception as e:
        print(f"Excel export error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "message": f"Excel export failed: {str(e)}"}), 500
