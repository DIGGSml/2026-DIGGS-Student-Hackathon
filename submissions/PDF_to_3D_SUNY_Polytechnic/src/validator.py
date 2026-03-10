from lxml import etree
import os
import logging

logger = logging.getLogger(__name__)

def load_schema(xsd_path):
    """Load DIGGS 2.6 schema."""
    try:
        with open(xsd_path, "rb") as f:
            schema_doc = etree.parse(f)
        schema = etree.XMLSchema(schema_doc)
        logger.info("Schema loaded successfully.")
        return schema
    except Exception as e:
        logger.error(f"Schema load failed: {e}")
        return None

def load_xml(xml_path):
    """Parse XML file."""
    try:
        xml_doc = etree.parse(xml_path)
        logger.info("XML parsed successfully.")
        return xml_doc
    except Exception as e:
        logger.error(f"XML parsing error: {e}")
        return None

def validate_xml(schema, xml_doc, result_path):
    """Validate XML against DIGGS 2.6 schema. Writes result to result_path."""
    os.makedirs(os.path.dirname(result_path), exist_ok=True)

    with open(result_path, "w", encoding="utf-8") as f:
        f.write("Validation Results:\n")
        if schema.validate(xml_doc):
            f.write("Stage 1 PASSED — XML is valid according to DIGGS 2.6 schema.\n")
            logger.info("Validation PASSED.")
            return True
        else:
            f.write("Stage 1 FAILED — Schema errors:\n")
            for error in schema.error_log:
                f.write(f"- Line {error.line}, Column {error.column}: {error.message}\n")
            logger.warning(f"Validation FAILED with {len(schema.error_log)} error(s).")
            return False

def run_validation(xml_path, result_path=None):
    """Main validation entry point callable from other modules.

    Args:
        xml_path:    Path to the XML file to validate.
        result_path: Optional path for the validation result text file.
                     Defaults to output/<xml_basename>_validation.txt.
    """
    logger.info(f"Validating {xml_path} against DIGGS 2.6 Schema")

    base_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(base_dir)
    schema_path = os.path.join(root_dir, "schema_26", "Diggs.xsd")

    # Default per-file result path to avoid shared-file race conditions
    if result_path is None:
        output_dir = os.path.join(root_dir, "output")
        base_name = os.path.splitext(os.path.basename(xml_path))[0]
        result_path = os.path.join(output_dir, f"{base_name}_validation.txt")

    schema = load_schema(schema_path)
    if not schema:
        return False

    xml_doc = load_xml(xml_path)
    if not xml_doc:
        return False

    return validate_xml(schema, xml_doc, result_path)
