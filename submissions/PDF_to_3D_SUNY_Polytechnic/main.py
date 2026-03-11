import os
import sys
import logging
import json
from src.extraction import extract_data_from_pdf
from src.schema_mapper import map_to_diggs_structure
from src.diggs_generator import generate_diggs_xml

# Configure logging (Console only, no file)
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s: %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

INPUT_DIR = "Files"
OUTPUT_DIR = "output"
INTERMEDIATE_DIR = "intermediate"

def main():
    # Ensure directories exist
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
    if not os.path.exists(INTERMEDIATE_DIR):
        os.makedirs(INTERMEDIATE_DIR)

    # Find the PDF file (heuristic: first PDF in Files)
    pdf_files = [f for f in os.listdir(INPUT_DIR) if f.lower().endswith('.pdf')]
    if not pdf_files:
        logger.error(f"No PDF files found in {INPUT_DIR}")
        return

    input_pdf = os.path.join(INPUT_DIR, pdf_files[0])
    base_name = os.path.splitext(pdf_files[0])[0]
    output_xml = os.path.join(OUTPUT_DIR, f"{base_name}.xml")
    intermediate_json = os.path.join(INTERMEDIATE_DIR, f"{base_name}.json")
    
    logger.info(f"Starting conversion for: {input_pdf}")
    
    try:
        # 1. Extraction
        logger.info("Step 1: Extracting data from PDF...")
        raw_data = extract_data_from_pdf(input_pdf)
        logger.info(f"Extraction complete. Found {len(raw_data.get('stratigraphy', []))} layers.")
        
        # Save Intermediate JSON
        logger.info(f"Saving intermediate JSON to {intermediate_json}...")
        with open(intermediate_json, 'w', encoding='utf-8') as f:
            json.dump(raw_data, f, indent=4)
        
        # 2. Mapping
        logger.info("Step 2: Mapping to DIGGS structure...")
        diggs_data = map_to_diggs_structure(raw_data)
        
        # 3. Generation
        logger.info(f"Step 3: Generating XML to {output_xml}...")
        generate_diggs_xml(diggs_data, output_xml)
        
        logger.info("Conversion Successful! Now running validation...")
        
        # 4. Validation
        from src.validator import run_validation
        is_valid = run_validation(output_xml)
        
        if is_valid:
            logger.info("✅ Validation Passed: XML is DIGGS 2.6 compliant.")
        else:
            logger.error("❌ Validation Failed: Check validation_result.txt for details.")
        
    except Exception as e:
        logger.error(f"Conversion Failed: {e}", exc_info=True)

if __name__ == "__main__":
    main()
