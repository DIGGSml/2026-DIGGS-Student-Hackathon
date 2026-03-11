"""
Shallow Foundation API routes - bearing capacity analysis.
"""
import io
from flask import Blueprint, request, jsonify, send_file

from shallow_foundation import run_shallow_foundation_analysis, generate_shallow_foundation_excel


shallow_foundation_bp = Blueprint("shallow_foundation", __name__, url_prefix="/api/shallow-foundation")


@shallow_foundation_bp.route("/calculate", methods=["POST"])
def calculate_shallow_foundation():
    """
    Run shallow foundation bearing capacity analysis.
    Expects JSON: Df, Lx, Ly, ecx, ecy, Dw, FSb1/2/3, layers, load_D/L/W/E, load_combinations.
    """
    try:
        data = request.json or {}
        result = run_shallow_foundation_analysis(data)
        return jsonify({"status": "success", **result})
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400
    except Exception as e:
        print(f"Shallow foundation calculation error: {e}")
        return jsonify({"status": "error", "message": f"Calculation failed: {str(e)}"}), 500


@shallow_foundation_bp.route("/export-excel", methods=["POST"])
def export_shallow_foundation_excel():
    """
    Export shallow foundation analysis Excel report.
    Expects same JSON format as /api/shallow-foundation/calculate.
    """
    try:
        data = request.json or {}
        if not data:
            return jsonify({"status": "error", "message": "Request body is required (JSON)"}), 400

        result = run_shallow_foundation_analysis(data)
        excel_file = generate_shallow_foundation_excel(result)
        excel_file.seek(0)
        excel_bytes = excel_file.getvalue()
        if len(excel_bytes) < 100:
            return jsonify({"status": "error", "message": "Excel generation failed"}), 500

        return send_file(
            io.BytesIO(excel_bytes),
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name="Shallow_Foundation_Bearing_Capacity.xlsx",
        )
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400
    except Exception as e:
        print(f"Shallow foundation Excel export error: {e}")
        return jsonify({"status": "error", "message": f"Excel export failed: {str(e)}"}), 500
