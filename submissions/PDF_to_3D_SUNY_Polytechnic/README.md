# DIGGS 2.6 Borehole Log Converter

> **DIGGS Student Hackathon 2026 — SUNY Polytechnic Institute**

An end-to-end pipeline that converts geotechnical borehole log PDFs into validated **DIGGS 2.6 XML**, structured **Excel** workbooks, and interactive **3D soil-profile visualizations** — all from a single drag-and-drop web interface.

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Solution Overview](#solution-overview)
- [Key Features](#key-features)
- [System Architecture](#system-architecture)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Manual Setup](#manual-setup)
- [Web UI Usage](#web-ui-usage)
- [CLI Usage](#cli-usage)
- [Supported PDF Formats](#supported-pdf-formats)
- [Technology Stack](#technology-stack)
- [Future Work](#future-work)
- [Team](#team)
- [License](#license)

---

## Problem Statement

Geotechnical site investigation data is routinely recorded as PDF borehole logs — unstructured, human-readable documents that make automated analysis, cross-site comparison, and data sharing extremely difficult. Engineers spend significant time manually extracting data from these documents, a process that is slow, error-prone, and cannot scale.

## Solution Overview

This project provides a **fully automated pipeline** that:

1. **Extracts** structured data from raw PDF borehole logs using multi-strategy regex parsing  
2. **Validates** the extraction to reject non-borehole documents early  
3. **Maps** the extracted data to the DIGGS 2.6 schema hierarchy  
4. **Generates** valid, namespace-correct DIGGS 2.6 XML  
5. **Validates** the XML against the official DIGGS 2.6 XSD schema  
6. **Exports** the data to clean, styled Excel workbooks (per-borehole + cumulative master)  
7. **Visualizes** subsurface conditions as interactive 3D borehole grids and cross-section profiles

All steps run automatically when a user uploads a PDF through the web interface.

---

## Key Features

| Feature | Description |
|---|---|
| **Multi-Strategy PDF Extraction** | Handles reversed headers, inline `N=XX` SPT values, columnar blow counts (`8-16-31`), depth/elevation pairs, and free-text soil descriptions |
| **VDOT Graphical Fallback (Strategy D)** | When explicit stratigraphy is absent, falls back to N-value-driven soil classification (Loose / Medium Dense / Dense) |
| **Input Validation Gate** | Rejects non-borehole PDFs before they reach the mapping step — saves compute and prevents bad data |
| **DIGGS 2.6 Compliant XML** | Generates schema-valid XML with correct `gml`, `diggs`, and `witsml` namespaces, verified against the official XSD |
| **Automatic XSD Validation** | Every conversion is validated against the DIGGS 2.6 schema; results are written to log files and returned to the user |
| **Styled Excel Outputs** | Per-borehole 2-sheet workbooks (Borehole Info + Stratigraphy & SPT) and a cumulative master Excel database |
| **Interactive 3D Visualization** | Geosetta-inspired 3D borehole grids with color-coded cylinder segments, SPT N-value profile sidebars, and cross-section views |
| **GPS-Aware Positioning** | Converts real lat/lon coordinates to local East/North feet for accurate spatial placement of boreholes |
| **Volumetric Interpolation** | Interpolates soil types between 2+ boreholes using `scipy.interpolate.griddata` for filled geology volumes |
| **One-Click Deployment** | `run.bat` (Windows) or `run.sh` (Linux/macOS) handles venv creation, dependency install, and browser launch |

---

## System Architecture

The system follows a **linear pipeline architecture** with six decoupled stages:

```
  PDF Upload
      │
      ▼
 ┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 │ Extraction│───▶│  Validation  │───▶│   Schema     │───▶│     XML      │
 │ (pdfplumber)  │  (Viability  │    │   Mapping    │    │  Generation  │
 │           │    │   Gate)      │    │  (DIGGS 2.6) │    │   (lxml)     │
 └──────────┘    └──────────────┘    └──────────────┘    └──────┬───────┘
                                                                │
                         ┌──────────────────────────────────────┘
                         ▼
                  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
                  │    XSD       │───▶│    Excel     │───▶│     3D       │
                  │  Validation  │    │  Generation  │    │ Visualization│
                  │  (schema_26) │    │  (openpyxl)  │    │  (Plotly)    │
                  └──────────────┘    └──────────────┘    └──────────────┘
```

> For a detailed module-level breakdown with a Mermaid architecture diagram, see [**docs/System_Architecture.md**](docs/System_Architecture.md).

---

## Project Structure

```
├── app.py                  # Flask web application (routes, file handling, orchestration)
├── main.py                 # CLI entry point for single-PDF conversion
├── visualize_3d.py         # 3D Plotly visualization engine (cylinders, cross-sections, volumes)
├── requirements.txt        # Python dependencies
├── run.bat                 # One-click Windows launcher (venv + install + browser)
├── run.sh                  # One-click Linux/macOS launcher
├── .gitignore              # Excludes venv, outputs, and IDE files
│
├── src/                    # Core pipeline modules
│   ├── extraction.py       #   Multi-strategy PDF data extraction
│   ├── input_validator.py  #   Extraction viability gate (hard stop / soft warning)
│   ├── schema_mapper.py    #   Flat data → DIGGS 2.6 object hierarchy
│   ├── diggs_generator.py  #   DIGGS objects → namespace-correct XML
│   ├── validator.py        #   XSD schema validation against DIGGS 2.6
│   └── xml_to_excel.py     #   XML → styled Excel (per-borehole + master upsert)
│
├── schema_26/              # Official DIGGS 2.6 XSD schema files
├── data/                   # Input data files
├── Files/                  # PDF upload directory (uploads/ subfolder)
│
├── templates/              # Flask Jinja2 HTML templates
│   ├── base.html           #   Shared layout
│   ├── home.html           #   Landing page
│   ├── converter.html      #   Drag-and-drop PDF converter UI
│   ├── visualize.html      #   3D visualization viewer
│   ├── about.html          #   About page
│   └── contact.html        #   Contact page
│
├── static/                 # Frontend assets
│   ├── style.css           #   Application stylesheet
│   └── script.js           #   Client-side JavaScript
│
├── docs/                   # Documentation
│   ├── System_Architecture.md  # Detailed architecture & module breakdown
│   └── ABSTRACT_DRAFT.md       # Conference abstract draft
│
├── output/                 # Generated outputs (gitignored)
│   ├── xml/                #   DIGGS XML files
│   ├── excel/              #   Per-borehole + master_boreholes.xlsx
│   ├── plots/              #   3D visualization HTML files
│   └── logs/               #   Validation log files
│
└── intermediate/           # Intermediate parsed JSON data (gitignored)
```

---

## Quick Start

### Windows
```bash
run.bat
```

### Linux / macOS
```bash
chmod +x run.sh && ./run.sh
```

Both scripts will:
1. Create a Python virtual environment
2. Install all dependencies from `requirements.txt`
3. Launch the Flask web application
4. Open `http://127.0.0.1:5000` in your default browser

---

## Manual Setup

```bash
# 1. Clone the repository
git clone https://github.com/bandisumanth1811/PDF_to_3D_DIGGS_Student_Hackathon_2026.git
cd PDF_to_3D_DIGGS_Student_Hackathon_2026

# 2. Create and activate a virtual environment
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the application
python app.py
```

Then open: **http://localhost:5000**

---

## Web UI Usage

1. Navigate to the **Converter** page (`/converter`)
2. **Drag & drop** or browse for a borehole log PDF
3. The system automatically:
   - Extracts data from the PDF
   - Validates viability of the extracted data
   - Generates DIGGS 2.6 XML
   - Validates the XML against the official XSD schema
   - Produces a styled Excel workbook
   - Updates the master borehole database
   - Regenerates 3D visualizations
4. Results appear instantly — view the generated XML, validation status, and download files
5. Navigate to the **Visualize** page (`/visualize`) to explore 3D borehole grids and cross-sections
6. Click **← New Conversion** to convert another file without refreshing

---

## CLI Usage

Place a PDF in the `Files/` directory and run:

```bash
python main.py
```

Output XML is saved to `output/xml/<filename>.xml`. Validation results appear in the console.

---

## Supported PDF Formats

The extraction engine uses **four strategies** (A–D) and handles a wide variety of borehole log layouts:

| Pattern | Example |
|---|---|
| Reversed/mirrored column headers | `HTPED` → `DEPTH` |
| Inline SPT N-values | `N=47` |
| Three-set blow count format | `8-16-31` → N=47 |
| Refusal format | `50/2"` (refusal at 50 on 2 inches) |
| Depth/elevation stratigraphy | `0.0 / 659.6  BROWN SILTY CLAY` |
| Free-text soil descriptions | Plain paragraph descriptions without depth columns |
| N-value-driven classification (fallback) | SPT-based Loose / Medium Dense / Dense |
| Various header label styles | `PROJECT:`, `PROJ. No.`, `LOG OF BORING NO.`, `B-4`, etc. |

---

## Technology Stack

| Component | Technology |
|---|---|
| Web Framework | [Flask](https://flask.palletsprojects.com/) |
| PDF Parsing | [pdfplumber](https://github.com/jsvine/pdfplumber) |
| XML Generation & Validation | [lxml](https://lxml.de/) |
| Excel Generation | [openpyxl](https://openpyxl.readthedocs.io/) |
| 3D Visualization | [Plotly](https://plotly.com/python/) |
| Data Processing | [pandas](https://pandas.pydata.org/), [NumPy](https://numpy.org/) |
| Volumetric Interpolation | [SciPy](https://scipy.org/) |
| Language | Python 3.8+ |

---

## Future Work

- **New PDF Layouts** — Add new extraction strategies in `extraction.py` to support additional borehole log formats (the downstream pipeline remains unchanged)
- **New Data Types** — Support Water Level observations, CPT data, and laboratory test results by extending the Schema Mapper
- **Batch Processing** — Allow upload of multiple PDFs simultaneously for bulk conversion
- **Cloud Deployment** — Containerize with Docker for deployment on cloud platforms
- **API Endpoint** — REST API for programmatic access to the conversion pipeline

---

## Team

**SUNY Polytechnic Institute** — DIGGS Student Hackathon 2026

---

## License

This project was developed as part of the DIGGS Student Hackathon 2026.
