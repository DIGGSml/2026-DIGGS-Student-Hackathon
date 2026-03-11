import 'dart:convert';
import 'dart:io';

import 'package:csv/csv.dart';

const _usSourceUrl =
    'https://raw.githubusercontent.com/ambaker1/aisc-csv/main/v15.0/Shapes-US.csv';
const _siSourceUrl =
    'https://raw.githubusercontent.com/ambaker1/aisc-csv/main/v15.0/Shapes-SI.csv';

class _SectionRow {
  final String label;
  final double area;
  final bool fromOnline;

  const _SectionRow({
    required this.label,
    required this.area,
    required this.fromOnline,
  });

  _SectionRow copyWith({
    String? label,
    double? area,
    bool? fromOnline,
  }) {
    return _SectionRow(
      label: label ?? this.label,
      area: area ?? this.area,
      fromOnline: fromOnline ?? this.fromOnline,
    );
  }
}

class _MergeTarget {
  final String path;
  final bool metric;
  final bool hPile;

  const _MergeTarget({
    required this.path,
    required this.metric,
    required this.hPile,
  });
}

Future<void> main() async {
  final targets = <_MergeTarget>[
    const _MergeTarget(
      path: 'assets/h_pile_sections.csv',
      metric: false,
      hPile: true,
    ),
    const _MergeTarget(
      path: 'assets/pipe_pile_sections.csv',
      metric: false,
      hPile: false,
    ),
    const _MergeTarget(
      path: 'assets/h_pile_sections_en_10365.csv',
      metric: true,
      hPile: true,
    ),
    const _MergeTarget(
      path: 'assets/pipe_pile_section_en_10219.csv',
      metric: true,
      hPile: false,
    ),
  ];

  stdout.writeln('Fetching source CSVs...');
  final usRows = await _fetchRemoteRows(Uri.parse(_usSourceUrl));
  final siRows = await _fetchRemoteRows(Uri.parse(_siSourceUrl));

  for (final target in targets) {
    final sourceRows = target.metric ? siRows : usRows;
    final extractedRows = target.hPile
        ? _extractHPileRows(sourceRows, metric: target.metric)
        : _extractPipePileRows(sourceRows, metric: target.metric);

    final summary = await _mergeIntoTarget(
      targetPath: target.path,
      onlineRows: extractedRows,
    );
    stdout.writeln(summary);
  }
}

Future<List<Map<String, String>>> _fetchRemoteRows(Uri uri) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(uri);
    final response = await request.close();
    if (response.statusCode != 200) {
      throw HttpException(
        'HTTP ${response.statusCode} while downloading $uri',
        uri: uri,
      );
    }

    final csvText = await utf8.decoder.bind(response).join();
    final csvData = const CsvToListConverter(
      shouldParseNumbers: false,
      eol: '\n',
    ).convert(csvText);

    if (csvData.isEmpty) return [];
    final headers = csvData.first.map((cell) => cell.toString()).toList();
    final rows = <Map<String, String>>[];

    for (var i = 1; i < csvData.length; i++) {
      final rawRow = csvData[i];
      if (rawRow.isEmpty) continue;

      final row = <String, String>{};
      for (var j = 0; j < headers.length && j < rawRow.length; j++) {
        row[headers[j]] = rawRow[j].toString().trim();
      }
      rows.add(row);
    }

    return rows;
  } finally {
    client.close(force: true);
  }
}

List<_SectionRow> _extractHPileRows(
  List<Map<String, String>> sourceRows, {
  required bool metric,
}) {
  final rows = <_SectionRow>[];

  for (final row in sourceRows) {
    final type = _upper(row['Type']);
    if (type != 'HP') continue;

    final labelRaw = _upper(row['AISC_Manual_Label']);
    if (!labelRaw.startsWith('HP') || !labelRaw.contains('X')) continue;

    final reduced = labelRaw.substring(2);
    final parts = reduced.split('X');
    if (parts.length != 2) continue;

    final first = _normalizeToken(parts[0]);
    final second = _normalizeToken(parts[1]);
    if (first.isEmpty || second.isEmpty) continue;

    final areaRaw = _parseDouble(row['A']);
    if (areaRaw == null) continue;
    final area = metric ? areaRaw / 100.0 : areaRaw;

    rows.add(
      _SectionRow(
        label: '$first x $second',
        area: area,
        fromOnline: true,
      ),
    );
  }

  return rows;
}

