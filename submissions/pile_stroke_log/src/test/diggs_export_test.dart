import 'package:flutter_test/flutter_test.dart';
import 'package:pile_stroke_log/core/export_service.dart';
import 'package:pile_stroke_log/core/hammer_model.dart';
import 'package:pile_stroke_log/core/pile_session_logic.dart';
import 'package:pile_stroke_log/core/settings_logic.dart';

void main() {
  test('DIGGS export builds XML with expected sections', () {
    final now = DateTime.now();
    final session = SessionState(
      projectName: 'Doc Export Test',
      projectLocation: 'Kansas City, MO',
      projectLatitude: 39.099724,
      projectLongitude: -94.578331,
      contractorName: 'Test Contractor',
      inspectorName: 'Test Inspector',
      pileGroup: 'Pier A',
      pileNumber: '1',
      pileLength: '100',
      groundElevation: 100.0,
      startDepth: 0.0,
      logs: [
        PileLogEntry(
          depth: 2.0,
          blowCount: 11,
          timestamp: now,
          stroke: 2.8,
        ),
        PileLogEntry(
          depth: 1.0,
          blowCount: 9,
          timestamp: now.subtract(const Duration(minutes: 2)),
          stroke: 2.5,
        ),
      ],
    );

    final hammer = Hammer(
      make: 'Test',
      model: 'Demo-1',
      weight: 45.0,
      stroke: 8.0,
      power: 120.0,
    );

    final xml = ExportService.generateDiggsXmlPreview(
      session,
      hammer: hammer,
      unitSystem: UnitSystem.imperial,
    );

    expect(xml, contains('<Diggs xmlns="http://diggsml.org/schemas/3"'));
    expect(xml, contains('<samplingFeature>'));
    expect(xml, contains('<Sounding'));
    expect(xml, contains('<constructionActivity>'));
    expect(xml, contains('<PileDrivingActivity'));
    expect(xml, contains('<pileDrivingRecord>'));
    expect(xml, contains('<ResultSet>'));
  });
}
