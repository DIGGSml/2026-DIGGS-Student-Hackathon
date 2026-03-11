# Pile Stroke Log

## Team Members
- Ronan Jones

## Challenge Theme(s)
- Data In/Data Out
- Direct Design/Interpretation
- Data Transformation

## Project Description
Pile Stroke Log is a Flutter application for digital pile driving field logging. It captures hammer blow activity in real time, tracks depth intervals, and exports structured outputs for downstream workflows. The app supports both inspector-friendly PDF reports and DIGGS XML exports for geotechnical data exchange.

## Key Features
- Real-time stroke/blow detection from microphone input with noise calibration.
- Guided setup for project, contractor, inspector, pile, and hammer details.
- Bearing-capacity helper workflow with calculated resistance output.
- Export pipeline for PDF and DIGGS XML.
- Saved Projects directory with local and Supabase-backed XML sync + retry support.
- Imperial/metric support and pile section catalogs from CSV datasets.

## DIGGS Usage
- Generates DIGGS XML output for pile driving records.
- Stores XML as project artifacts and syncs to cloud storage (Supabase) for retrieval.
- Keeps project metadata linked to exported DIGGS payloads.

## Technologies Used
- Flutter / Dart
- Riverpod
- Supabase (Auth, Postgres metadata, Storage)
- CSV-backed hammer and pile catalogs

## Repository Layout
- `src/`: Full application source code
- `docs/`: Supporting submission notes
- `demo/`: Demo screenshots and media

## Setup Instructions
1. Open `submissions/pile_stroke_log/src/`.
2. Install Flutter dependencies with `flutter pub get`.
3. Run with Supabase settings:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `AUTH_REDIRECT_URL` (optional; defaults documented in README)
4. Start app: `flutter run`

See `src/README.md` for runtime flags, sync setup, and troubleshooting.

## Demo
Screenshots and demo media are in `submissions/pile_stroke_log/demo/`.
