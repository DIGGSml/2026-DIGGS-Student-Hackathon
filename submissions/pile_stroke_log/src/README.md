# Pile Stroke Log

Pile Stroke Log is a Flutter field app for capturing pile driving activity, calculating stroke-driven metrics, and exporting inspector-ready records.

## Project Information

- Project type: Mobile-first pile driving log and reporting workflow
- Primary goal: Replace manual pile log sheets with structured digital capture
- Data outputs: PDF log reports and DIGGS XML for interoperability
- Platform: Flutter (Android, iOS, macOS, web/desktop scaffolded)
- Cloud integration: Supabase auth + XML project sync

## Key Features

- Real-time blow/stroke detection from microphone input with FIR filtering, dynamic thresholds, and calibration.
- Guided setup workflow for project metadata, contractor/inspector data, pile designation, and hammer selection.
- Hammer and pile catalogs loaded from CSV datasets, including imperial and metric steel section data.
- Live stroke log with per-depth intervals and expandable per-blow history.
- Bearing capacity helper screen with resistance estimate formula support.
- Export pipeline for shareable PDF logs and DIGGS XML payload generation.
- Saved Projects directory with sync status, retry handling, and ZIP export of project artifacts.
- Demo/presentation mode via runtime flags for non-auth workflows.

## Typical Workflow

1. Configure project, pile, and hammer details in Setup.
2. Start Stroke Log and record blows while monitoring live status.
3. Increment depth intervals and review blow counts and stroke values.
4. Run bearing capacity check (optional).
5. Export PDF + DIGGS XML and sync XML to Supabase.
6. Reopen projects later from Saved Projects and retry pending syncs if needed.

## Runtime Configuration

The app now defaults to secure auth behavior.

| Flag | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | Yes (normal mode) | empty | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes (normal mode) | empty | Supabase anon key |
| `AUTH_REDIRECT_URL` | No | `com.saximeter.saximeter://login-callback` | Deep link used in signup/confirm email callbacks |
| `DISABLE_AUTH` | No | `false` | When `true`, bypasses auth for demo/presentation workflows |
| `PRESENTATION_START` | No | empty | Demo start screen (`projects`, `directory`) when auth bypass is enabled |

### Normal Secure Run

```bash
flutter run \
  --dart-define=SUPABASE_URL=https://<project-ref>.supabase.co \
  --dart-define=SUPABASE_ANON_KEY=<your-anon-key> \
  --dart-define=AUTH_REDIRECT_URL=com.saximeter.saximeter://login-callback
```

### Demo / Presentation Run

```bash
flutter run \
  --dart-define=DISABLE_AUTH=true \
  --dart-define=PRESENTATION_START=projects
```

## Supabase Setup (Saved Projects + XML Sync)

### Auth URL Configuration (important)

In Supabase dashboard, open **Authentication -> URL Configuration**:

- Site URL: set to a real URL (not `http://localhost:3000`) or your app callback URL.
- Additional Redirect URLs: add
  - `com.saximeter.saximeter://login-callback`

If signup confirmation emails still open `localhost`, this setting is incorrect or missing.

Run migration SQL from:

`supabase/migrations/20260310_saved_projects.sql`

This migration creates:

- `saved_projects` (per-user project metadata)
- `saved_project_files` (per-user file metadata and sync status)
- private storage bucket `project-xml`
- RLS policies scoped to `auth.uid()`
- storage object policies restricted to path prefix `auth.uid()/...`

### Required Storage Path Convention

All uploaded XML files are written to:

`auth.uid()/project_key/<filename>.xml`

## Saved Projects Behavior

- Runtime source is hybrid local + Supabase metadata.
- DIGGS XML is generated and queued for cloud sync on every export action.
- XML sync is XML-only in this phase (PDF remains local/share-only).
- Pending syncs are retried on app start and when opening Saved Projects.
- Historical local files are not auto-backfilled; only newly exported files are queued.

## Export Output Paths

Local exports are user-scoped:

- Android: `/storage/emulated/0/Download/PileStrokeLog/<user-id-or-email>/`
- iOS/macOS: app Documents directory under `PileStrokeLog/<user-id-or-email>/`

## Steel Section Data Sync

Steel catalogs are merged from in-repo CSVs plus AISC-derived datasets:

- `https://raw.githubusercontent.com/ambaker1/aisc-csv/main/v15.0/Shapes-US.csv`
- `https://raw.githubusercontent.com/ambaker1/aisc-csv/main/v15.0/Shapes-SI.csv`

Run:

```bash
dart run tool/sync_steel_sections.dart
```

## Troubleshooting

### App shows “Supabase configuration required”

Provide both `SUPABASE_URL` and `SUPABASE_ANON_KEY` for normal mode, or set `DISABLE_AUTH=true` for demo mode.

### Exports succeed but project sync shows Pending

- Device was offline or Supabase auth/session was unavailable.
- Open Saved Projects and tap **Retry Sync**.

### Sync Failed status

- Check bucket/policy setup from migration.
- Confirm authenticated user and valid Supabase keys.
- Inspect latest error shown in the project details card.

### Export success vs partial success

- Success: local export completed and XML synced.
- Partial: local export completed but XML cloud sync is pending/retry.
- Failure: export did not complete; session data is retained.
