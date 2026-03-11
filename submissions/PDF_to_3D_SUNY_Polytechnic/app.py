from flask import Flask, render_template, request, jsonify, send_file
from werkzeug.utils import secure_filename
import os
import json
import logging
from src.extraction import extract_data_from_pdf
from src.schema_mapper import map_to_diggs_structure
from src.diggs_generator import generate_diggs_xml
from src.validator import run_validation
from src.input_validator import check_extraction_viability
from src.xml_to_excel import xml_to_excel, upsert_master_excel

app = Flask(__name__)

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 32 MB upload limit — prevents server blocking on huge files
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024

UPLOAD_FOLDER      = 'Files/uploads'
OUTPUT_FOLDER      = 'output'
XML_FOLDER         = 'output/xml'
EXCEL_FOLDER       = 'output/excel'
PLOTS_FOLDER       = 'output/plots'
LOGS_FOLDER        = 'output/logs'
INTERMEDIATE_FOLDER = 'intermediate'
MASTER_EXCEL       = os.path.join(EXCEL_FOLDER, 'master_boreholes.xlsx')

# Ensure all directories exist
for folder in [UPLOAD_FOLDER, XML_FOLDER, EXCEL_FOLDER, PLOTS_FOLDER, LOGS_FOLDER, INTERMEDIATE_FOLDER]:
    os.makedirs(folder, exist_ok=True)

@app.route('/')
def home():
    return render_template('home.html')

@app.route('/converter')
def converter():
    return render_template('converter.html')

@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/contact')
def contact():
    return render_template('contact.html')

@app.route('/visualize')
def visualize():
    return render_template('visualize.html')

@app.route('/plot/<plot_name>')
def serve_plot(plot_name):
    """Serve pre-generated Plotly HTML files for embedding in iframes."""
    allowed = {'3d_borehole_grid', '3d_cross_section'}
    if plot_name not in allowed:
        from flask import abort
        abort(404)
    plot_path = os.path.join(PLOTS_FOLDER, f"{plot_name}.html")
    if not os.path.exists(plot_path):
        return (
            "<html><body style='background:#0a0a1a;color:#94a3b8;font-family:sans-serif;"
            "display:flex;align-items:center;justify-content:center;height:100vh;'>"
            "<div style='text-align:center'><h2>No visualization yet</h2>"
            "<p>Convert a PDF first, or run <code>python visualize_3d.py</code></p></div></body></html>"
        ), 200
    return send_file(plot_path)

