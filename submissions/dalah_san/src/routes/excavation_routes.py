"""
Excavation API routes - uplift and sand boil analysis.
"""
import io
from flask import Blueprint, request, jsonify, send_file

from excavation import run_excavation_analysis, generate_excavation_excel


excavation_bp = Blueprint('excavation', __name__, url_prefix='/api/excavation')


@excavation_bp.route('/calculate', methods=['POST'])
def calculate_excavation():
    """
    Run excavation analysis (uplift and sand boil).
    Expects JSON: wall_length, gwt_gl, interface_depth, interface_desc, layers, stages, etc.
    """
    try:
        data = request.json
        result = run_excavation_analysis(data)
        return jsonify({"status": "success", **result})
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400
    except Exception as e:
        print(f"Excavation calculation error: {e}")
        return jsonify({"status": "error", "message": f"Calculation failed: {str(e)}"}), 500


@excavation_bp.route('/export-excel', methods=['POST'])
def export_excavation_excel():
    """
    Export excavation analysis Excel report.
    Expects same JSON format as /api/excavation/calculate.
    """
    try:
        data = request.json
        if data is None:
            return jsonify({"status": "error", "message": "Request body is required (JSON)"}), 400

        result = run_excavation_analysis(data)
        metadata = result['metadata']
        project_info = {
            'GWT': metadata['gwt_gl'],
            'WallLength': metadata['wall_length'],
            'InterfaceDepth': metadata['interface_depth'],
            'InterfaceDesc': metadata['interface_desc']
        }
        meta = result.get('metadata', {})
        if 'unit_system' not in meta:
            meta = {**meta, 'unit_system': data.get('unit_system', 'metric')}
        excel_file = generate_excavation_excel(
            project_info,
            result['uplift_results'],
            result['sand_boil_results'],
            data.get('layers', []),
            metadata=meta,
            stages=data.get('stages', [])
        )
        excel_file.seek(0)
        excel_bytes = excel_file.getvalue()
        if len(excel_bytes) < 500:
            return jsonify({"status": "error", "message": "Excel generation failed: file is empty or invalid"}), 500
        return send_file(
            io.BytesIO(excel_bytes),
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name='Excavation_Analysis_Report.xlsx'
        )
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400
    except Exception as e:
        print(f"Excel export error: {e}")
        return jsonify({"status": "error", "message": f"Excel export failed: {str(e)}"}), 500
