import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart' as supa;

import 'auth_logic.dart';
import 'project_key_utils.dart';
import 'project_sync_service.dart';

enum SavedProjectSyncState {
  localOnly,
  pending,
  synced,
  failed,
}

extension SavedProjectSyncStateX on SavedProjectSyncState {
  String get label {
    switch (this) {
      case SavedProjectSyncState.localOnly:
        return 'Local Only';
      case SavedProjectSyncState.pending:
        return 'Pending Sync';
      case SavedProjectSyncState.synced:
        return 'Synced';
      case SavedProjectSyncState.failed:
        return 'Sync Failed';
    }
  }
}

class SavedProjectFile {
  final String name;
  final String extension;
  final DateTime savedAt;
  final int sizeKb;
  final String absolutePath;
  final String? storagePath;
  final String uploadStatus;
  final bool isRemote;

  const SavedProjectFile({
    required this.name,
    required this.extension,
    required this.savedAt,
    required this.sizeKb,
    required this.absolutePath,
    this.storagePath,
    this.uploadStatus = 'local',
    this.isRemote = false,
  });

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'extension': extension,
      'saved_at': savedAt.toIso8601String(),
      'size_kb': sizeKb,
      'absolute_path': absolutePath,
      'storage_path': storagePath,
      'upload_status': uploadStatus,
      'is_remote': isRemote,
    };
  }

  factory SavedProjectFile.fromJson(Map<String, dynamic> json) {
    return SavedProjectFile(
      name: json['name'] as String? ?? 'file.xml',
      extension: json['extension'] as String? ?? 'xml',
      savedAt: DateTime.tryParse(json['saved_at'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      sizeKb: (json['size_kb'] as num?)?.toInt() ?? 0,
      absolutePath: json['absolute_path'] as String? ?? '',
      storagePath: json['storage_path'] as String?,
      uploadStatus: json['upload_status'] as String? ?? 'local',
      isRemote: json['is_remote'] as bool? ?? false,
    );
  }
}

class SavedProject {
  final String id;
  final String projectKey;
  final String name;
  final String location;
  final String contractor;
  final String inspector;
  final String substructureElement;
  final String pileNumber;
  final DateTime lastUpdated;
  final String directoryPath;
  final List<SavedProjectFile> files;
  final String? remoteProjectId;
  final SavedProjectSyncState syncState;
  final String? lastSyncError;

  const SavedProject({
    required this.id,
    required this.projectKey,
    required this.name,
    required this.location,
    required this.contractor,
    required this.inspector,
    required this.substructureElement,
    required this.pileNumber,
    required this.lastUpdated,
    required this.directoryPath,
    required this.files,
    this.remoteProjectId,
    this.syncState = SavedProjectSyncState.localOnly,
    this.lastSyncError,
  });

  int get totalSizeKb => files.fold<int>(0, (sum, file) => sum + file.sizeKb);

  SavedProject copyWith({
    String? id,
    String? projectKey,
    String? name,
    String? location,
    String? contractor,
    String? inspector,
    String? substructureElement,
    String? pileNumber,
    DateTime? lastUpdated,
    String? directoryPath,
    List<SavedProjectFile>? files,
    String? remoteProjectId,
    SavedProjectSyncState? syncState,
    String? lastSyncError,
  }) {
    return SavedProject(
      id: id ?? this.id,
      projectKey: projectKey ?? this.projectKey,
      name: name ?? this.name,
      location: location ?? this.location,
      contractor: contractor ?? this.contractor,
      inspector: inspector ?? this.inspector,
      substructureElement: substructureElement ?? this.substructureElement,
      pileNumber: pileNumber ?? this.pileNumber,
      lastUpdated: lastUpdated ?? this.lastUpdated,
      directoryPath: directoryPath ?? this.directoryPath,
      files: files ?? this.files,
      remoteProjectId: remoteProjectId ?? this.remoteProjectId,
      syncState: syncState ?? this.syncState,
      lastSyncError: lastSyncError ?? this.lastSyncError,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'project_key': projectKey,
      'name': name,
      'location': location,
      'contractor': contractor,
      'inspector': inspector,
      'substructure_element': substructureElement,
      'pile_number': pileNumber,
      'last_updated': lastUpdated.toIso8601String(),
      'directory_path': directoryPath,
      'files': files.map((f) => f.toJson()).toList(),
      'remote_project_id': remoteProjectId,
      'sync_state': syncState.name,
      'last_sync_error': lastSyncError,
    };
  }

  factory SavedProject.fromJson(Map<String, dynamic> json) {
    final dynamic rawFiles = json['files'];
    final fileList = <SavedProjectFile>[];
    if (rawFiles is List) {
      for (final item in rawFiles) {
        if (item is Map) {
          fileList
              .add(SavedProjectFile.fromJson(Map<String, dynamic>.from(item)));
        }
      }
    }

    final syncStateName = json['sync_state'] as String? ?? 'localOnly';
    final syncState = SavedProjectSyncState.values.firstWhere(
      (value) => value.name == syncStateName,
      orElse: () => SavedProjectSyncState.localOnly,
    );

    return SavedProject(
      id: json['id'] as String? ?? 'project',
      projectKey: json['project_key'] as String? ?? 'project',
      name: json['name'] as String? ?? 'Project',
      location: json['location'] as String? ?? 'Unknown location',
      contractor: json['contractor'] as String? ?? 'Unknown contractor',
      inspector: json['inspector'] as String? ?? 'Unknown inspector',
      substructureElement:
          json['substructure_element'] as String? ?? 'Unknown element',
      pileNumber: json['pile_number'] as String? ?? '-',
      lastUpdated: DateTime.tryParse(json['last_updated'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      directoryPath: json['directory_path'] as String? ?? '',
      files: fileList,
      remoteProjectId: json['remote_project_id'] as String?,
      syncState: syncState,
      lastSyncError: json['last_sync_error'] as String?,
    );
  }
}

final savedProjectsRefreshTickProvider = StateProvider<int>((ref) => 0);

final localProjectsRepositoryProvider =
    Provider<LocalProjectsRepository>((ref) {
  return LocalProjectsRepository();
});

final cloudProjectsRepositoryProvider =
    Provider<CloudProjectsRepository>((ref) {
  return CloudProjectsRepository();
});

final savedProjectsControllerProvider =
    Provider<SavedProjectsController>((ref) {
  return SavedProjectsController();
});

final savedProjectsProvider = FutureProvider<List<SavedProject>>((ref) async {
  ref.watch(savedProjectsRefreshTickProvider);

  final authState = ref.watch(authProvider);
  final authBypass = ref.watch(authBypassProvider);
  const presentationStart =
      String.fromEnvironment('PRESENTATION_START', defaultValue: '');

  final isPresentationMode = authBypass && presentationStart.isNotEmpty;
  final userToken = _safePathSegment(
    authState.user?.email ?? authState.user?.id ?? 'guest',
  );

  if (isPresentationMode) {
    return buildMockSavedProjects(userToken: userToken);
  }

  await ProjectSyncService.syncPendingUploads();

  final localRepo = ref.read(localProjectsRepositoryProvider);
  final cloudRepo = ref.read(cloudProjectsRepositoryProvider);
  final controller = ref.read(savedProjectsControllerProvider);

  final localProjects = await localRepo.loadProjects(userToken: userToken);
  final remoteProjects = await cloudRepo.loadProjects();

  return controller.merge(
    localProjects: localProjects,
    remoteProjects: remoteProjects,
  );
});

class LocalProjectsRepository {
  Future<List<SavedProject>> loadProjects({required String userToken}) async {
    final userRoot = await _resolveUserRootDirectory(userToken);
    if (!await userRoot.exists()) {
      return [];
    }

    final pendingEntries = await ProjectSyncService.loadPendingUploads();
    final pendingByPath = {
      for (final entry in pendingEntries) entry.localPath: entry,
    };

    final byProjectKey = <String, _LocalProjectAccumulator>{};

    await for (final entity
        in userRoot.list(recursive: true, followLinks: false)) {
      if (entity is! File) {
        continue;
      }

      final fileName = entity.path.split('/').last;
      final ext = _fileExtension(fileName);
      if (ext != 'pdf' && ext != 'xml') {
        continue;
      }

      final key = deriveProjectKeyFromFileName(fileName);
      final stats = await entity.stat();
      final pending = pendingByPath[entity.path];
      final uploadStatus = pending == null
          ? 'local'
          : (pending.uploadAttempts >= 3 ? 'failed' : 'pending');

      final file = SavedProjectFile(
        name: fileName,
        extension: ext,
        savedAt: stats.modified,
        sizeKb: (stats.size / 1024).ceil(),
        absolutePath: entity.path,
        uploadStatus: uploadStatus,
      );

      byProjectKey.putIfAbsent(
        key,
        () => _LocalProjectAccumulator(
          projectKey: key,
          name: humanizeProjectKey(key),
          location: 'Unknown location',
          contractor: 'Unknown contractor',
          inspector: 'Unknown inspector',
          substructureElement: _guessSubstructureFromKey(key),
          pileNumber: _guessPileNumberFromKey(key),
          directoryPath: entity.parent.path,
          lastUpdated: stats.modified,
          lastSyncError: pending?.lastError,
        ),
      );

      final accumulator = byProjectKey[key]!;
      accumulator.files.add(file);
      if (stats.modified.isAfter(accumulator.lastUpdated)) {
        accumulator.lastUpdated = stats.modified;
      }
      if (pending?.lastError != null && pending!.lastError!.isNotEmpty) {
        accumulator.lastSyncError = pending.lastError;
      }
    }

    final projects = byProjectKey.values.map((accumulator) {
      accumulator.files.sort((a, b) => b.savedAt.compareTo(a.savedAt));
      return SavedProject(
        id: 'local-${accumulator.projectKey}',
        projectKey: accumulator.projectKey,
        name: accumulator.name,
        location: accumulator.location,
        contractor: accumulator.contractor,
        inspector: accumulator.inspector,
        substructureElement: accumulator.substructureElement,
        pileNumber: accumulator.pileNumber,
        lastUpdated: accumulator.lastUpdated,
        directoryPath: accumulator.directoryPath,
        files: List.unmodifiable(accumulator.files),
        syncState: _syncStateFromFiles(accumulator.files),
        lastSyncError: accumulator.lastSyncError,
      );
    }).toList();

    projects.sort((a, b) => b.lastUpdated.compareTo(a.lastUpdated));
    return projects;
  }

  Future<Directory> _resolveUserRootDirectory(String userToken) async {
    if (Platform.isAndroid) {
      final downloadsRoot =
          Directory('/storage/emulated/0/Download/PileStrokeLog');
      if (await downloadsRoot.exists()) {
        return Directory('${downloadsRoot.path}/$userToken');
      }

      final externalDir = await getExternalStorageDirectory();
      final base =
          externalDir?.path ?? (await getApplicationDocumentsDirectory()).path;
      return Directory('$base/PileStrokeLog/$userToken');
    }

    final docs = await getApplicationDocumentsDirectory();
    return Directory('${docs.path}/PileStrokeLog/$userToken');
  }
}

class CloudProjectsRepository {
  static const String _cachePrefix = 'saved_projects_remote_cache_v1_';

  Future<List<SavedProject>> loadProjects() async {
    final client = _tryGetClient();
    final user = client?.auth.currentUser;
    if (client == null || user == null) {
      return [];
    }

    try {
      final rawProjects = await client
          .from('saved_projects')
          .select(
              'id,project_key,name,location,contractor,inspector,substructure_element,pile_number,last_updated')
          .eq('user_id', user.id)
          .order('last_updated', ascending: false);
      final rawFiles = await client
          .from('saved_project_files')
          .select(
              'project_id,file_name,extension,local_path,storage_path,size_bytes,saved_at,upload_status,last_error')
          .eq('user_id', user.id)
          .order('saved_at', ascending: false);

      final projectRows = _asMapList(rawProjects);
      final fileRows = _asMapList(rawFiles);

      final filesByProjectId = <String, List<Map<String, dynamic>>>{};
      for (final row in fileRows) {
        final projectId = row['project_id']?.toString();
        if (projectId == null || projectId.isEmpty) {
          continue;
        }
        filesByProjectId.putIfAbsent(projectId, () => []).add(row);
      }

      final projects = <SavedProject>[];
      for (final row in projectRows) {
        final projectId = row['id']?.toString() ?? '';
        final projectFiles = filesByProjectId[projectId] ?? [];

        final files = projectFiles.map((fileRow) {
          final storagePath = fileRow['storage_path'] as String?;
          final localPath = fileRow['local_path'] as String?;
          final absolutePath = (localPath != null && localPath.isNotEmpty)
              ? localPath
              : 'supabase://project-xml/${storagePath ?? ''}';

          return SavedProjectFile(
            name: fileRow['file_name'] as String? ?? 'export.xml',
            extension: fileRow['extension'] as String? ?? 'xml',
            savedAt: DateTime.tryParse(fileRow['saved_at'] as String? ?? '') ??
                DateTime.fromMillisecondsSinceEpoch(0),
            sizeKb:
                (((fileRow['size_bytes'] as num?)?.toInt() ?? 0) / 1024).ceil(),
            absolutePath: absolutePath,
            storagePath: storagePath,
            uploadStatus: fileRow['upload_status'] as String? ?? 'uploaded',
            isRemote: true,
          );
        }).toList();

        final directoryPath = _deriveDirectoryPath(files);
        final lastSyncError = projectFiles
            .map((fileRow) => fileRow['last_error'] as String?)
            .firstWhere(
              (value) => value != null && value.trim().isNotEmpty,
              orElse: () => null,
            );

        projects.add(
          SavedProject(
            id: 'remote-$projectId',
            projectKey: row['project_key'] as String? ?? 'project',
            name: row['name'] as String? ?? 'Project',
            location: row['location'] as String? ?? 'Unknown location',
            contractor: row['contractor'] as String? ?? 'Unknown contractor',
            inspector: row['inspector'] as String? ?? 'Unknown inspector',
            substructureElement:
                row['substructure_element'] as String? ?? 'Unknown element',
            pileNumber: row['pile_number'] as String? ?? '-',
            lastUpdated:
                DateTime.tryParse(row['last_updated'] as String? ?? '') ??
                    DateTime.fromMillisecondsSinceEpoch(0),
            directoryPath: directoryPath,
            files: files,
            remoteProjectId: projectId,
            syncState: _syncStateFromFiles(files),
            lastSyncError: lastSyncError,
          ),
        );
      }

      await _saveCache(user.id, projects);
      return projects;
    } catch (_) {
      return _loadCache(user.id);
    }
  }

  Future<void> _saveCache(String userId, List<SavedProject> projects) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      '$_cachePrefix$userId',
      jsonEncode(projects.map((project) => project.toJson()).toList()),
    );
  }

  Future<List<SavedProject>> _loadCache(String userId) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('$_cachePrefix$userId');
    if (raw == null || raw.isEmpty) {
      return [];
    }

    try {
      final decoded = _asList(raw);
      return decoded
          .map((item) => SavedProject.fromJson(Map<String, dynamic>.from(item)))
          .toList();
    } catch (_) {
      return [];
    }
  }

  List<Map<String, dynamic>> _asMapList(dynamic raw) {
    if (raw is! List) {
      return [];
    }
    return raw
        .whereType<Map>()
        .map((value) => Map<String, dynamic>.from(value))
        .toList();
  }

  List<Map<String, dynamic>> _asList(String raw) {
    try {
      final parsed = jsonDecode(raw);
      if (parsed is! List) {
        return [];
      }
      return parsed
          .whereType<Map>()
          .map((value) => Map<String, dynamic>.from(value))
          .toList();
    } catch (_) {
      return [];
    }
  }

  String _deriveDirectoryPath(List<SavedProjectFile> files) {
    for (final file in files) {
      if (file.absolutePath.startsWith('/')) {
        final idx = file.absolutePath.lastIndexOf('/');
        if (idx > 0) {
          return file.absolutePath.substring(0, idx);
        }
      }
    }
    return '/project-xml';
  }

  supa.SupabaseClient? _tryGetClient() {
    try {
      return supa.Supabase.instance.client;
    } catch (_) {
      return null;
    }
  }
}

