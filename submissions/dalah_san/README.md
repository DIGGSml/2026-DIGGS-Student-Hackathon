# Dalah San Beta Submission

## Team Members
- Irene Peng

## Challenge Theme
Direct Design/Interpretation: Develop tools that use DIGGS data for engineering analysis, design recommendations, or automated interpretations.

## Project Description
Dalah San is a geotechnical engineering web application that integrates DIGGS XML data into practical engineering workflows. The project focuses on transforming DIGGS-structured subsurface data into engineering calculations, design checks, and interpretation-ready outputs for field and design decisions.

Current completed modules used for submission:
- Liquefaction analysis
- Shallow foundation analysis
- Deep excavation safety checks (uplift and sand boil)

The application includes DIGGS import/processing, engineering parameter handling, calculation pipelines, and result visualization to support applied geotechnical practice.

## Technologies Used
- Python
- Flask
- NumPy
- Pandas
- Matplotlib
- OpenPyXL / XlsxWriter
- HTML/CSS/JavaScript
- DIGGS XML data model

## Setup Instructions
Dalah San is a web-based tool.
https://dalah-san.zeabur.app/

## Demo

<img width="1086" height="615" alt="welcome" src="https://github.com/user-attachments/assets/7f21c4bf-6bd9-405f-9565-80f16d5c3a37" />
<img width="1086" height="937" alt="Diggs_map" src="https://github.com/user-attachments/assets/eb43ba38-b4c7-49df-bcef-bc96a17a2724" />
<img width="1086" height="783" alt="shallow" src="https://github.com/user-attachments/assets/1c666333-c3f0-4ec8-b238-4e7f21bcc4de" />
<img width="1086" height="753" alt="uplift_sanboil" src="https://github.com/user-attachments/assets/54fac390-e79b-480b-96e7-f1f92558a7b9" />
<img width="979" height="801" alt="USGS_API" src="https://github.com/user-attachments/assets/60fd065a-9a16-4d33-bad1-dad1495a216c" />
<img width="601" height="754" alt="analysis_summary" src="https://github.com/user-attachments/assets/5d72d7e8-52b6-483f-a8ed-a1c38d2f5d97" />



## Repository Structure

<pre>
dalah_san/
├── README.md
├── LICENSE
├── docs/              # Documentation
├── demo/              # Demo materials
└── src/               # Application source
    ├── app.py         # Flask entry
    ├── routes/        # API routes (feedback, diggs, excavation, shallow, etc.)
    ├── templates/     # index.html (single-page UI)
    ├── static/        # CSS, JS, images, Leaflet
    ├── utils/         # Helpers
    └── tools/         # Preprocessing scripts
</pre>


