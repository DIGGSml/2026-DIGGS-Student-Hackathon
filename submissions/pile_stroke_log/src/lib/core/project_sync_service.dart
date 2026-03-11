import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart' as supa;

import 'pile_session_logic.dart';
import 'project_key_utils.dart';

class ProjectSyncResult {
  final bool synced;
  final bool pending;
  final String message;
  final String? error;

  const ProjectSyncResult({
    required this.synced,
    required this.pending,
    required this.message,
    this.error,
  });

  bool get isSuccess => synced || pending;
}

class PendingProjectSyncEntry {
  final String projectKey;
  final String projectName;
  final String location;
  final String contractor;
  final String inspector;
  final String substructureElement;
  final String pileNumber;
  final String localPath;
  final String fileName;
  final int sizeBytes;
  final DateTime savedAt;
  final int uploadAttempts;
  final String? lastError;

  const PendingProjectSyncEntry({
    required this.projectKey,
    required this.projectName,
    required this.location,
    required this.contractor,
    required this.inspector,
    required this.substructureElement,
    required this.pileNumber,
    required this.localPath,
    required this.fileName,
    required this.sizeBytes,
    required this.savedAt,
    this.uploadAttempts = 0,
    this.lastError,
  });

  PendingProjectSyncEntry copyWith({
    int? uploadAttempts,
    String? lastError,
  }) {
    return PendingProjectSyncEntry(
      projectKey: projectKey,
      projectName: projectName,
      location: location,
      contractor: contractor,
      inspector: inspector,
      substructureElement: substructureElement,
      pileNumber: pileNumber,
      localPath: localPath,
      fileName: fileName,
      sizeBytes: sizeBytes,
      savedAt: savedAt,
      uploadAttempts: uploadAttempts ?? this.uploadAttempts,
      lastError: lastError ?? this.lastError,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'project_key': projectKey,
      'project_name': projectName,
      'location': location,
      'contractor': contractor,
      'inspector': inspector,
      'substructure_element': substructureElement,
      'pile_number': pileNumber,
      'local_path': localPath,
      'file_name': fileName,
      'size_bytes': sizeBytes,
      'saved_at': savedAt.toIso8601String(),
      'upload_attempts': uploadAttempts,
      'last_error': lastError,
    };
  }