class SavedProjectsController {
  List<SavedProject> merge({
    required List<SavedProject> localProjects,
    required List<SavedProject> remoteProjects,
  }) {
    final localByKey = {
      for (final project in localProjects) project.projectKey: project,
    };

    final merged = <SavedProject>[];
    for (final remote in remoteProjects) {
      final local = localByKey.remove(remote.projectKey);
      if (local == null) {
        merged.add(remote);
        continue;
      }

      merged.add(_mergeProject(local: local, remote: remote));
    }

    merged.addAll(localByKey.values);
    merged.sort((a, b) => b.lastUpdated.compareTo(a.lastUpdated));
    return merged;
  }

  SavedProject _mergeProject({
    required SavedProject local,
    required SavedProject remote,
  }) {
    final filesByKey = <String, SavedProjectFile>{};

    for (final file in local.files) {
      filesByKey[_fileIdentity(file)] = file;
    }
    for (final file in remote.files) {
      filesByKey[_fileIdentity(file)] = file;
    }

    final mergedFiles = filesByKey.values.toList()
      ..sort((a, b) => b.savedAt.compareTo(a.savedAt));

    return SavedProject(
      id: local.id,
      projectKey: local.projectKey,
      name: _preferRemoteText(remote.name, local.name),
      location: _preferRemoteText(remote.location, local.location),
      contractor: _preferRemoteText(remote.contractor, local.contractor),
      inspector: _preferRemoteText(remote.inspector, local.inspector),
      substructureElement: _preferRemoteText(
          remote.substructureElement, local.substructureElement),
      pileNumber: _preferRemoteText(remote.pileNumber, local.pileNumber),
      lastUpdated: local.lastUpdated.isAfter(remote.lastUpdated)
          ? local.lastUpdated
          : remote.lastUpdated,
      directoryPath: local.directoryPath.isNotEmpty
          ? local.directoryPath
          : remote.directoryPath,
      files: mergedFiles,
      remoteProjectId: remote.remoteProjectId,
      syncState: _combineSyncStates(local.syncState, remote.syncState),
      lastSyncError: (remote.lastSyncError?.trim().isNotEmpty == true)
          ? remote.lastSyncError
          : local.lastSyncError,
    );
  }

