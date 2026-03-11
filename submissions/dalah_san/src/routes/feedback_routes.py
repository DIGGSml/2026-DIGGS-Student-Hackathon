"""
Feedback form: appends submissions to a Google Sheet.
Option A — Sheets API (no "Anyone" needed): set GOOGLE_FEEDBACK_SHEET_ID and put
  service account JSON at src/feedback_credentials.json (see docs/GOOGLE_SHEETS_FEEDBACK_SETUP.md).
Option B — Apps Script: set script URL in .env or src/feedback_script_url.txt (deploy as "Anyone").
"""
import os
from datetime import datetime, timezone
import requests
from flask import Blueprint, request, jsonify

feedback_bp = Blueprint("feedback", __name__)

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.abspath(os.path.join(_THIS_DIR, ".."))


def _get_sheet_id_and_credentials():
    """Return (sheet_id, credentials_path) if Sheets API is configured, else (None, None)."""
    sheet_id = os.environ.get("GOOGLE_FEEDBACK_SHEET_ID", "").strip()
    if not sheet_id:
        # Reload .env from src/ in case it wasn't loaded at startup (e.g. different cwd)
        try:
            from utils.env_loader import load_dotenv_if_present
            for d in (SRC_DIR, os.getcwd(), os.path.join(os.getcwd(), "src")):
                p = os.path.join(d, ".env")
                if os.path.isfile(p):
                    load_dotenv_if_present(p)
                    break
            sheet_id = os.environ.get("GOOGLE_FEEDBACK_SHEET_ID", "").strip()
        except Exception:
            pass
    if not sheet_id:
        return None, None
    cred_path = os.environ.get("GOOGLE_FEEDBACK_CREDENTIALS", "").strip()
    if not cred_path:
        for p in (
            os.path.join(SRC_DIR, "feedback_credentials.json"),
            os.path.join(os.getcwd(), "feedback_credentials.json"),
            os.path.join(os.getcwd(), "src", "feedback_credentials.json"),
        ):
            if os.path.isfile(p):
                cred_path = p
                break
    if not cred_path or not os.path.isfile(cred_path):
        return None, None
    return sheet_id, cred_path


def _append_via_sheets_api(sheet_id: str, credentials_path: str, profession: str, email: str, message: str) -> None:
    """Append one row (Timestamp, Profession, Email, Message) to the sheet. Raises on error."""
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build

    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(credentials_path, scopes=scopes)
    service = build("sheets", "v4", credentials=creds)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    body = {"values": [[now, profession, email, message]]}
    service.spreadsheets().values().append(
        spreadsheetId=sheet_id,
        range="Sheet1!A:D",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body=body,
    ).execute()


def _get_script_url():
    """Get Apps Script URL from env or from feedback_script_url.txt."""
    url = os.environ.get("GOOGLE_FEEDBACK_SCRIPT_URL", "").strip()
    if url and "script.google.com/macros" in url:
        return url
    # Try several possible locations for feedback_script_url.txt
    candidates = [
        os.path.join(SRC_DIR, "feedback_script_url.txt"),
        os.path.join(os.getcwd(), "feedback_script_url.txt"),
        os.path.join(os.getcwd(), "src", "feedback_script_url.txt"),
    ]
    for path in candidates:
        try:
            if os.path.isfile(path):
                with open(path, "r", encoding="utf-8-sig") as f:
                    raw = f.read()
                for line in raw.splitlines():
                    line = line.strip().strip('"').strip("'").lstrip("\ufeff")
                    if line.startswith("#"):
                        continue
                    if "script.google.com/macros" in line and "/exec" in line:
                        # Extract URL: from https:// to /exec (inclusive)
                        start = line.find("https://")
                        if start != -1:
                            end = line.find("/exec", start) + 5
                            if end > start:
                                return line[start:end]
                    if line.startswith("https://") and "script.google.com/macros" in line:
                        return line
        except Exception:
            continue
    return ""


@feedback_bp.route("/api/feedback", methods=["POST"])
def submit_feedback():
    """Accept profession, email, message and forward to Google Sheet via Apps Script."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        profession = (data.get("profession") or "").strip()
        email = (data.get("email") or "").strip()
        message = (data.get("message") or "").strip()

        if not email:
            return jsonify({"ok": False, "error": "Email is required."}), 400
        if not message:
            return jsonify({"ok": False, "error": "Message is required."}), 400

        # Option A: Sheets API (service account) — no "Anyone" needed
        sheet_id, cred_path = _get_sheet_id_and_credentials()
        if sheet_id and cred_path:
            try:
                _append_via_sheets_api(sheet_id, cred_path, profession, email, message)
                return jsonify({"ok": True, "message": "Thank you for your feedback!"})
            except Exception as e:
                return jsonify({
                    "ok": False,
                    "error": "Could not write to sheet. Ensure the sheet is shared with the service account email (editor). " + str(e),
                }), 502

        # Sheet ID set but no credentials file → tell them to add it (don't fall back to Apps Script)
        if sheet_id and not cred_path:
            return jsonify({
                "ok": False,
                "error": "Put feedback_credentials.json in src/ (rename your service account JSON key to this name).",
            }), 503

        # Option B: Apps Script Web App
        script_url = _get_script_url()
        if not script_url:
            return jsonify({
                "ok": False,
                "error": "Feedback not configured. Use Sheets API: set GOOGLE_FEEDBACK_SHEET_ID and put service account JSON at src/feedback_credentials.json (see docs/GOOGLE_SHEETS_FEEDBACK_SETUP.md). Or use Apps Script URL in src/feedback_script_url.txt with deployment 'Anyone'.",
            }), 503

        resp = requests.post(
            script_url,
            json={
                "profession": profession,
                "email": email,
                "message": message,
            },
            timeout=15,
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        ct = (resp.headers.get("content-type") or "").lower()
        if "application/json" not in ct:
            return jsonify({
                "ok": False,
                "error": "Google returned non-JSON. Set Apps Script deployment to 'Anyone' and use the /exec URL.",
            }), 502
        try:
            result = resp.json()
        except Exception:
            result = {}
        if not result.get("ok"):
            msg = result.get("error") or "Google Sheet did not accept the data. Set deployment to 'Anyone' and check the script."
            return jsonify({"ok": False, "error": msg}), 500
        return jsonify({"ok": True, "message": "Thank you for your feedback!"})
    except requests.Timeout:
        return jsonify({"ok": False, "error": "Google took too long to respond. Try again."}), 502
    except requests.ConnectionError:
        return jsonify({"ok": False, "error": "Could not reach Google. Check internet and that the script URL is correct."}), 502
    except requests.HTTPError as e:
        code = e.response.status_code if e.response is not None else 0
        if code in (401, 403):
            msg = "Google returned %s. Set deployment to 'Anyone': open the script → Deploy → Manage deployments → Edit (pencil) → Who has access → Anyone → Deploy." % code
        elif code == 404:
            msg = "Google returned 404. Make sure the URL in feedback_script_url.txt ends with /exec."
        elif code >= 500:
            msg = "Google server error. Try again in a moment."
        else:
            msg = f"Google returned {code}. Check the script URL and deployment."
        return jsonify({"ok": False, "error": msg}), 502
    except requests.RequestException:
        return jsonify({"ok": False, "error": "Could not save feedback. Please try again later."}), 502
    except Exception as e:
        return jsonify({"ok": False, "error": "An error occurred. Please try again."}), 500