@app.route('/convert', methods=['POST'])
def convert_pdf():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file and file.filename.lower().endswith('.pdf'):
        try:
            # 1. Save uploaded file with sanitized name to prevent path traversal
            original_filename = file.filename          # preserve for coordinate fallback
            safe_name = secure_filename(file.filename)
            input_path = os.path.join(UPLOAD_FOLDER, safe_name)
            file.save(input_path)

            # 2. Define output paths (per-request — no shared file race condition)
            base_name = os.path.splitext(safe_name)[0]
            output_xml          = os.path.join(XML_FOLDER,   f"{base_name}.xml")
            output_xlsx         = os.path.join(EXCEL_FOLDER, f"{base_name}.xlsx")
            intermediate_json   = os.path.join(INTERMEDIATE_FOLDER, f"{base_name}.json")
            validation_log_path = os.path.join(LOGS_FOLDER,  f"{base_name}_validation.txt")

            # 3. Extract — pass original_filename so coordinate fallback uses unsanitized name
            logger.info(f"Extracting: {input_path}")
            raw_data = extract_data_from_pdf(input_path, original_filename=original_filename)

            # 3b. Viability Gate — reject non-borehole PDFs before any further work
            is_viable, rejection_msg, warnings = check_extraction_viability(raw_data)
            if not is_viable:
                return jsonify({
                    'error': rejection_msg,
                    'type': 'not_a_borehole_log'
                }), 422

            # Save Intermediate (use distinct handle to avoid shadowing)
            with open(intermediate_json, 'w', encoding='utf-8') as json_f:
                json.dump(raw_data, json_f, indent=4)
                
            # 4. Map
            diggs_data = map_to_diggs_structure(raw_data)
            
            # 5. Generate XML
            generate_diggs_xml(diggs_data, output_xml)

            # 6. Validate — runs right after XML generation, before Excel/plots
            is_valid = run_validation(output_xml, result_path=validation_log_path)

            # 6b. Read per-request validation log
            validation_details = ""
            if os.path.exists(validation_log_path):
                with open(validation_log_path, "r", encoding="utf-8") as log_f:
                    validation_details = log_f.read()

            # 7. Generate Excel (single borehole + master upsert) + 3D plots
            try:
                xml_to_excel(output_xml, output_xlsx)
                upsert_master_excel(output_xml, MASTER_EXCEL)
                # 7b. Refresh 3D plots — pass per-upload Excel so visualization
                #     shows only the current borehole, not all accumulated ones
                from visualize_3d import regenerate_plots
                regenerate_plots(borehole_excel_path=output_xlsx)
            except Exception as exc:
                logger.warning(f"Excel/plot generation failed (non-fatal): {exc}")
                output_xlsx = None

            # Read Generated XML content for preview
            with open(output_xml, "r", encoding="utf-8") as xml_f:
                xml_content = xml_f.read()
                
            return jsonify({
                'status': 'success',
                'xml_content': xml_content,
                'validation_status': 'VALID' if is_valid else 'INVALID',
                'validation_details': validation_details,
                'download_url': f"/download/{os.path.basename(output_xml)}",
                'excel_download_url': f"/download/{os.path.basename(output_xlsx)}" if output_xlsx else None,
                'warnings': warnings
            })

        except Exception as e:
            logger.error(f"Conversion failed: {e}", exc_info=True)
            return jsonify({'error': str(e), 'details': 'Check server logs for full traceback.'}), 500
            
    return jsonify({'error': 'Invalid file type. Please upload a PDF.'}), 400

@app.route('/download/<filename>')
def download_file(filename):
    safe = secure_filename(filename)
    # Search xml/ then excel/ subfolder
    for folder in [XML_FOLDER, EXCEL_FOLDER]:
        path = os.path.join(folder, safe)
        if os.path.exists(path):
            return send_file(path, as_attachment=True)
    return jsonify({'error': 'File not found.'}), 404

@app.route('/download-master')
def download_master():
    if not os.path.exists(MASTER_EXCEL):
        return jsonify({'error': 'No master Excel yet — convert a PDF first.'}), 404
    return send_file(MASTER_EXCEL, as_attachment=True,
                     download_name='master_boreholes.xlsx')

@app.route('/reset-master', methods=['POST'])
def reset_master():
    """Delete all processed data, uploads, and plots for a true fresh start."""
    folders_to_clear = [UPLOAD_FOLDER, XML_FOLDER, EXCEL_FOLDER, PLOTS_FOLDER, LOGS_FOLDER, INTERMEDIATE_FOLDER]
    deleted = []
    
    for folder in folders_to_clear:
        if os.path.exists(folder):
            for filename in os.listdir(folder):
                file_path = os.path.join(folder, filename)
                try:
                    if os.path.isfile(file_path):
                        os.remove(file_path)
                        deleted.append(filename)
                except Exception as e:
                    logger.warning(f"Error deleting {file_path}: {e}")
                    
    # Note: We do NOT call regenerate_plots() here anymore.
    # By deleting the HTML plots, the UI will simply show "No visualization yet"
    return jsonify({'status': 'reset', 'deleted': deleted})

if __name__ == '__main__':
    # Disable reloader to prevent restarts when files are generated in the project folder
    app.run(debug=True, use_reloader=False, port=5000)