  String _fileIdentity(SavedProjectFile file) {
    if (file.storagePath != null && file.storagePath!.isNotEmpty) {
      return file.storagePath!;
    }
    if (file.absolutePath.isNotEmpty) {
      return file.absolutePath;
    }
    return '${file.name}:${file.savedAt.toIso8601String()}';
  }

  String _preferRemoteText(String remote, String local) {
    final normalizedRemote = remote.trim().toLowerCase();
    if (normalizedRemote.isEmpty ||
        normalizedRemote == 'unknown location' ||
        normalizedRemote == 'unknown contractor' ||
        normalizedRemote == 'unknown inspector' ||
        normalizedRemote == 'unknown element') {
      return local;
    }
    return remote;
  }

  SavedProjectSyncState _combineSyncStates(
    SavedProjectSyncState local,
    SavedProjectSyncState remote,
  ) {
    final order = {
      SavedProjectSyncState.localOnly: 0,
      SavedProjectSyncState.synced: 1,
      SavedProjectSyncState.pending: 2,
      SavedProjectSyncState.failed: 3,
    };

    return (order[local]! >= order[remote]!) ? local : remote;
  }
}

class _LocalProjectAccumulator {
  final String projectKey;
  final String name;
  final String location;
  final String contractor;
  final String inspector;
  final String substructureElement;
  final String pileNumber;
  final String directoryPath;
  final List<SavedProjectFile> files = [];
  DateTime lastUpdated;
  String? lastSyncError;

