import logging

logger = logging.getLogger(__name__)


def check_extraction_viability(extracted_data):
    """
    Hard Minimum Requirements Gate.

    Checks whether the extracted data has enough content for a meaningful
    DIGGS XML conversion. Returns (is_valid, error_message, warnings).

    Gate 1 (Hard Stop):
        Both tests AND stratigraphy are empty → reject.
        Rationale: no data = nothing to put in the XML. Output-driven validation.

    Gate 2 (Soft Warning):
        borehole_id is "Unknown" but data exists → proceed with a warning.
    """
    tests = extracted_data.get("tests", [])
    stratigraphy = extracted_data.get("stratigraphy", [])
    metadata = extracted_data.get("metadata", {})
    borehole_id = metadata.get("borehole_id", "Unknown")

    warnings = []

    # ── Gate 1: Hard Stop ────────────────────────────────────────────────────
    if len(tests) == 0 and len(stratigraphy) == 0:
        logger.warning(
            "Viability check FAILED: no SPT tests or stratigraphy found. "
            "This PDF is likely not a borehole log."
        )
        return (
            False,
            (
                "This PDF does not appear to be a borehole log. "
                "No soil descriptions or SPT test data were found. "
                "Please upload a geotechnical boring log and try again."
            ),
            [],
        )

    # ── Gate 2: Soft Warning ─────────────────────────────────────────────────
    if borehole_id == "Unknown":
        msg = (
            "Borehole ID not detected in this PDF. "
            "The output will be labelled 'Unknown' — you may wish to edit it manually."
        )
        warnings.append(msg)
        logger.warning(f"Viability warning: {msg}")

    logger.info(
        f"Viability check PASSED — "
        f"{len(tests)} SPT test(s), {len(stratigraphy)} stratigraphy layer(s). "
        f"Warnings: {len(warnings)}"
    )
    return True, None, warnings