  factory PendingProjectSyncEntry.fromJson(Map<String, dynamic> json) {
    return PendingProjectSyncEntry(
      projectKey: (json['project_key'] as String?)?.trim().isNotEmpty == true
          ? json['project_key'] as String
          : 'project',
      projectName: json['project_name'] as String? ?? 'Project',
      location: json['location'] as String? ?? 'Unknown location',
      contractor: json['contractor'] as String? ?? 'Unknown contractor',
      inspector: json['inspector'] as String? ?? 'Unknown inspector',
      substructureElement:
          json['substructure_element'] as String? ?? 'Unknown element',
      pileNumber: json['pile_number'] as String? ?? '-',
      localPath: json['local_path'] as String? ?? '',
      fileName: json['file_name'] as String? ?? 'export.xml',
      sizeBytes: (json['size_bytes'] as num?)?.toInt() ?? 0,
      savedAt: DateTime.tryParse(json['saved_at'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      uploadAttempts: (json['upload_attempts'] as num?)?.toInt() ?? 0,
      lastError: json['last_error'] as String?,
    );
  }
}

class ProjectSyncService {
  static const String _pendingSyncKey = 'project_sync_pending_entries_v1';
  static const String _bucketName = 'project-xml';

  static Future<ProjectSyncResult> syncExportedXml({
    required SessionState session,
    required String xmlFilePath,
  }) async {
    final xmlFile = File(xmlFilePath);
    if (!await xmlFile.exists()) {
      return const ProjectSyncResult(
        synced: false,
        pending: false,
        message: 'XML sync skipped: XML file was not found on device.',
        error: 'missing_xml_file',
      );
    }

    final stats = await xmlFile.stat();
    final fileName = xmlFilePath.split('/').last;
    final entry = PendingProjectSyncEntry(
      projectKey: buildProjectKey(
        projectName: session.projectName,
        substructureElement: session.pileGroup,
        pileNumber: session.pileNumber,
      ),
      projectName: session.projectName.trim().isEmpty
          ? 'Project'
          : session.projectName.trim(),
      location: session.projectLocation.trim().isEmpty
          ? 'Unknown location'
          : session.projectLocation.trim(),
      contractor: session.contractorName.trim().isEmpty
          ? 'Unknown contractor'
          : session.contractorName.trim(),
      inspector: session.inspectorName.trim().isEmpty
          ? 'Unknown inspector'
          : session.inspectorName.trim(),
      substructureElement: session.pileGroup.trim().isEmpty
          ? 'Unknown element'
          : session.pileGroup.trim(),
      pileNumber:
          session.pileNumber.trim().isEmpty ? '-' : session.pileNumber.trim(),
      localPath: xmlFilePath,
      fileName: fileName,
      sizeBytes: stats.size,
      savedAt: stats.modified,
    );

    final uploadError = await _tryUploadEntry(entry);
    if (uploadError == null) {
      await _removePendingByLocalPath(entry.localPath);
      return const ProjectSyncResult(
        synced: true,
        pending: false,
        message: 'XML synced to Supabase successfully.',
      );
    }

    await _upsertPendingEntry(
      entry.copyWith(
        uploadAttempts: entry.uploadAttempts + 1,
        lastError: uploadError,
      ),
    );

    return ProjectSyncResult(
      synced: false,
      pending: true,
      message: 'XML saved locally. Cloud sync pending retry.',
      error: uploadError,
    );
  }

  static Future<ProjectSyncResult> syncPendingUploads() async {
    final queue = await loadPendingUploads();
    if (queue.isEmpty) {
      return const ProjectSyncResult(
        synced: true,
        pending: false,
        message: 'No pending XML uploads.',
      );
    }

    final remaining = <PendingProjectSyncEntry>[];
    var syncedCount = 0;

    for (final entry in queue) {
      final uploadError = await _tryUploadEntry(entry);
      if (uploadError == null) {
        syncedCount++;
        continue;
      }

      remaining.add(
        entry.copyWith(
          uploadAttempts: entry.uploadAttempts + 1,
          lastError: uploadError,
        ),
      );
    }

    await _savePendingUploads(remaining);

    if (remaining.isEmpty) {
      return ProjectSyncResult(
        synced: true,
        pending: false,
        message: 'Synced $syncedCount pending XML upload(s).',
      );
    }

    return ProjectSyncResult(
      synced: syncedCount > 0,
      pending: true,
      message:
          'Synced $syncedCount pending XML upload(s). ${remaining.length} still pending.',
      error: remaining.first.lastError,
    );
  }

  static Future<List<PendingProjectSyncEntry>> loadPendingUploads() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_pendingSyncKey);
    if (raw == null || raw.isEmpty) {
      return [];
    }

    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) {
        return [];
      }
      return decoded
          .whereType<Map<String, dynamic>>()
          .map(PendingProjectSyncEntry.fromJson)
          .where((entry) => entry.localPath.isNotEmpty)
          .toList();
    } catch (e) {
      debugPrint('Failed to decode pending sync queue: $e');
      return [];
    }
  }

  static Future<Map<String, String>> pendingStatusByLocalPath() async {
    final queue = await loadPendingUploads();
    final statusByPath = <String, String>{};
    for (final entry in queue) {
      statusByPath[entry.localPath] =
          entry.uploadAttempts >= 3 ? 'failed' : 'pending';
    }
    return statusByPath;
  }

  static Future<void> _savePendingUploads(
    List<PendingProjectSyncEntry> entries,
  ) async {
    final prefs = await SharedPreferences.getInstance();
    final encoded = jsonEncode(entries.map((e) => e.toJson()).toList());
    await prefs.setString(_pendingSyncKey, encoded);
  }

  static Future<void> _upsertPendingEntry(PendingProjectSyncEntry entry) async {
    final existing = await loadPendingUploads();
    final index = existing.indexWhere((e) => e.localPath == entry.localPath);
    if (index >= 0) {
      existing[index] = entry;
    } else {
      existing.add(entry);
    }
    await _savePendingUploads(existing);
  }

  static Future<void> _removePendingByLocalPath(String localPath) async {
    final existing = await loadPendingUploads();
    final filtered = existing.where((e) => e.localPath != localPath).toList();
    await _savePendingUploads(filtered);
  }

  static Future<String?> _tryUploadEntry(PendingProjectSyncEntry entry) async {
    try {
      final client = _tryGetClient();
      if (client == null) {
        return 'Supabase is not configured.';
      }

      final user = client.auth.currentUser;
      if (user == null) {
        return 'User must be authenticated to sync projects.';
      }

      final xmlFile = File(entry.localPath);
      if (!await xmlFile.exists()) {
        return 'Local XML file no longer exists.';
      }

      final bytes = await xmlFile.readAsBytes();
      final storagePath = '${user.id}/${entry.projectKey}/${entry.fileName}';

      await client.storage.from(_bucketName).uploadBinary(
            storagePath,
            bytes,
            fileOptions: const supa.FileOptions(
              upsert: true,
              contentType: 'application/xml',
            ),
          );

      await client.from('saved_projects').upsert(
        {
          'user_id': user.id,
          'project_key': entry.projectKey,
          'name': entry.projectName,
          'location': entry.location,
          'contractor': entry.contractor,
          'inspector': entry.inspector,
          'substructure_element': entry.substructureElement,
          'pile_number': entry.pileNumber,
          'last_updated': entry.savedAt.toUtc().toIso8601String(),
          'updated_at': DateTime.now().toUtc().toIso8601String(),
        },
        onConflict: 'user_id,project_key',
      );

      final project = await client
          .from('saved_projects')
          .select('id')
          .eq('user_id', user.id)
          .eq('project_key', entry.projectKey)
          .maybeSingle();

      final projectId = project?['id']?.toString();
      if (projectId == null || projectId.isEmpty) {
        return 'Unable to resolve remote project id after upsert.';
      }

      await client.from('saved_project_files').upsert(
        {
          'user_id': user.id,
          'project_id': projectId,
          'file_name': entry.fileName,
          'extension': 'xml',
          'local_path': entry.localPath,
          'storage_path': storagePath,
          'size_bytes': entry.sizeBytes,
          'saved_at': entry.savedAt.toUtc().toIso8601String(),
          'upload_status': 'uploaded',
          'upload_attempts': entry.uploadAttempts + 1,
          'last_error': null,
          'updated_at': DateTime.now().toUtc().toIso8601String(),
        },
        onConflict: 'user_id,local_path',
      );

      return null;
    } on supa.StorageException catch (e) {
      return e.message;
    } on supa.PostgrestException catch (e) {
      return e.message;
    } catch (e) {
      return e.toString();
    }
  }

  static supa.SupabaseClient? _tryGetClient() {
    try {
      return supa.Supabase.instance.client;
    } catch (_) {
      return null;
    }
  }
}