  _LocalProjectAccumulator({
    required this.projectKey,
    required this.name,
    required this.location,
    required this.contractor,
    required this.inspector,
    required this.substructureElement,
    required this.pileNumber,
    required this.directoryPath,
    required this.lastUpdated,
    this.lastSyncError,
  });
}

SavedProjectSyncState _syncStateFromFiles(List<SavedProjectFile> files) {
  final statuses = files
      .where((file) => file.extension.toLowerCase() == 'xml')
      .map((file) => file.uploadStatus.toLowerCase())
      .toList();

  if (statuses.any((status) => status == 'failed')) {
    return SavedProjectSyncState.failed;
  }
  if (statuses.any((status) => status == 'pending')) {
    return SavedProjectSyncState.pending;
  }
  if (statuses.any((status) => status == 'uploaded')) {
    return SavedProjectSyncState.synced;
  }
  return SavedProjectSyncState.localOnly;
}

String _safePathSegment(String input) {
  final sanitized = input
      .trim()
      .replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')
      .replaceAll(RegExp(r'_+'), '_')
      .replaceAll(RegExp(r'^_+|_+$'), '');
  return sanitized.isEmpty ? 'user' : sanitized;
}

String _fileExtension(String fileName) {
  final dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex == fileName.length - 1) {
    return '';
  }
  return fileName.substring(dotIndex + 1).toLowerCase();
}

