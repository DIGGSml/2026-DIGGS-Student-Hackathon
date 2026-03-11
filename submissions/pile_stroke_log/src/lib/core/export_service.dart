import 'dart:io';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:share_plus/share_plus.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'pile_session_logic.dart';
import 'hammer_model.dart';
import 'pile_logic.dart';
import 'settings_logic.dart';

/// Result of a PDF export operation.
class ExportResult {
  final bool success;
  final String message;
  final String? filePath;

  ExportResult({required this.success, required this.message, this.filePath});
}

class ExportService {
  static const String _diggsNamespace = 'http://diggsml.org/schemas/3';
  static const String _diggsSchemaLocation =
      'http://diggsml.org/schemas/3 https://diggsml.org/schemas/3.0.0/Diggs.xsd';

  /// Generates the PDF bytes and filename without saving or sharing.
  static Future<({List<int> bytes, String fileName})> _buildPDF(
    SessionState session, {
    Hammer? hammer,
    int printFrequency = 1,
    PileSelectionState? pileState,
    String pileLength = '',
    UnitSystem unitSystem = UnitSystem.imperial,
  }) async {
    final String unitSuffix = unitSystem.unitSuffix;
    final pdf = pw.Document();

    // Prepare data based on frequency
    final List<List<String>> tableData = [];
    int cumulativeBlowCount = 0;

    // We want the logs in chronological order for processing
    final chronoLogs = session.logs.reversed.toList();

    // Track depth progression
    double currentIntervalStartDepth = session.startDepth;

    for (var log in chronoLogs) {
      if (printFrequency == 0) {
        // Summary Log: Just show the end depth of the interval
        tableData.add([
          log.depth.toStringAsFixed(2),
          log.blowCount.toString(),
          DateFormat('HH:mm:ss').format(log.timestamp),
          log.stroke == 0 ? "- - -" : log.stroke.toStringAsFixed(2),
        ]);
        // Update start depth for next iteration
        currentIntervalStartDepth = log.depth;
      } else {
        // Detailed Log: Calculate depth per blow
        // Calculate travel per blow for this interval
        final double intervalTravel = log.depth - currentIntervalStartDepth;
        final int blowCountInInterval = log.blows.length;
        final double travelPerBlow = blowCountInInterval > 0
            ? intervalTravel / blowCountInInterval
            : 0.0;

        for (int i = 0; i < log.blows.length; i++) {
          cumulativeBlowCount++;

          if (cumulativeBlowCount % printFrequency == 0) {
            final blow = log.blows[i];

            // Calculate depth at this specific blow
            final double rawDepth =
                currentIntervalStartDepth + (travelPerBlow * (i + 1));
            final double currentBlowDepth = (rawDepth * 100).round() / 100;

            tableData.add([
              cumulativeBlowCount.toString(),
              currentBlowDepth.toStringAsFixed(2),
              DateFormat('HH:mm:ss').format(blow.timestamp),
              (blow.strokeHeight == 0 ||
                      blow.strokeHeight > session.maxHammerStroke)
                  ? "- - -"
                  : blow.strokeHeight.toStringAsFixed(2),
            ]);
          }
        }
        // Update start depth for next iteration
        currentIntervalStartDepth = log.depth;
      }
    }

    final String tableHeader = printFrequency == 0
        ? 'Summary Log'
        : 'Detailed Log (Every $printFrequency Blows)';

    pdf.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        margin: const pw.EdgeInsets.all(32),
        build: (pw.Context context) {
          final isMetric = unitSystem == UnitSystem.metric;
          final double hWeight =
              (hammer?.weight ?? 0.0) * (isMetric ? 4.4482216153 : 1.0);
          final double hStroke =
              (hammer?.stroke ?? 0.0) * (isMetric ? 0.3048 : 1.0);
          final double hPower =
              (hammer?.power ?? 0.0) * (isMetric ? 1.355818 : 1.0);
          final String weightUnit = isMetric ? "kN" : "kips";
          final String powerUnit = isMetric ? "kNm" : "kip-ft";

          return [
            pw.Header(
              level: 0,
              child: pw.Row(
                mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
                children: [
                  pw.Text('Pile Stroke Log',
                      style: pw.TextStyle(
                          fontSize: 24, fontWeight: pw.FontWeight.bold)),
                  pw.Text(DateFormat('yyyy-MM-dd').format(DateTime.now())),
                ],
              ),
            ),
            pw.SizedBox(height: 10),

            // Project & Pile/Hammer Details Section
            pw.Container(
              padding: const pw.EdgeInsets.all(12),
              decoration: pw.BoxDecoration(
                border: pw.Border.all(color: PdfColors.grey400),
                borderRadius: const pw.BorderRadius.all(pw.Radius.circular(6)),
                color: PdfColors.grey50,
              ),
              child: pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.start,
                children: [
                  pw.Text("Project Details:",
                      style: pw.TextStyle(
                          fontWeight: pw.FontWeight.bold, fontSize: 12)),
                  pw.SizedBox(height: 4),
                  pw.Row(
                    children: [
                      pw.Expanded(
                          child: pw.Text('Project: ${session.projectName}')),
                      pw.Expanded(
                          child:
                              pw.Text('Location: ${session.projectLocation}')),
                    ],
                  ),
                  pw.Row(
                    children: [
                      pw.Expanded(
                        child: pw.Text(
                          'Coordinates: ${session.projectLatitude?.toStringAsFixed(6) ?? "N/A"}, ${session.projectLongitude?.toStringAsFixed(6) ?? "N/A"}',
                        ),
                      ),
                      pw.Expanded(child: pw.Text('')),
                    ],
                  ),
                  pw.Row(
                    children: [
                      pw.Expanded(
                          child:
                              pw.Text('Contractor: ${session.contractorName}')),
                      pw.Expanded(
                          child:
                              pw.Text('Inspector: ${session.inspectorName}')),
                    ],
                  ),
                  pw.Row(
                    children: [
                      pw.Expanded(
                          child: pw.Text(
                              'Substructure Element: ${session.pileGroup}')),
                      pw.Expanded(
                          child: pw.Text('Pile Number: ${session.pileNumber}')),
                    ],
                  ),
                  pw.Row(
                    children: [
                      pw.Expanded(
                          child: pw.Text(
                              'Ground Elevation: ${session.groundElevation} $unitSuffix')),
                      pw.Expanded(child: pw.Text('')),
                    ],
                  ),
                  if (pileState != null || hammer != null) ...[
                    pw.SizedBox(height: 12),
                    pw.Divider(color: PdfColors.grey400, thickness: 0.5),
                    pw.SizedBox(height: 8),

                    // Show Pile Details for both unit systems
                    if (pileState != null) ...[
                      pw.Text("Pile Details:",
                          style: pw.TextStyle(
                              fontWeight: pw.FontWeight.bold, fontSize: 12)),
                      pw.SizedBox(height: 4),
                      pw.Row(
                        children: [
                          pw.Expanded(
                              child: pw.Text(
                                  'Pile Material: ${pileState.selectedMaterial?.displayName ?? "N/A"}')),
                          pw.Expanded(
                              child: pw.Text(
                                  'Pile Type: ${pileState.selectedPileType?.displayName ?? "N/A"}')),
                        ],
                      ),
                      pw.Row(
                        children: [
                          pw.Expanded(
                              child: pw.Text(
                                  'Section Size: ${pileState.selectedSectionSize ?? "N/A"}')),
                          pw.Expanded(
                              child: pw.Text(
                                  'Cross-Section Area: ${pileState.selectedSection?.crossSectionArea.toStringAsFixed(2) ?? "N/A"} ${isMetric ? "sq. cm" : "sq. in."}')),
                        ],
                      ),
                      pw.Row(
                        children: [
                          pw.Expanded(
                              child: pw.Text(
                                  'Pile Length: ${pileLength.isNotEmpty ? "$pileLength $unitSuffix" : "N/A"}')),
                          pw.Expanded(child: pw.Text('')),
                        ],
                      ),
                      pw.SizedBox(height: 8),
                    ],

                    if (hammer != null) ...[
                      pw.Text("Hammer Details:",
                          style: pw.TextStyle(
                              fontWeight: pw.FontWeight.bold, fontSize: 12)),
                      pw.SizedBox(height: 4),
                      pw.Row(
                        children: [
                          pw.Expanded(
                              child: pw.Text(
                                  'Hammer: ${hammer.make} ${hammer.model}')),
                          pw.Expanded(
                              child: pw.Text(
                                  'Ram Weight: ${hWeight.toStringAsFixed(3)} $weightUnit')),
                        ],
                      ),
                      pw.Row(
                        children: [
                          pw.Expanded(
                              child: pw.Text(
                                  'Max Stroke: ${hStroke.toStringAsFixed(3)} $unitSuffix')),
                          pw.Expanded(
                              child: pw.Text(
                                  'Power: ${hPower.toStringAsFixed(3)} $powerUnit')),
                        ],
                      ),
                    ],
                  ],
                ],
              ),
            ),

            pw.SizedBox(height: 24),
            pw.Text(tableHeader,
                style:
                    pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold)),
            pw.SizedBox(height: 10),
            pw.TableHelper.fromTextArray(
              headers: printFrequency == 0
                  ? [
                      'Elevation ($unitSuffix)',
                      'Blow Count',
                      'Time',
                      'Avg Stroke ($unitSuffix)'
                    ]
                  : [
                      'Blow #',
                      'Depth ($unitSuffix)',
                      'Time',
                      'Stroke ($unitSuffix)'
                    ],
              data: tableData,
              headerStyle: pw.TextStyle(
                  fontWeight: pw.FontWeight.bold, color: PdfColors.white),
              headerDecoration:
                  const pw.BoxDecoration(color: PdfColors.blueGrey),
              cellAlignment: pw.Alignment.center,
              cellStyle: const pw.TextStyle(fontSize: 9),
              rowDecoration: const pw.BoxDecoration(
                border: pw.Border(
                    bottom:
                        pw.BorderSide(color: PdfColors.grey100, width: 0.5)),
              ),
            ),
          ];
        },
      ),
    );

    final String fileName = _generateFileName(session, "pdf");
    final bytes = await pdf.save();
    return (bytes: bytes, fileName: fileName);
  }

  /// Generates DIGGS XML text and filename without saving or sharing.
  static ({String xml, String fileName}) _buildDiggsXml(
    SessionState session, {
    Hammer? hammer,
    UnitSystem unitSystem = UnitSystem.imperial,
  }) {
    final now = DateTime.now();
    final dateOnly = DateFormat('yyyy-MM-dd').format(now);
    final depthUom = unitSystem.unitSuffix;

    final projectName = _safeText(session.projectName, 'DIGGS Test Project');
    final projectLocation = _safeText(session.projectLocation, 'Test Location');
    final pileNumber = _safeText(session.pileNumber, '1');

    final lat = session.projectLatitude ?? 39.099724;
    final lon = session.projectLongitude ?? -94.578331;

    final chronoLogs = session.logs.reversed.toList();
    final startDepth = session.startDepth;
    final endDepth = chronoLogs.isNotEmpty
        ? chronoLogs.last.depth
        : (startDepth + (unitSystem == UnitSystem.imperial ? 2.0 : 0.6));
    final totalDrivenLengthRaw = endDepth - startDepth;
    final totalDrivenLength = totalDrivenLengthRaw > 0
        ? totalDrivenLengthRaw
        : (unitSystem == UnitSystem.imperial ? 2.0 : 0.6);

    final firstTimestamp = chronoLogs.isNotEmpty
        ? chronoLogs.first.timestamp
        : now.subtract(const Duration(minutes: 15));
    final lastTimestamp =
        chronoLogs.isNotEmpty ? chronoLogs.last.timestamp : now;
    final activityStart =
        DateFormat('yyyy-MM-ddTHH:mm:ss').format(firstTimestamp);
    final activityEnd = DateFormat('yyyy-MM-ddTHH:mm:ss').format(lastTimestamp);

    final centerlineStartElevation =
        _toMetricLength(session.groundElevation, unitSystem);
    final centerlineEndElevation = centerlineStartElevation -
        _toMetricLength(totalDrivenLength, unitSystem);

    final dataRows = <String>[];
    final tipDepthValues = <double>[];
    var previousDepth = startDepth;

    for (final log in chronoLogs) {
      final penetration = log.depth - previousDepth;
      final strokeFallback = hammer?.stroke ?? 2.5;
      final stroke = log.stroke > 0 ? log.stroke : strokeFallback;
      final blowCount = log.blowCount > 0 ? log.blowCount : 1;
      final normalizedPenetration = penetration > 0
          ? penetration
          : (unitSystem == UnitSystem.imperial ? 1.0 : 0.3);

      dataRows.add(
        '$blowCount,${_formatNumber(normalizedPenetration, 2)},${_formatNumber(stroke, 2)}',
      );
      tipDepthValues.add(log.depth);
      previousDepth = log.depth;
    }

    if (dataRows.isEmpty) {
      dataRows.addAll([
        '8,${_formatNumber(unitSystem == UnitSystem.imperial ? 1.0 : 0.3, 2)},2.50',
        '10,${_formatNumber(unitSystem == UnitSystem.imperial ? 1.0 : 0.3, 2)},2.75',
      ]);
      tipDepthValues.addAll([
        startDepth + (unitSystem == UnitSystem.imperial ? 1.0 : 0.3),
        startDepth + (unitSystem == UnitSystem.imperial ? 2.0 : 0.6),
      ]);
    } else if (tipDepthValues.length == 1) {
      tipDepthValues.insert(0, startDepth);
    }

    final lastBlowCount = chronoLogs.isNotEmpty
        ? (chronoLogs.last.blowCount > 0 ? chronoLogs.last.blowCount : 8)
        : 8;
    final avgStroke = chronoLogs.isNotEmpty
        ? (chronoLogs.last.stroke > 0 ? chronoLogs.last.stroke : 2.5)
        : 2.5;
    final lastPenetration = chronoLogs.length >= 2
        ? (chronoLogs.last.depth - chronoLogs[chronoLogs.length - 2].depth)
            .abs()
        : (unitSystem == UnitSystem.imperial ? 1.0 : 0.3);

    final projectId = _toGmlId('project_$projectName', 'project_1');
    final soundingId = _toGmlId('sounding_$pileNumber', 'sounding_1');
    final centerLineId = _toGmlId('centerline_$pileNumber', 'centerline_1');
    final refPointId = _toGmlId('reference_$pileNumber', 'reference_1');
    final lsrsId = _toGmlId('lsrs_$pileNumber', 'lsrs_1');
    final lrmId = _toGmlId('lrm_$pileNumber', 'lrm_1');
    final activityId = _toGmlId('activity_$pileNumber', 'activity_1');
    final envId = _toGmlId('environment_$pileNumber', 'environment_1');
    final actTimeId = _toGmlId('activity_time_$pileNumber', 'activity_time_1');
    final hammerId = _toGmlId('hammer_$pileNumber', 'hammer_1');
    final recordId = _toGmlId('record_$pileNumber', 'record_1');
    final tipLocationId =
        _toGmlId('pile_tip_location_$pileNumber', 'pile_tip_location_1');
    final resultParamId =
        _toGmlId('result_params_$pileNumber', 'result_params_1');
    final diggsId = _toGmlId('diggs_$pileNumber', 'diggs_1');
    final documentInfoId =
        _toGmlId('document_info_$pileNumber', 'document_info_1');

    final hammerMake = _safeText(hammer?.make, 'Test');
    final hammerModel = _safeText(hammer?.model, 'Model-1');
    const hammerType = 'diesel';
    final hammerWeight = hammer?.weight ?? 45.0;
    final hammerStroke = hammer?.stroke ?? 8.0;
    final hammerWeightConverted = unitSystem == UnitSystem.imperial
        ? hammerWeight
        : hammerWeight * 4.4482216153;
    final hammerWeightUom = unitSystem == UnitSystem.imperial ? 'klbf' : 'kN';

    final tipPosList =
        tipDepthValues.map((value) => _formatNumber(value, 2)).join(' ');
    final resultRowsText = dataRows.join('\n                                ');

    final xml = '''<?xml version="1.0" encoding="UTF-8"?>
<Diggs xmlns="$_diggsNamespace"
    xmlns:diggs="$_diggsNamespace"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xlink="http://www.w3.org/1999/xlink"
    xmlns:gml="http://www.opengis.net/gml/3.2"
    xmlns:glr="http://www.opengis.net/gml/3.3/lr"
    xsi:schemaLocation="$_diggsSchemaLocation"
    gml:id="$diggsId">
    <documentInformation>
        <DocumentInformation gml:id="$documentInfoId">
            <creationDate>$dateOnly</creationDate>
        </DocumentInformation>
    </documentInformation>

    <project>
        <Project gml:id="$projectId">
            <gml:name>${_xmlEscape(projectName)}</gml:name>
            <gml:name codeSpace="Saximeter">${_xmlEscape(projectLocation)}</gml:name>
        </Project>
    </project>

    <samplingFeature>
        <Sounding gml:id="$soundingId">
            <gml:name>${_xmlEscape(pileNumber)}</gml:name>
            <projectRef xlink:href="#$projectId"/>
            <referencePoint>
                <PointLocation gml:id="$refPointId"
                    srsName="http://www.opengis.net/def/crs/EPSG/0/4979"
                    srsDimension="3">
                    <gml:pos>${_formatNumber(lat, 6)} ${_formatNumber(lon, 6)} ${_formatNumber(centerlineStartElevation, 3)}</gml:pos>
                </PointLocation>
            </referencePoint>
            <centerLine>
                <LinearExtent gml:id="$centerLineId"
                    srsName="http://www.opengis.net/def/crs/EPSG/0/4979"
                    srsDimension="3">
                    <gml:posList>${_formatNumber(lat, 6)} ${_formatNumber(lon, 6)} ${_formatNumber(centerlineStartElevation, 3)} ${_formatNumber(lat, 6)} ${_formatNumber(lon, 6)} ${_formatNumber(centerlineEndElevation, 3)}</gml:posList>
                </LinearExtent>
            </centerLine>
            <linearReferencing>
                <LinearSpatialReferenceSystem gml:id="$lsrsId">
                    <gml:identifier codeSpace="SAXIMETER">SAX-$lsrsId</gml:identifier>
                    <glr:linearElement xlink:href="#$centerLineId"/>
                    <glr:lrm>
                        <glr:LinearReferencingMethod gml:id="$lrmId">
                            <glr:name>chainage</glr:name>
                            <glr:type>absolute</glr:type>
                            <glr:units>$depthUom</glr:units>
                        </glr:LinearReferencingMethod>
                    </glr:lrm>
                </LinearSpatialReferenceSystem>
            </linearReferencing>
            <totalMeasuredDepth uom="$depthUom">${_formatNumber(totalDrivenLength, 2)}</totalMeasuredDepth>
        </Sounding>
    </samplingFeature>

    <constructionActivity>
        <PileDrivingActivity gml:id="$activityId">
            <investigationTarget>Deep Foundation</investigationTarget>
            <projectRef xlink:href="#$projectId"/>
            <samplingFeatureRef xlink:href="#$soundingId"/>
            <constructionEnvironment>
                <Environment gml:id="$envId">
                    <weather>sunny</weather>
                </Environment>
            </constructionEnvironment>
            <activityDateTime>
                <TimeInterval gml:id="$actTimeId">
                    <start>$activityStart</start>
                    <end>$activityEnd</end>
                </TimeInterval>
            </activityDateTime>
            <totalDrivenLength uom="$depthUom">${_formatNumber(totalDrivenLength, 2)}</totalDrivenLength>
            <hammer>
                <PileDriveHammer gml:id="$hammerId">
                    <make>${_xmlEscape(hammerMake)}</make>
                    <modelNumber>${_xmlEscape(hammerModel)}</modelNumber>
                    <hammerType>$hammerType</hammerType>
                    <ramWeight uom="$hammerWeightUom">${_formatNumber(hammerWeightConverted, 3)}</ramWeight>
                    <ratedStroke uom="$depthUom">${_formatNumber(hammerStroke, 2)}</ratedStroke>
                    <blowsPerMinuteMin>35</blowsPerMinuteMin>
                    <blowsPerMinuteMax>55</blowsPerMinuteMax>
                </PileDriveHammer>
            </hammer>
            <lastBlowsData>
                <LastBlowsData>
                    <lastBlowsDistance uom="$depthUom">${_formatNumber(lastPenetration, 2)}</lastBlowsDistance>
                    <blowCount>$lastBlowCount</blowCount>
                    <averageStrokeLength uom="$depthUom">${_formatNumber(avgStroke, 2)}</averageStrokeLength>
                </LastBlowsData>
            </lastBlowsData>
            <pileDrivingRecord>
                <PileDrivingRecord gml:id="$recordId">
                    <pileTipLocation>
                        <MultiPointLocation gml:id="$tipLocationId">
                            <gml:posList srsName="#$lsrsId" srsDimension="1">$tipPosList</gml:posList>
                        </MultiPointLocation>
                    </pileTipLocation>
                    <pileDrivingRecordResults>
                        <ResultSet>
                            <parameters>
                                <PropertyParameters gml:id="$resultParamId">
                                    <properties>
                                        <Property index="1" gml:id="${resultParamId}_p1">
                                            <typeData>integer</typeData>
                                            <propertyClass codeSpace="https://diggsml.org/def/codes/DIGGS/0.1/pil_properties.xml#blow_count">Blow Count</propertyClass>
                                        </Property>
                                        <Property index="2" gml:id="${resultParamId}_p2">
                                            <typeData>double</typeData>
                                            <propertyClass codeSpace="https://diggsml.org/def/codes/DIGGS/0.1/pil_properties.xml#pen_increment">Penetration Increment</propertyClass>
                                            <uom>$depthUom</uom>
                                        </Property>
                                        <Property index="3" gml:id="${resultParamId}_p3">
                                            <typeData>double</typeData>
                                            <propertyClass codeSpace="https://diggsml.org/def/codes/DIGGS/0.1/pil_properties.xml#stk_avg">Stroke Length</propertyClass>
                                            <uom>$depthUom</uom>
                                        </Property>
                                    </properties>
                                </PropertyParameters>
                            </parameters>
                            <dataValues>
                                $resultRowsText
                            </dataValues>
                        </ResultSet>
                    </pileDrivingRecordResults>
                    <recordType>saximeter</recordType>
                    <hammerRef xlink:href="#$hammerId"/>
                    <driveInterval>
                        <LinearExtent gml:id="${recordId}_interval">
                            <gml:posList srsName="#$lsrsId" srsDimension="1">${_formatNumber(startDepth, 2)} ${_formatNumber(endDepth, 2)}</gml:posList>
                        </LinearExtent>
                    </driveInterval>
                    <initiationTime>$activityStart</initiationTime>
                    <endTime>$activityEnd</endTime>
                </PileDrivingRecord>
            </pileDrivingRecord>
        </PileDrivingActivity>
    </constructionActivity>
</Diggs>
''';

    final fileName = _generateFileName(session, 'xml');
    return (xml: xml, fileName: fileName);
  }

  /// Save the PDF directly to the device's Downloads folder.
  /// Returns an [ExportResult] with success/failure info and the saved path.
  static Future<ExportResult> saveToDevice(
    SessionState session, {
    Hammer? hammer,
    int printFrequency = 1,
    PileSelectionState? pileState,
    String pileLength = '',
    UnitSystem unitSystem = UnitSystem.imperial,
  }) async {
    try {
      final result = await _buildPDF(
        session,
        hammer: hammer,
        printFrequency: printFrequency,
        pileState: pileState,
        pileLength: pileLength,
        unitSystem: unitSystem,
      );

      final savePath = await _resolveExportDirectory(
        userFolderToken: _currentUserExportFolderToken(),
      );
      final fullPath = await _nextAvailableFilePath(savePath, result.fileName);

      final file = File(fullPath);
      await file.writeAsBytes(result.bytes);

      return ExportResult(
        success: true,
        message: 'Saved to device: $fullPath',
        filePath: fullPath,
      );
    } catch (e) {
      return ExportResult(
        success: false,
        message: 'Failed to save: $e',
      );
    }
  }

  /// Save DIGGS XML directly to the device's Downloads folder.
  static Future<ExportResult> saveDiggsXmlToDevice(
    SessionState session, {
    Hammer? hammer,
    UnitSystem unitSystem = UnitSystem.imperial,
  }) async {
    try {
      final result = _buildDiggsXml(
        session,
        hammer: hammer,
        unitSystem: unitSystem,
      );

      final savePath = await _resolveExportDirectory(
        userFolderToken: _currentUserExportFolderToken(),
      );
      final fullPath = await _nextAvailableFilePath(savePath, result.fileName);
      final file = File(fullPath);
      await file.writeAsString(result.xml);

      return ExportResult(
        success: true,
        message: 'DIGGS XML saved to device: $fullPath',
        filePath: fullPath,
      );
    } catch (e) {
      return ExportResult(
        success: false,
        message: 'Failed to save DIGGS XML: $e',
      );
    }
  }

  /// Share the PDF via the system share sheet, with the proper filename preserved.
  static Future<ExportResult> sharePDF(
    SessionState session, {
    Hammer? hammer,
    int printFrequency = 1,
    PileSelectionState? pileState,
    String pileLength = '',
    UnitSystem unitSystem = UnitSystem.imperial,
  }) async {
    try {
      final result = await _buildPDF(
        session,
        hammer: hammer,
        printFrequency: printFrequency,
        pileState: pileState,
        pileLength: pileLength,
        unitSystem: unitSystem,
      );

      final directory = await getTemporaryDirectory();
      final file = File('${directory.path}/${result.fileName}');
      await file.writeAsBytes(result.bytes);

      await Share.shareXFiles(
        [XFile(file.path)],
        text: 'Pile Stroke Log - PDF',
        fileNameOverrides: [result.fileName],
      );

      return ExportResult(
        success: true,
        message: 'PDF shared successfully.',
        filePath: file.path,
      );
    } catch (e) {
      return ExportResult(
        success: false,
        message: 'Failed to share PDF: $e',
      );
    }
  }

  /// Share DIGGS XML via the system share sheet.
  static Future<ExportResult> shareDiggsXml(
    SessionState session, {
    Hammer? hammer,
    UnitSystem unitSystem = UnitSystem.imperial,
  }) async {
    try {
      final result = _buildDiggsXml(
        session,
        hammer: hammer,
        unitSystem: unitSystem,
      );
      final directory = await getTemporaryDirectory();
      final file = File('${directory.path}/${result.fileName}');
      await file.writeAsString(result.xml);

      await Share.shareXFiles(
        [XFile(file.path)],
        text: 'Pile Stroke Log - DIGGS XML',
        fileNameOverrides: [result.fileName],
      );

      return ExportResult(
        success: true,
        message: 'DIGGS XML shared successfully.',
        filePath: file.path,
      );
    } catch (e) {
      return ExportResult(
        success: false,
        message: 'Failed to share DIGGS XML: $e',
      );
    }
  }

  /// Returns DIGGS XML text for local validation/testing workflows.
  static String generateDiggsXmlPreview(
    SessionState session, {
    Hammer? hammer,
    UnitSystem unitSystem = UnitSystem.imperial,
  }) {
    return _buildDiggsXml(
      session,
      hammer: hammer,
      unitSystem: unitSystem,
    ).xml;
  }

  /// Legacy method for backward compatibility — now delegates to sharePDF.
  static Future<void> exportToPDF(
    SessionState session, {
    Hammer? hammer,
    int printFrequency = 1,
    PileSelectionState? pileState,
    String pileLength = '',
    UnitSystem unitSystem = UnitSystem.imperial,
  }) async {
    await sharePDF(
      session,
      hammer: hammer,
      printFrequency: printFrequency,
      pileState: pileState,
      pileLength: pileLength,
      unitSystem: unitSystem,
    );
  }

  static String _generateFileName(SessionState session, String extension) {
    String project =
        session.projectName.replaceAll(RegExp(r'[^\w\s-]'), '').trim();
    final String group =
        session.pileGroup.replaceAll(RegExp(r'[^\w\s-]'), '').trim();
    String number =
        session.pileNumber.replaceAll(RegExp(r'[^\w\s-]'), '').trim();

    // Fallback if inputs are empty
    if (project.isEmpty) project = "Project";
    if (number.isEmpty) number = "Pile";

    final String timestamp = DateFormat('MMddyy_HHmm').format(DateTime.now());

    final String baseName =
        "${project}_${group}_$number".replaceAll(RegExp(r'\s+'), '_');
    return "${baseName}_$timestamp.$extension";
  }

  static Future<String> _resolveExportDirectory({
    required String userFolderToken,
  }) async {
    final safeUserToken = _safePathSegment(userFolderToken);
    String basePath;

    if (Platform.isAndroid) {
      final downloadsDir = Directory('/storage/emulated/0/Download');
      if (await downloadsDir.exists()) {
        basePath = downloadsDir.path;
      } else {
        final extDir = await getExternalStorageDirectory();
        basePath =
            extDir?.path ?? (await getApplicationDocumentsDirectory()).path;
      }
    } else {
      final docsDir = await getApplicationDocumentsDirectory();
      basePath = docsDir.path;
    }

    final exportDir = Directory('$basePath/PileStrokeLog/$safeUserToken');
    if (!await exportDir.exists()) {
      await exportDir.create(recursive: true);
    }
    return exportDir.path;
  }

  static Future<String> _nextAvailableFilePath(
    String directoryPath,
    String fileName,
  ) async {
    var fullPath = '$directoryPath/$fileName';
    var counter = 1;

    final lastDot = fileName.lastIndexOf('.');
    final baseName = lastDot >= 0 ? fileName.substring(0, lastDot) : fileName;
    final extension = lastDot >= 0 ? fileName.substring(lastDot) : '';

    while (await File(fullPath).exists()) {
      fullPath = '$directoryPath/${baseName}_($counter)$extension';
      counter++;
    }
    return fullPath;
  }

  static String _safeText(String? value, String fallback) {
    final trimmed = value?.trim() ?? '';
    return trimmed.isEmpty ? fallback : trimmed;
  }

  static String _toGmlId(String candidate, String fallback) {
    final sanitized = candidate
        .trim()
        .replaceAll(RegExp(r'[^A-Za-z0-9_.-]'), '_')
        .replaceAll(RegExp(r'_+'), '_');
    if (sanitized.isEmpty) return fallback;
    final startsWithValid = RegExp(r'[A-Za-z_]').hasMatch(sanitized[0]);
    return startsWithValid ? sanitized : 'id_$sanitized';
  }

  static String _xmlEscape(String input) {
    return input
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
  }

  static double _toMetricLength(double value, UnitSystem unitSystem) {
    return unitSystem == UnitSystem.imperial ? value * 0.3048 : value;
  }

  static String _formatNumber(double value, int decimals) {
    if (!value.isFinite) return '0';
    return value.toStringAsFixed(decimals);
  }

  static String _currentUserExportFolderToken() {
    try {
      final user = Supabase.instance.client.auth.currentUser;
      if (user == null) return 'guest';
      final email = user.email?.trim();
      if (email != null && email.isNotEmpty) {
        return email;
      }
      return user.id;
    } catch (_) {
      return 'guest';
    }
  }

  static String _safePathSegment(String input) {
    final cleaned = input
        .trim()
        .replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceAll(RegExp(r'^_+|_+$'), '');
    return cleaned.isEmpty ? 'user' : cleaned;
  }
}