List<_SectionRow> _extractPipePileRows(
  List<Map<String, String>> sourceRows, {
  required bool metric,
}) {
  final rows = <_SectionRow>[];

  for (final row in sourceRows) {
    final type = _upper(row['Type']);
    final labelRaw = _upper(row['AISC_Manual_Label']);
    final isPipe = type == 'PIPE';
    final isRoundHss = type == 'HSS' &&
        labelRaw.startsWith('HSS') &&
        _countToken(labelRaw, 'X') == 1;

    if (!isPipe && !isRoundHss) continue;

    final diameter = _extractDiameter(row, labelRaw, isRoundHss);
    final thickness = _extractThickness(row, labelRaw, isRoundHss);
    final areaRaw = _parseDouble(row['A']);

    if (diameter == null || thickness == null || areaRaw == null) continue;

    final area = metric ? areaRaw / 100.0 : areaRaw;
    rows.add(
      _SectionRow(
        label:
            '${_formatDimension(diameter, metric: metric)} x ${_formatDimension(thickness, metric: metric)}',
        area: area,
        fromOnline: true,
      ),
    );
  }

  return rows;
}

double? _extractDiameter(
  Map<String, String> row,
  String label,
  bool isRoundHss,
) {
  if (isRoundHss) {
    final body = label.substring(3);
    final parts = body.split('X');
    if (parts.length == 2) {
      return _parseDouble(parts[0]);
    }
  }

  return _parseDouble(row['OD']) ?? _parseDouble(row['d']);
}

double? _extractThickness(
  Map<String, String> row,
  String label,
  bool isRoundHss,
) {
  if (isRoundHss) {
    final body = label.substring(3);
    final parts = body.split('X');
    if (parts.length == 2) {
      final parsed = _parseDouble(parts[1]);
      if (parsed != null) return parsed;
    }
  }

  return _parseDouble(row['tnom']) ??
      _parseDouble(row['t']) ??
      _parseDouble(row['tdes']);
}

Future<String> _mergeIntoTarget({
  required String targetPath,
  required List<_SectionRow> onlineRows,
}) async {
  final targetFile = File(targetPath);
  if (!targetFile.existsSync()) {
    throw StateError('Target CSV not found: $targetPath');
  }

  final existingCsv = await targetFile.readAsString();
  final existingRows = const CsvToListConverter(
    shouldParseNumbers: false,
    eol: '\n',
  ).convert(existingCsv);

  if (existingRows.isEmpty || existingRows.first.length < 2) {
    throw StateError('Unexpected CSV format in $targetPath');
  }

  final header0 = existingRows.first[0].toString().trim();
  final header1 = existingRows.first[1].toString().trim();

  final merged = <String, _SectionRow>{};

  for (var i = 1; i < existingRows.length; i++) {
    final row = existingRows[i];
    if (row.length < 2) continue;

    final label = row[0].toString().trim();
    final area = _parseDouble(row[1].toString());
    if (label.isEmpty || area == null) continue;

    merged[_normalizeLabel(label)] = _SectionRow(
      label: label,
      area: area,
      fromOnline: false,
    );
  }

  for (final row in onlineRows) {
    final key = _normalizeLabel(row.label);
    final existing = merged[key];
    if (existing == null) {
      merged[key] = row;
      continue;
    }

    merged[key] = existing.copyWith(
      area: row.area,
      fromOnline: true,
    );
  }

  final sortedRows = merged.values.toList()
    ..sort((a, b) => _compareSectionLabels(a.label, b.label));

  final outputRows = <List<String>>[
    [header0, header1],
    ...sortedRows.map(
      (row) => [row.label, _formatArea(row.area)],
    ),
  ];

  final csvOut = const ListToCsvConverter(eol: '\n').convert(outputRows);
  await targetFile.writeAsString('$csvOut\n');

  final existingCount = existingRows.length - 1;
  final onlineCount = onlineRows.length;
  final mergedCount = sortedRows.length;
  final onlinePresentCount = sortedRows.where((row) => row.fromOnline).length;

  return '$targetPath: existing=$existingCount online_candidates=$onlineCount merged=$mergedCount online_rows_after_merge=$onlinePresentCount';
}

