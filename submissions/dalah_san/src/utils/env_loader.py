"""Lightweight .env loader (no python-dotenv dependency)."""
import os


def load_dotenv_if_present(dotenv_path: str) -> bool:
    """
    Load KEY=VALUE pairs from a .env file into os.environ (only if not already set).
    Returns True if file was found and parsed.
    """
    try:
        if not dotenv_path or not os.path.exists(dotenv_path):
            return False
        with open(dotenv_path, "r", encoding="utf-8") as f:
            for raw in f.readlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if not k:
                    continue
                if k not in os.environ or not str(os.environ.get(k, "")).strip():
                    os.environ[k] = v
        return True
    except Exception:
        return False
