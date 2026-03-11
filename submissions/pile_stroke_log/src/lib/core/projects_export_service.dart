import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import 'saved_projects_logic.dart';

class ProjectsZipExportResult {
  final bool success;
  final String message;
  final String? filePath;

  const ProjectsZipExportResult({
    required this.success,
    required this.message,
    this.filePath,
  });
}

class ProjectsExportService {
  static Future<ProjectsZipExportResult> exportAllProjectsAsZip(
    List<SavedProject> projects,
  ) async {
    if (projects.isEmpty) {
      return const ProjectsZipExportResult(
        success: false,
        message: 'No projects available to export.',
      );
    }

    try {
      final archive = Archive();

      for (final project in projects) {
        final projectFolder = _safeSegment(project.name);
        archive.addFile(
          ArchiveFile.string(
            '$projectFolder/project_manifest.json',
            _projectManifestJson(project),
          ),
        );

        for (final file in project.files) {
          final archivePath = '$projectFolder/files/${file.name}';
          final sourceFile = File(file.absolutePath);
          if (await sourceFile.exists()) {
            final bytes = await sourceFile.readAsBytes();
            archive.addFile(
              ArchiveFile(
                archivePath,
                bytes.length,
                bytes,
              ),
            );
            continue;
          }

          // For mock/placeholder files, include useful metadata text so the zip is still complete.
          final placeholder = _placeholderContent(project: project, file: file);
          final bytes = utf8.encode(placeholder);
          archive.addFile(
            ArchiveFile(
              '$archivePath.txt',
              bytes.length,
              bytes,
            ),
          );
        }
      }

      final zipBytes = ZipEncoder().encode(archive);

      final exportDirectory = await _resolveExportDirectory();
      final fileName =
          'all_projects_${DateFormat('MMddyy_HHmm').format(DateTime.now())}.zip';
      final fullPath = await _nextAvailableFilePath(
        exportDirectory,
        fileName,
      );
      final outFile = File(fullPath);
      await outFile.writeAsBytes(zipBytes, flush: true);

      return ProjectsZipExportResult(
        success: true,
        message: 'Projects zip saved to: $fullPath',
        filePath: fullPath,
      );
    } catch (e) {
      return ProjectsZipExportResult(
        success: false,
        message: 'Failed to export projects zip: $e',
      );
    }
  }

  static Future<void> shareZipFile(String zipPath) async {
    final file = File(zipPath);
    if (!await file.exists()) {
      throw StateError('Zip file not found at $zipPath');
    }

    await Share.shareXFiles(
      [XFile(zipPath)],
      text: 'All projects export (.zip)',
      fileNameOverrides: [zipPath.split('/').last],
    );
  }

  static String _projectManifestJson(SavedProject project) {
    final map = {
      'id': project.id,
      'name': project.name,
      'location': project.location,
      'contractor': project.contractor,
      'inspector': project.inspector,
      'substructureElement': project.substructureElement,
      'pileNumber': project.pileNumber,
      'lastUpdated': project.lastUpdated.toIso8601String(),
      'directoryPath': project.directoryPath,
      'files': project.files
          .map(
            (file) => {
              'name': file.name,
              'extension': file.extension,
              'savedAt': file.savedAt.toIso8601String(),
              'sizeKb': file.sizeKb,
              'absolutePath': file.absolutePath,
            },
          )
          .toList(),
    };
    return const JsonEncoder.withIndent('  ').convert(map);
  }

  static String _placeholderContent({
    required SavedProject project,
    required SavedProjectFile file,
  }) {
    return [
      'Placeholder file for project zip export',
      'Project: ${project.name}',
      'File: ${file.name}',
      'Original path: ${file.absolutePath}',
      'Saved at: ${file.savedAt.toIso8601String()}',
      'Size (KB): ${file.sizeKb}',
      '',
      'This file did not exist on device at export time.',
    ].join('\n');
  }

  static String _safeSegment(String input) {
    final cleaned = input
        .trim()
        .replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceAll(RegExp(r'^_+|_+$'), '');
    return cleaned.isEmpty ? 'project' : cleaned;
  }

  static Future<String> _resolveExportDirectory() async {
    if (Platform.isAndroid) {
      final downloadsDir = Directory('/storage/emulated/0/Download');
      if (await downloadsDir.exists()) {
        final exportDir = Directory('${downloadsDir.path}/PileStrokeLog');
        if (!await exportDir.exists()) {
          await exportDir.create(recursive: true);
        }
        return exportDir.path;
      }

      final extDir = await getExternalStorageDirectory();
      final fallback =
          extDir?.path ?? (await getApplicationDocumentsDirectory()).path;
      final exportDir = Directory('$fallback/PileStrokeLog');
      if (!await exportDir.exists()) {
        await exportDir.create(recursive: true);
      }
      return exportDir.path;
    }

    final docsDir = await getApplicationDocumentsDirectory();
    final exportDir = Directory('${docsDir.path}/PileStrokeLog');
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
}
