from flask import Flask, render_template
import os

# Route blueprints (keeps app.py slimmer)
from liquefaction_routes import liquefaction_bp, liquefaction_plot_bp
from routes.diggs_routes import diggs_bp
from routes.geocode_routes import geocode_bp
from routes.geosetta_routes import geosetta_bp
from routes.usgs_routes import usgs_bp
from routes.excavation_routes import excavation_bp
from routes.shallow_foundation_routes import shallow_foundation_bp
from routes.supported_tag_routes import supported_tag_bp
from routes.feedback_routes import feedback_bp

app = Flask(__name__)
app.register_blueprint(liquefaction_bp)
app.register_blueprint(liquefaction_plot_bp)
app.register_blueprint(diggs_bp)
app.register_blueprint(geocode_bp)
app.register_blueprint(geosetta_bp)
app.register_blueprint(usgs_bp)
app.register_blueprint(excavation_bp)
app.register_blueprint(shallow_foundation_bp)
app.register_blueprint(supported_tag_bp)
app.register_blueprint(feedback_bp)

# Load .env at startup (if present) — check src first, then project root
from utils.env_loader import load_dotenv_if_present
from utils.diggs_helpers import safe_xml_path
_src_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv_if_present(os.path.join(_src_dir, ".env"))
_parent_env = os.path.join(os.path.dirname(_src_dir), ".env")
if os.path.exists(_parent_env):
    load_dotenv_if_present(_parent_env)

# Remind if feedback URL is missing (so admin knows where to set it)
_fb_url = os.environ.get("GOOGLE_FEEDBACK_SCRIPT_URL", "").strip()
if not _fb_url:
    print("Feedback form: not configured. Add GOOGLE_FEEDBACK_SCRIPT_URL to src/.env (your Apps Script Web App URL).")
else:
    print("Feedback form: configured (GOOGLE_FEEDBACK_SCRIPT_URL is set).")




def _preprocess_diggs_db_on_startup():
    """
    Ensure DIGGS SQLite (.db) exists. If not, build it once from XML.
    After that, app only reads from .db — never parses XML on refresh.
    Controlled by env:
      - DIGGS_PREPROCESS_DB_ON_STARTUP (default: true)
      - DIGGS_PRELOAD_FILES (same as compact cache)
    """
    enabled = str(os.getenv("DIGGS_PREPROCESS_DB_ON_STARTUP", "true")).strip().lower() not in {"0", "false", "no"}
    if not enabled:
        print("DIGGS DB pre-process on startup disabled.")
        return

    preload_raw = os.getenv(
        "DIGGS_PRELOAD_FILES",
        "DIGGS_Student_Hackathon_large.XML,2026-DIGGS-Student-Hackathon-V1.XML",
    )
    candidates = [x.strip() for x in preload_raw.split(",") if x.strip()]
    if not candidates:
        return

    import diggs_db
    for xml_name in candidates:
        xml_path = safe_xml_path(xml_name)
        if not xml_path:
            continue
        try:
            db_path = diggs_db.get_db_path(xml_path, prefer_sqlite=True)
            if db_path:
                print(f"DIGGS DB ready: {os.path.basename(db_path)}")
                continue
            # No .db — build SQLite once
            try:
                from tools.preprocess_diggs_to_db import preprocess_diggs_to_db
                from tools.preprocess_diggs_to_sqlite import _write_db_to_sqlite
                base_dir = os.path.dirname(os.path.abspath(__file__))
                cache_dir = os.path.join(base_dir, ".diggs_cache")
                os.makedirs(cache_dir, exist_ok=True)
                xml_base = os.path.splitext(os.path.basename(xml_path))[0]
                sqlite_path = os.path.join(cache_dir, f"{xml_base}.db")
                db = preprocess_diggs_to_db(xml_path, output_path=None, save_json=False)
                _write_db_to_sqlite(db, sqlite_path)
                print(f"DIGGS SQLite created: {os.path.basename(sqlite_path)}")
            except Exception as e:
                print(f"DIGGS DB preprocess failed for {xml_name}: {e}")
        except Exception as e:
            print(f"DIGGS DB preprocess failed for {xml_name}: {e}")


# ==========================================
@app.route('/')
def index():
    return render_template('index.html')

def _run_diggs_preprocess_in_background():
    """Ensure DIGGS SQLite exists (no XML parsing on refresh)."""
    import threading
    def _run():
        try:
            _preprocess_diggs_db_on_startup()
        except Exception as e:
            print(f"[DIGGS] Background preprocess error: {e}")
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    print("[DIGGS] Preprocess started in background (server ready)")


if __name__ == '__main__':
    # In debug mode, only run pre-process in the reloader child process.
    run_main = os.environ.get("WERKZEUG_RUN_MAIN")
    is_non_debug = str(os.environ.get("FLASK_DEBUG", "")).lower() in {"0", "false", "no"}
    if run_main == "true" or (run_main is None and is_non_debug):
        # Run in background so refresh/page load is not blocked
        _run_diggs_preprocess_in_background()
    app.run(debug=True, port=5001)