int _compareSectionLabels(String a, String b) {
  final aNumbers = _extractNumericTokens(a);
  final bNumbers = _extractNumericTokens(b);

  final minLen =
      aNumbers.length < bNumbers.length ? aNumbers.length : bNumbers.length;
  for (var i = 0; i < minLen; i++) {
    final cmp = aNumbers[i].compareTo(bNumbers[i]);
    if (cmp != 0) return cmp;
  }

  if (aNumbers.length != bNumbers.length) {
    return aNumbers.length.compareTo(bNumbers.length);
  }

  return _normalizeLabel(a).compareTo(_normalizeLabel(b));
}

List<double> _extractNumericTokens(String input) {
  final matches = RegExp(r'\d+(?:\.\d+)?').allMatches(input);
  return matches
      .map((m) => double.tryParse(m.group(0) ?? ''))
      .whereType<double>()
      .toList();
}

double? _parseDouble(String? value) {
  if (value == null) return null;
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;

  final normalized = trimmed.replaceAll(',', '');
  final direct = double.tryParse(normalized);
  if (direct != null) return direct;

  if (normalized.contains('/')) {
    final hyphenParts = normalized.split('-');
    if (hyphenParts.length == 2) {
      final whole = double.tryParse(hyphenParts[0]);
      final fraction = _parseFraction(hyphenParts[1]);
      if (whole != null && fraction != null) return whole + fraction;
    }

    final fractionOnly = _parseFraction(normalized);
    if (fractionOnly != null) return fractionOnly;
  }

  return null;
}

double? _parseFraction(String value) {
  final parts = value.split('/');
  if (parts.length != 2) return null;
  final num = double.tryParse(parts[0]);
  final den = double.tryParse(parts[1]);
  if (num == null || den == null || den == 0) return null;
  return num / den;
}

String _formatDimension(double value, {required bool metric}) {
  if (metric) {
    return _trimTrailingZeros(value.toStringAsFixed(1));
  }

  if (value >= 10) {
    return value.toStringAsFixed(2);
  }
  return _trimTrailingZeros(value.toStringAsFixed(3));
}

String _formatArea(double value) {
  if (value >= 100) {
    return _trimTrailingZeros(value.toStringAsFixed(2));
  }
  if (value >= 10) {
    return _trimTrailingZeros(value.toStringAsFixed(3));
  }
  return _trimTrailingZeros(value.toStringAsFixed(4));
}

String _normalizeToken(String token) {
  final trimmed = token.trim();
  if (trimmed.isEmpty) return '';
  final parsed = _parseDouble(trimmed);
  if (parsed == null) return trimmed.toUpperCase();
  return _trimTrailingZeros(parsed.toStringAsFixed(3));
}

String _normalizeLabel(String input) {
  return _upper(input).replaceAll(RegExp(r'\s+'), '');
}

String _upper(String? value) => (value ?? '').trim().toUpperCase();

String _trimTrailingZeros(String value) {
  return value.replaceFirst(RegExp(r'\.?0+$'), '');
}

int _countToken(String source, String token) {
  if (token.isEmpty) return 0;
  return RegExp(token).allMatches(source).length;
}
