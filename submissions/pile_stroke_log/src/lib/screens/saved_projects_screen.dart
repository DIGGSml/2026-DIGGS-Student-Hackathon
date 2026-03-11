import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';

import '../core/project_sync_service.dart';
import '../core/projects_export_service.dart';
import '../core/saved_projects_logic.dart';

class SavedProjectsScreen extends ConsumerWidget {
  const SavedProjectsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final projectsAsync = ref.watch(savedProjectsProvider);
    final dateFormat = DateFormat('MMM d, yyyy • h:mm a');

    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      appBar: AppBar(
        centerTitle: true,
        title: Text(
          'Saved Projects',
          style: GoogleFonts.inter(
            fontWeight: FontWeight.bold,
            color: Colors.white,
          ),
        ),
        backgroundColor: const Color(0xFF424242),
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          IconButton(
            icon: const Icon(Icons.sync, color: Colors.white),
            tooltip: 'Retry Pending Sync',
            onPressed: () async {
              final result = await ProjectSyncService.syncPendingUploads();
              if (!context.mounted) return;

              ref.read(savedProjectsRefreshTickProvider.notifier).state++;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(result.message),
                  backgroundColor:
                      result.pending ? Colors.orange[700] : Colors.green[700],
                ),
              );
            },
          ),
        ],
      ),
      body: projectsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              'Unable to load projects: $error',
              textAlign: TextAlign.center,
              style: GoogleFonts.inter(color: Colors.red[700]),
            ),
          ),
        ),
        data: (projects) {
          if (projects.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  'No saved projects found yet. Export a session to create your first project entry.',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.inter(
                    color: Colors.grey[700],
                    fontSize: 14,
                  ),
                ),
              ),
            );
          }

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              ...projects.map(
                (project) => Card(
                  color: Colors.white,
                  margin: const EdgeInsets.only(bottom: 12),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) =>
                              ProjectDirectoryScreen(project: project),
                        ),
                      );
                    },
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              CircleAvatar(
                                backgroundColor: const Color(0xFFE8F5E9),
                                child: Text(
                                  '${project.files.length}',
                                  style: GoogleFonts.inter(
                                    fontWeight: FontWeight.bold,
                                    color: const Color(0xFF1B5E20),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  project.name,
                                  style: GoogleFonts.inter(
                                    fontWeight: FontWeight.bold,
                                    color: const Color(0xFF263238),
                                    fontSize: 20,
                                  ),
                                ),
                              ),
                              const Icon(Icons.chevron_right),
                            ],
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '${project.location}\n'
                            '${project.files.length} files • ${project.totalSizeKb} KB • '
                            'Updated ${dateFormat.format(project.lastUpdated)}',
                            style: GoogleFonts.inter(height: 1.4),
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              _SyncStatusChip(state: project.syncState),
                              if (project.syncState ==
                                      SavedProjectSyncState.pending ||
                                  project.syncState ==
                                      SavedProjectSyncState.failed)
                                TextButton.icon(
                                  onPressed: () async {
                                    final result = await ProjectSyncService
                                        .syncPendingUploads();
                                    if (!context.mounted) return;

                                    ref
                                        .read(savedProjectsRefreshTickProvider
                                            .notifier)
                                        .state++;
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(
                                        content: Text(result.message),
                                        backgroundColor: result.pending
                                            ? Colors.orange[700]
                                            : Colors.green[700],
                                      ),
                                    );
                                  },
                                  icon: const Icon(Icons.sync, size: 16),
                                  label: Text(
                                    'Retry Sync',
                                    style: GoogleFonts.inter(
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class ProjectDirectoryScreen extends ConsumerWidget {
  final SavedProject project;

  const ProjectDirectoryScreen({
    super.key,
    required this.project,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dateFormat = DateFormat('MMM d, yyyy • h:mm a');
    final allProjectsAsync = ref.watch(savedProjectsProvider);

    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      appBar: AppBar(
        centerTitle: true,
        title: Text(
          project.name,
          style: GoogleFonts.inter(
            fontWeight: FontWeight.bold,
            color: Colors.white,
            fontSize: 16,
          ),
        ),
        backgroundColor: const Color(0xFF424242),
        iconTheme: const IconThemeData(color: Colors.white),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _DirectoryCard(project: project),
          const SizedBox(height: 12),
          Row(
            children: [
              _SyncStatusChip(state: project.syncState),
              if (project.syncState == SavedProjectSyncState.pending ||
                  project.syncState == SavedProjectSyncState.failed)
                TextButton.icon(
                  onPressed: () async {
                    final result =
                        await ProjectSyncService.syncPendingUploads();
                    if (!context.mounted) return;

                    ref.read(savedProjectsRefreshTickProvider.notifier).state++;
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(result.message),
                        backgroundColor: result.pending
                            ? Colors.orange[700]
                            : Colors.green[700],
                        duration: const Duration(seconds: 4),
                      ),
                    );
                  },
                  icon: const Icon(Icons.sync, size: 16),
                  label: Text(
                    'Retry Sync',
                    style: GoogleFonts.inter(fontWeight: FontWeight.w600),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: () async {
                final allProjects = allProjectsAsync.value ?? [project];
                final result =
                    await ProjectsExportService.exportAllProjectsAsZip(
                        allProjects);
                if (!context.mounted) return;

                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(result.message),
                    backgroundColor:
                        result.success ? Colors.green[700] : Colors.red[700],
                    duration: const Duration(seconds: 4),
                  ),
                );

                if (result.success && result.filePath != null) {
                  try {
                    await ProjectsExportService.shareZipFile(result.filePath!);
                  } catch (e) {
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text('Zip saved, but share failed: $e'),
                        backgroundColor: Colors.orange[700],
                        duration: const Duration(seconds: 4),
                      ),
                    );
                  }
                }
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF1B5E20),
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              icon: const Icon(Icons.folder_zip),
              label: Text(
                'Export All Projects (.zip)',
                style: GoogleFonts.inter(
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            color: Colors.white,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Project Details',
                    style: GoogleFonts.inter(
                      fontWeight: FontWeight.bold,
                      color: const Color(0xFF263238),
                    ),
                  ),
                  const SizedBox(height: 10),
                  _DetailRow(label: 'Location', value: project.location),
                  _DetailRow(label: 'Contractor', value: project.contractor),
                  _DetailRow(label: 'Inspector', value: project.inspector),
                  _DetailRow(
                    label: 'Substructure Element',
                    value: project.substructureElement,
                  ),
                  _DetailRow(label: 'Pile Number', value: project.pileNumber),
                  _DetailRow(
                    label: 'Last Updated',
                    value: dateFormat.format(project.lastUpdated),
                  ),
                  if (project.lastSyncError != null &&
                      project.lastSyncError!.trim().isNotEmpty)
                    _DetailRow(
                      label: 'Last Sync Error',
                      value: project.lastSyncError!,
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Project Files',
            style: GoogleFonts.inter(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: const Color(0xFF37474F),
            ),
          ),
          const SizedBox(height: 8),
          ...project.files.map(
            (file) => Card(
              color: Colors.white,
              margin: const EdgeInsets.only(bottom: 10),
              child: ListTile(
                leading: CircleAvatar(
                  backgroundColor: file.extension.toLowerCase() == 'xml'
                      ? const Color(0xFFE3F2FD)
                      : const Color(0xFFFFF3E0),
                  child: Icon(
                    file.extension.toLowerCase() == 'xml'
                        ? Icons.data_object
                        : Icons.picture_as_pdf,
                    color: file.extension.toLowerCase() == 'xml'
                        ? const Color(0xFF1565C0)
                        : const Color(0xFFEF6C00),
                  ),
                ),
                title: Text(
                  file.name,
                  style: GoogleFonts.inter(
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFF263238),
                  ),
                ),
                subtitle: Text(
                  '${file.sizeKb} KB • ${dateFormat.format(file.savedAt)}\n'
                  '${file.absolutePath}',
                  style: GoogleFonts.inter(height: 1.3),
                ),
                isThreeLine: true,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DirectoryCard extends StatelessWidget {
  final SavedProject project;

  const _DirectoryCard({required this.project});

  @override
  Widget build(BuildContext context) {
    return Card(
      color: const Color(0xFFE8F5E9),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.folder, color: Color(0xFF1B5E20)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Project Directory',
                    style: GoogleFonts.inter(
                      fontWeight: FontWeight.bold,
                      color: const Color(0xFF1B5E20),
                    ),
                  ),
                  const SizedBox(height: 4),
                  SelectableText(
                    project.directoryPath,
                    style: GoogleFonts.inter(
                      color: const Color(0xFF2E7D32),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;

  const _DetailRow({
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 130,
            child: Text(
              '$label:',
              style: GoogleFonts.inter(
                fontWeight: FontWeight.w600,
                color: const Color(0xFF546E7A),
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: GoogleFonts.inter(
                color: const Color(0xFF263238),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SyncStatusChip extends StatelessWidget {
  final SavedProjectSyncState state;

  const _SyncStatusChip({required this.state});

  @override
  Widget build(BuildContext context) {
    final colors = _statusColors(state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: colors.$1,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: colors.$2),
      ),
      child: Text(
        state.label,
        style: GoogleFonts.inter(
          fontSize: 12,
          fontWeight: FontWeight.w700,
          color: colors.$3,
        ),
      ),
    );
  }

  (Color, Color, Color) _statusColors(SavedProjectSyncState status) {
    switch (status) {
      case SavedProjectSyncState.synced:
        return (
          const Color(0xFFE8F5E9),
          const Color(0xFF66BB6A),
          const Color(0xFF1B5E20),
        );
      case SavedProjectSyncState.pending:
        return (
          const Color(0xFFFFF8E1),
          const Color(0xFFFFCC80),
          const Color(0xFFE65100),
        );
      case SavedProjectSyncState.failed:
        return (
          const Color(0xFFFFEBEE),
          const Color(0xFFEF9A9A),
          const Color(0xFFB71C1C),
        );
      case SavedProjectSyncState.localOnly:
        return (
          const Color(0xFFF5F5F5),
          const Color(0xFFB0BEC5),
          const Color(0xFF455A64),
        );
    }
  }
}