String _guessPileNumberFromKey(String projectKey) {
  final segments = projectKey.split('_');
  if (segments.isNotEmpty && RegExp(r'^\d+$').hasMatch(segments.last)) {
    return segments.last;
  }
  return '-';
}

String _guessSubstructureFromKey(String projectKey) {
  final segments = projectKey.split('_');
  if (segments.length >= 2) {
    return segments[segments.length - 2].replaceAll('_', ' ');
  }
  return 'Unknown element';
}

List<SavedProject> buildMockSavedProjects({
  required String userToken,
  DateTime? now,
}) {
  final baseDirectory = '/storage/emulated/0/Download/PileStrokeLog/$userToken';
  final nowValue = now ?? DateTime.now();

  SavedProjectFile file(
    String directory,
    String filename,
    String extension,
    DateTime savedAt,
    int sizeKb,
  ) {
    return SavedProjectFile(
      name: filename,
      extension: extension,
      savedAt: savedAt,
      sizeKb: sizeKb,
      absolutePath: '$directory/$filename',
      uploadStatus: extension.toLowerCase() == 'xml' ? 'uploaded' : 'local',
    );
  }

  final projectOneDirectory = '$baseDirectory/Riverfront_Expansion_Pier_A_1';
  final projectTwoDirectory = '$baseDirectory/I70_Overpass_Abutment_2';
  final projectThreeDirectory = '$baseDirectory/Port_Terminal_Berth_5';

  return [
    SavedProject(
      id: 'proj-riverfront',
      projectKey: 'Riverfront_Expansion_Pier_A_1',
      name: 'Riverfront Expansion',
      location: 'Kansas City, MO',
      contractor: 'Midwest Piling Co.',
      inspector: 'J. Perez',
      substructureElement: 'Pier A',
      pileNumber: '1',
      lastUpdated: nowValue.subtract(const Duration(hours: 2)),
      directoryPath: projectOneDirectory,
      files: [
        file(
          projectOneDirectory,
          'Riverfront_Expansion_PierA_1_030826_1015.pdf',
          'pdf',
          nowValue.subtract(const Duration(hours: 2)),
          842,
        ),
        file(
          projectOneDirectory,
          'Riverfront_Expansion_PierA_1_030826_1015.xml',
          'xml',
          nowValue.subtract(const Duration(hours: 2)),
          28,
        ),
      ],
      syncState: SavedProjectSyncState.synced,
      remoteProjectId: 'remote-riverfront',
    ),
    SavedProject(
      id: 'proj-i70',
      projectKey: 'I70_Overpass_Abutment_2',
      name: 'I-70 Overpass Retrofit',
      location: 'Topeka, KS',
      contractor: 'Central GeoBuilders',
      inspector: 'A. Thompson',
      substructureElement: 'Abutment 2',
      pileNumber: '4',
      lastUpdated: nowValue.subtract(const Duration(days: 1, hours: 3)),
      directoryPath: projectTwoDirectory,
      files: [
        file(
          projectTwoDirectory,
          'I70_Overpass_Abutment2_4_030726_1454.pdf',
          'pdf',
          nowValue.subtract(const Duration(days: 1, hours: 3)),
          916,
        ),
        file(
          projectTwoDirectory,
          'I70_Overpass_Abutment2_4_030726_1454.xml',
          'xml',
          nowValue.subtract(const Duration(days: 1, hours: 3)),
          31,
        ),
        file(
          projectTwoDirectory,
          'I70_Overpass_Abutment2_4_030726_1456.pdf',
          'pdf',
          nowValue.subtract(const Duration(days: 1, hours: 3, minutes: 15)),
          922,
        ),
      ],
      syncState: SavedProjectSyncState.pending,
      lastSyncError: 'Waiting for network reconnect.',
      remoteProjectId: 'remote-i70',
    ),
    SavedProject(
      id: 'proj-port',
      projectKey: 'Port_Terminal_Berth_5',
      name: 'Port Terminal Upgrade',
      location: 'Houston, TX',
      contractor: 'Gulf Foundations LLC',
      inspector: 'S. Kim',
      substructureElement: 'Berth 5',
      pileNumber: '12',
      lastUpdated: nowValue.subtract(const Duration(days: 4, hours: 5)),
      directoryPath: projectThreeDirectory,
      files: [
        file(
          projectThreeDirectory,
          'Port_Terminal_Berth5_12_030426_0835.pdf',
          'pdf',
          nowValue.subtract(const Duration(days: 4, hours: 5)),
          804,
        ),
        file(
          projectThreeDirectory,
          'Port_Terminal_Berth5_12_030426_0835.xml',
          'xml',
          nowValue.subtract(const Duration(days: 4, hours: 5)),
          26,
        ),
      ],
      syncState: SavedProjectSyncState.localOnly,
    ),
  ];
}
