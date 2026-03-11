import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import '../core/pile_session_logic.dart';
import '../core/audio_processor.dart';
import '../core/export_service.dart';
import '../core/hammer_logic.dart';
import '../core/hammer_model.dart';
import '../core/pile_logic.dart';
import '../core/project_sync_service.dart';
import '../core/settings_logic.dart';
import 'bearing_capacity_screen.dart';
import '../widgets/location_selector_modal.dart';

class LogScreen extends ConsumerWidget {
  const LogScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessionState = ref.watch(pileSessionProvider);
    final audioState = ref.watch(audioProcessorProvider);
    final sessionNotifier = ref.read(pileSessionProvider.notifier);
    final audioNotifier = ref.read(audioProcessorProvider.notifier);

    // Listen for new blows - compare full state to ensure we capture stroke data correctly
    ref.listen<SaximeterState>(audioProcessorProvider, (previous, next) {
      // Only record a blow when strokeCount actually increases
      if (previous != null && next.strokeCount > previous.strokeCount) {
        sessionNotifier.recordBlow(next.lastCalculatedStroke);
      }
    });

    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      resizeToAvoidBottomInset: false,
      appBar: AppBar(
        backgroundColor: const Color(0xFF424242),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
        centerTitle: true,
        title: Text(
          'Stroke Log',
          style: GoogleFonts.inter(
            fontWeight: FontWeight.bold,
            color: Colors.white,
          ),
        ),
        actions: [
          // Calibration Button
          IconButton(
            icon: Icon(Icons.tune,
                color: audioState.isCalibrating ? Colors.orange : Colors.white),
            onPressed: audioState.isCalibrating
                ? null
                : () {
                    // Show confirmation or just start? The user asked for a "Calibrate Noise" button.
                    // Workflow: 1. Stop hammer. 2. Hit Calibrate. 3. Listen 3s.
                    audioNotifier.startCalibration();
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                        content: Text(
                            "Calibrating... Please keep quiet for 3 seconds.")));
                  },
            tooltip: "Calibrate Noise Level",
          ),
          IconButton(
            icon: const Icon(
              Icons.arrow_forward,
              color: Colors.white,
            ),
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                    builder: (context) => const BearingCapacityScreen()),
              );
            },
            tooltip: "Bearing Capacity",
          ),
        ],
      ),
      body: Column(
        children: [
          // Header Info
          Container(
            padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 24),
            color: Colors.white,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                    child: _buildInfoItem("Project", sessionState.projectName)),
                Expanded(
                  child: _buildInfoItem(
                    "Pile",
                    "${sessionState.pileGroup} - ${sessionState.pileNumber}",
                  ),
                ),
                Expanded(
                  child: _buildInfoItem(
                    "Cur. Elev.",
                    (sessionState.groundElevation - sessionState.currentDepth)
                        .toStringAsFixed(1),
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 1),

          Container(
            color: Colors.grey[200],
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 16),
              title: Row(
                children: [
                  Expanded(
                      child: _buildTableHeader(
                          "Depth (${ref.watch(settingsProvider).unitSystem.unitSuffix})")),
                  Expanded(child: _buildTableHeader("Blow Count")),
                  Expanded(child: _buildTableHeader("Time")),
                  Expanded(
                      child: _buildTableHeader(
                          "Stroke (${ref.watch(settingsProvider).unitSystem.unitSuffix})")),
                ],
              ),
              trailing:
                  const SizedBox(width: 20), // Matches the expansion icon width
            ),
          ),

          // Log List (Expandable)
          Expanded(
            child: ListView.builder(
              itemCount: sessionState.logs.length,
              itemBuilder: (context, index) {
                final log = sessionState.logs[index];
                final hasBlows = log.blows.isNotEmpty;

                return Container(
                  decoration: BoxDecoration(
                    border: Border(
                      bottom: BorderSide(color: Colors.grey[300]!),
                    ),
                    color: index % 2 == 0 ? Colors.white : Colors.grey[50],
                  ),
                  child: ExpansionTile(
                    tilePadding: const EdgeInsets.symmetric(horizontal: 16),
                    childrenPadding: EdgeInsets.zero,
                    iconColor: Colors.grey[600],
                    collapsedIconColor:
                        hasBlows ? Colors.blue : Colors.grey[400],
                    trailing: hasBlows
                        ? const Icon(Icons.expand_more, size: 20)
                        : const SizedBox(width: 20),
                    title: Row(
                      children: [
                        Expanded(
                          child: _buildTableCell(log.depth.toStringAsFixed(2)),
                        ),
                        Expanded(
                          child: _buildTableCell(log.blowCount.toString()),
                        ),
                        Expanded(
                          child: _buildTableCell(
                            DateFormat('HH:mm').format(log.timestamp),
                          ),
                        ),
                        Expanded(
                          child: _buildTableCell(
                            log.stroke == 0
                                ? "- - -"
                                : log.stroke.toStringAsFixed(2),
                          ),
                        ),
                      ],
                    ),
                    children: hasBlows
                        ? [
                            Container(
                              color: Colors.grey[100],
                              padding: const EdgeInsets.symmetric(
                                  vertical: 8, horizontal: 16),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  // Header for blow details
                                  Padding(
                                    padding: const EdgeInsets.only(bottom: 8),
                                    child: Row(
                                      children: [
                                        Expanded(
                                          child: Text("Blow #",
                                              textAlign: TextAlign.center,
                                              style: GoogleFonts.inter(
                                                  fontSize: 11,
                                                  fontWeight: FontWeight.bold,
                                                  color: Colors.grey[700])),
                                        ),
                                        Expanded(
                                          child: Text("Time",
                                              textAlign: TextAlign.center,
                                              style: GoogleFonts.inter(
                                                  fontSize: 11,
                                                  fontWeight: FontWeight.bold,
                                                  color: Colors.grey[700])),
                                        ),
                                        Expanded(
                                          child: Text(
                                              "Stroke (${ref.watch(settingsProvider).unitSystem.unitSuffix})",
                                              textAlign: TextAlign.center,
                                              style: GoogleFonts.inter(
                                                  fontSize: 11,
                                                  fontWeight: FontWeight.bold,
                                                  color: Colors.grey[700])),
                                        ),
                                      ],
                                    ),
                                  ),
                                  // Blow details rows
                                  ...log.blows
                                      .where((b) => b.strokeHeight > 0)
                                      .toList()
                                      .asMap()
                                      .entries
                                      .map((entry) {
                                    final blowIndex = entry.key;
                                    final blow = entry.value;
                                    return Padding(
                                      padding: const EdgeInsets.symmetric(
                                          vertical: 4),
                                      child: Row(
                                        children: [
                                          Expanded(
                                            child: Text("${blowIndex + 1}",
                                                textAlign: TextAlign.center,
                                                style: GoogleFonts.inter(
                                                    fontSize: 12,
                                                    color: Colors.black87)),
                                          ),
                                          Expanded(
                                            child: Text(
                                                DateFormat('HH:mm:ss')
                                                    .format(blow.timestamp),
                                                textAlign: TextAlign.center,
                                                style: GoogleFonts.inter(
                                                    fontSize: 12,
                                                    color: Colors.black87)),
                                          ),
                                          Expanded(
                                            child: Text(
                                                blow.strokeHeight >
                                                        ref
                                                            .read(
                                                                pileSessionProvider)
                                                            .maxHammerStroke
                                                    ? "- - -"
                                                    : blow.strokeHeight
                                                        .toStringAsFixed(2),
                                                textAlign: TextAlign.center,
                                                style: GoogleFonts.inter(
                                                    fontSize: 12,
                                                    color: Colors.black87)),
                                          ),
                                        ],
                                      ),
                                    );
                                  }),
                                ],
                              ),
                            ),
                          ]
                        : [],
                  ),
                );
              },
            ),
          ),

          // Current Interval Live Stats
          Container(
            padding: const EdgeInsets.all(8),
            color: audioState.isCalibrating
                ? Colors.orange.withAlpha(50)
                : Colors.black12,
            child: Row(
              children: [
                if (audioState.isCalibrating) ...[
                  const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text("Calibrating Noise Floor...",
                        softWrap: true,
                        style: GoogleFonts.inter(
                            fontWeight: FontWeight.bold,
                            color: Colors.deepOrange)),
                  ),
                ] else ...[
                  Expanded(
                    flex: 4,
                    child: Text(
                      "Blows: ${sessionState.currentIntervalBlowCount}",
                      textAlign: TextAlign.center,
                      style: GoogleFonts.inter(
                          fontWeight: FontWeight.bold, fontSize: 13),
                    ),
                  ),
                  Expanded(
                    flex: 5,
                    child: Text(
                      "Stroke: ${audioState.lastCalculatedStroke.toStringAsFixed(2)}${ref.watch(settingsProvider).unitSystem.unitSuffix}",
                      textAlign: TextAlign.center,
                      style: GoogleFonts.inter(
                          fontWeight: FontWeight.bold, fontSize: 13),
                    ),
                  ),
                  Expanded(
                    flex: 3,
                    child: Text(
                      audioState.isRecording ? "Listening" : "Paused",
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          fontSize: 13,
                          color: audioState.isRecording
                              ? Colors.green
                              : Colors.red,
                          fontWeight: FontWeight.bold),
                    ),
                  ),
                ]
              ],
            ),
          ),

          // Debug / Info regarding Threshold
          Container(
            color: Colors.black87,
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                "Threshold: ${(audioState.threshold * 100).toStringAsFixed(1)}% | Last Peak: ${(audioState.latestStrokeHeight * 100).toStringAsFixed(1)}%",
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70, fontSize: 10),
              ),
            ),
          ),

          // Footer Controls
          Padding(
            padding: const EdgeInsets.all(24.0),
            child: SizedBox(
              width: double.infinity,
              height: 56,
              child: ElevatedButton(
                onPressed: () {
                  sessionNotifier.incrementDepth();
                },
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF424242),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
                child: Text(
                  "Increment",
                  style: GoogleFonts.inter(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
            ),
          ),

          // Audio Controls & Sensitivity
          Padding(
            padding: const EdgeInsets.fromLTRB(24.0, 0, 24.0, 24.0),
            child: Row(
              children: [
                // Audio Toggle
                FloatingActionButton(
                  mini: false, // Make it standard size for better touch target
                  backgroundColor:
                      audioState.isRecording ? Colors.red : Colors.green,
                  child:
                      Icon(audioState.isRecording ? Icons.mic_off : Icons.mic),
                  onPressed: () => audioNotifier.toggleRecording(),
                ),

                const SizedBox(width: 24),

                // Sensitivity Controls
                Expanded(
                  child: Column(
                    children: [
                      // Auto Sensitivity Toggle
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text("Auto-Sensitivity",
                                style: GoogleFonts.inter(
                                    fontSize: 12, fontWeight: FontWeight.bold)),
                          ),
                          Switch(
                            value: audioState.isAutoSensitivity,
                            activeThumbColor: Colors.blue,
                            onChanged: (val) {
                              audioNotifier.toggleAutoSensitivity(val);
                            },
                          ),
                        ],
                      ),

                      Opacity(
                        opacity: audioState.isAutoSensitivity ? 0.5 : 1.0,
                        child: Column(
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Expanded(
                                  child: Text("Sensitivity",
                                      style: GoogleFonts.inter(
                                          fontSize: 12,
                                          fontWeight: FontWeight.bold)),
                                ),
                                Text(
                                    "${audioState.customThresholdMultiplier.toStringAsFixed(0)}x RMS",
                                    style: GoogleFonts.inter(
                                        fontSize: 12, color: Colors.grey[700])),
                              ],
                            ),
                            Slider(
                              value: audioState.customThresholdMultiplier,
                              min: 4.0,
                              max: 30.0,
                              divisions: 26, // 1.0 increments (30 - 4)
                              label: audioState.customThresholdMultiplier
                                  .toStringAsFixed(0),
                              onChanged: audioState.isAutoSensitivity
                                  ? null
                                  : (val) {
                                      audioNotifier.setThresholdMultiplier(val);
                                    },
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),

          // Stop Button (Export/End Session)
          Padding(
            padding: const EdgeInsets.fromLTRB(24.0, 0, 24.0, 24.0),
            child: SizedBox(
              width: double.infinity,
              height: 56,
              child: ElevatedButton(
                onPressed: () async {
                  await _handleStopPressed(context, ref);
                },
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red[700],
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
                child: Text(
                  "Stop",
                  style: GoogleFonts.inter(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _handleStopPressed(BuildContext context, WidgetRef ref) async {
    final currentSession = ref.read(pileSessionProvider);
    final locationResult = await showLocationSelectorModal(
      context,
      initialLat: currentSession.projectLatitude,
      initialLon: currentSession.projectLongitude,
    );

    if (locationResult == null || !context.mounted) {
      return;
    }

    final sessionNotifier = ref.read(pileSessionProvider.notifier);
    sessionNotifier.setProjectCoordinates(
      latitude: locationResult.latitude,
      longitude: locationResult.longitude,
    );

    final resolvedAddress = locationResult.resolvedAddress?.trim();
    if (resolvedAddress != null && resolvedAddress.isNotEmpty) {
      sessionNotifier.setProjectLocation(resolvedAddress);
    }

    final audioState = ref.read(audioProcessorProvider);
    if (audioState.isRecording) {
      ref.read(audioProcessorProvider.notifier).toggleRecording();
    }

    final updatedSession = ref.read(pileSessionProvider);
    if (updatedSession.isBearingCapacityCalculated) {
      _showExportOptions(context, ref);
      return;
    }

    _showFinalDepthPrompt(context, ref);
  }

  void _showFinalDepthPrompt(BuildContext context, WidgetRef ref) {
    // Initialize with empty text to force manual entry
    final TextEditingController depthController =
        TextEditingController(text: "");

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: Text("Final Penetration Depth",
            style: GoogleFonts.inter(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                "Enter the final penetration depth (${ref.read(settingsProvider).unitSystem.unitSuffix}):",
                style: GoogleFonts.inter()),
            const SizedBox(height: 16),
            TextField(
              controller: depthController,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              autofocus: true, // Focus automatically so keyboard pops up
              decoration: InputDecoration(
                suffixText: ref.read(settingsProvider).unitSystem.unitSuffix,
                hintText: "0.00",
                border: const OutlineInputBorder(),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text("Cancel",
                style: GoogleFonts.inter(color: Colors.grey[600])),
          ),
          TextButton(
            onPressed: () {
              final newDepth = double.tryParse(depthController.text);
              if (newDepth != null) {
                ref
                    .read(pileSessionProvider.notifier)
                    .finalizeSession(newDepth);
                Navigator.pop(context);

                final unitSystem = ref.read(settingsProvider).unitSystem;
                if (unitSystem == UnitSystem.imperial) {
                  _showBearingCapacityPrompt(context, ref);
                } else {
                  _showExportOptions(context, ref);
                }
              }
            },
            child: Text("Next",
                style: GoogleFonts.inter(
                    color: Colors.blue, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  void _showBearingCapacityPrompt(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: Text("Bearing Capacity",
            style: GoogleFonts.inter(fontWeight: FontWeight.bold)),
        content: Text("Would you like to calculate bearing capacity?",
            style: GoogleFonts.inter()),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(context); // Close dialog
              _showExportOptions(context, ref); // Show export options
            },
            child: Text("No",
                style: GoogleFonts.inter(
                    color: Colors.red[700], fontWeight: FontWeight.bold)),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context); // Close dialog
              Navigator.of(context).push(
                MaterialPageRoute(
                    builder: (context) => const BearingCapacityScreen()),
              );
            },
            child: Text("Yes",
                style: GoogleFonts.inter(
                    color: Colors.green[700], fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  void _showExportOptions(BuildContext context, WidgetRef ref) {
    final sessionState = ref.read(pileSessionProvider);
    final TextEditingController frequencyController =
        TextEditingController(text: "1");

    if (sessionState.logs.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("No log data to export.")),
      );
      return;
    }

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) {
        return StatefulBuilder(builder: (context, setModalState) {
          return Padding(
            padding: EdgeInsets.only(
              bottom: MediaQuery.of(context).viewInsets.bottom,
            ),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: SafeArea(
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 24),
                        child: Text(
                          "Export Pile Stroke Log",
                          style: GoogleFonts.inter(
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                            color: const Color(0xFF424242),
                          ),
                        ),
                      ),
                      const SizedBox(height: 24),

                      // Frequency Input
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 24),
                        child: Row(
                          children: [
                            Expanded(
                              flex: 3,
                              child: Text(
                                "Line Print Frequency\n(every X blows)",
                                style: GoogleFonts.inter(
                                    fontSize: 14, color: Colors.grey[700]),
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              flex: 1,
                              child: TextField(
                                controller: frequencyController,
                                keyboardType: TextInputType.number,
                                textAlign: TextAlign.center,
                                decoration: InputDecoration(
                                  contentPadding:
                                      const EdgeInsets.symmetric(vertical: 8),
                                  border: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),

                      const SizedBox(height: 24),
                      ListTile(
                        leading: const CircleAvatar(
                          backgroundColor: Color(0xFFE8F5E9),
                          child: Icon(Icons.save_alt, color: Colors.green),
                        ),
                        title:
                            Text("Save to Phone", style: GoogleFonts.inter()),
                        subtitle: Text("Saves PDF to Downloads folder",
                            style: GoogleFonts.inter(
                                fontSize: 12, color: Colors.grey[600])),
                        onTap: () async {
                          final preparedSession =
                              await _prepareSessionForExport(context, ref);
                          if (preparedSession == null) {
                            return;
                          }

                          final int freq =
                              int.tryParse(frequencyController.text) ?? 1;
                          final hammer =
                              ref.read(hammerSelectionProvider).selectedHammer;
                          final pileState = ref.read(pileSelectionProvider);
                          final unitSystem =
                              ref.read(settingsProvider).unitSystem;

                          final exportResult = await ExportService.saveToDevice(
                            preparedSession,
                            hammer: hammer,
                            printFrequency: freq,
                            pileState: pileState,
                            pileLength: preparedSession.pileLength,
                            unitSystem: unitSystem,
                          );

                          if (!context.mounted) return;
                          if (!exportResult.success) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(exportResult.message),
                                backgroundColor: Colors.red[700],
                                duration: const Duration(seconds: 4),
                              ),
                            );
                            return;
                          }

                          final syncSummary = await _syncXmlForExport(
                            preparedSession: preparedSession,
                            hammer: hammer,
                            unitSystem: unitSystem,
                          );
                          if (!context.mounted) return;

                          ref.read(pileSessionProvider.notifier).clearSession();
                          Navigator.of(context)
                              .popUntil((route) => route.isFirst);
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                syncSummary.message.isEmpty
                                    ? exportResult.message
                                    : '${exportResult.message}\n${syncSummary.message}',
                              ),
                              backgroundColor: syncSummary.backgroundColor,
                              duration: const Duration(seconds: 4),
                            ),
                          );
                        },
                      ),
                      const Divider(indent: 24, endIndent: 24),
                      ListTile(
                        leading: const CircleAvatar(
                          backgroundColor: Color(0xFFFFEBEE),
                          child: Icon(Icons.share, color: Colors.red),
                        ),
                        title: Text("Share PDF", style: GoogleFonts.inter()),
                        subtitle: Text("Send via email, messaging, etc.",
                            style: GoogleFonts.inter(
                                fontSize: 12, color: Colors.grey[600])),
                        onTap: () async {
                          final preparedSession =
                              await _prepareSessionForExport(context, ref);
                          if (preparedSession == null) {
                            return;
                          }

                          final int freq =
                              int.tryParse(frequencyController.text) ?? 1;
                          final hammer =
                              ref.read(hammerSelectionProvider).selectedHammer;
                          final pileState = ref.read(pileSelectionProvider);
                          final unitSystem =
                              ref.read(settingsProvider).unitSystem;
                          final shareResult = await ExportService.sharePDF(
                            preparedSession,
                            hammer: hammer,
                            printFrequency: freq,
                            pileState: pileState,
                            pileLength: preparedSession.pileLength,
                            unitSystem: unitSystem,
                          );

                          if (!context.mounted) return;
                          if (!shareResult.success) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(shareResult.message),
                                backgroundColor: Colors.red[700],
                                duration: const Duration(seconds: 4),
                              ),
                            );
                            return;
                          }

                          final syncSummary = await _syncXmlForExport(
                            preparedSession: preparedSession,
                            hammer: hammer,
                            unitSystem: unitSystem,
                          );
                          if (!context.mounted) return;

                          ref.read(pileSessionProvider.notifier).clearSession();
                          Navigator.of(context)
                              .popUntil((route) => route.isFirst);
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                syncSummary.message.isEmpty
                                    ? shareResult.message
                                    : '${shareResult.message}\n${syncSummary.message}',
                              ),
                              backgroundColor: syncSummary.backgroundColor,
                              duration: const Duration(seconds: 4),
                            ),
                          );
                        },
                      ),
                      const Divider(indent: 24, endIndent: 24),
                      ListTile(
                        leading: const CircleAvatar(
                          backgroundColor: Color(0xFFE3F2FD),
                          child: Icon(Icons.data_object, color: Colors.blue),
                        ),
                        title: Text("Export DIGGS XML",
                            style: GoogleFonts.inter()),
                        subtitle: Text(
                            "Saves DIGGS 3 XML with test-ready fields",
                            style: GoogleFonts.inter(
                                fontSize: 12, color: Colors.grey[600])),
                        onTap: () async {
                          final preparedSession =
                              await _prepareSessionForExport(context, ref);
                          if (preparedSession == null) {
                            return;
                          }

                          final hammer =
                              ref.read(hammerSelectionProvider).selectedHammer;
                          final unitSystem =
                              ref.read(settingsProvider).unitSystem;

                          final exportResult =
                              await ExportService.saveDiggsXmlToDevice(
                            preparedSession,
                            hammer: hammer,
                            unitSystem: unitSystem,
                          );

                          if (!context.mounted) return;
                          if (!exportResult.success ||
                              exportResult.filePath == null) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(exportResult.message),
                                backgroundColor: Colors.red[700],
                                duration: const Duration(seconds: 4),
                              ),
                            );
                            return;
                          }

                          final syncResult =
                              await ProjectSyncService.syncExportedXml(
                            session: preparedSession,
                            xmlFilePath: exportResult.filePath!,
                          );
                          if (!context.mounted) return;

                          ref.read(pileSessionProvider.notifier).clearSession();
                          Navigator.of(context)
                              .popUntil((route) => route.isFirst);
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                syncResult.message.isEmpty
                                    ? exportResult.message
                                    : '${exportResult.message}\n${syncResult.message}',
                              ),
                              backgroundColor: syncResult.pending
                                  ? Colors.orange[700]
                                  : Colors.green[700],
                              duration: const Duration(seconds: 4),
                            ),
                          );
                        },
                      ),
                      const Divider(indent: 24, endIndent: 24),
                      ListTile(
                        leading: const CircleAvatar(
                          backgroundColor: Color(0xFFF5F5F5),
                          child: Icon(Icons.delete_outline, color: Colors.grey),
                        ),
                        title: Text("Clear Session Data",
                            style: GoogleFonts.inter()),
                        onTap: () {
                          Navigator.pop(context);
                          _confirmClearSession(context, ref);
                        },
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
        });
      },
    );
  }

  Future<({String message, Color backgroundColor})> _syncXmlForExport({
    required SessionState preparedSession,
    required Hammer? hammer,
    required UnitSystem unitSystem,
  }) async {
    final xmlResult = await ExportService.saveDiggsXmlToDevice(
      preparedSession,
      hammer: hammer,
      unitSystem: unitSystem,
    );

    if (!xmlResult.success || xmlResult.filePath == null) {
      return (
        message: 'XML upload queued later: ${xmlResult.message}',
        backgroundColor: const Color(0xFFE65100),
      );
    }

    final syncResult = await ProjectSyncService.syncExportedXml(
      session: preparedSession,
      xmlFilePath: xmlResult.filePath!,
    );

    if (syncResult.pending) {
      return (
        message: syncResult.message,
        backgroundColor: const Color(0xFFE65100),
      );
    }

    return (
      message: syncResult.message,
      backgroundColor: const Color(0xFF2E7D32),
    );
  }

  Future<SessionState?> _prepareSessionForExport(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final session = ref.read(pileSessionProvider);
    if (session.projectLatitude != null && session.projectLongitude != null) {
      return session;
    }

    final locationEnabled = await Geolocator.isLocationServiceEnabled();
    if (!locationEnabled) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content:
                Text('Location services are disabled. Enable GPS to export.'),
          ),
        );
      }
      return null;
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
                'Location permission is required to export with coordinates.'),
          ),
        );
      }
      return null;
    }

    try {
      const locationSettings = LocationSettings(
        accuracy: LocationAccuracy.high,
      );
      final position = await Geolocator.getCurrentPosition(
        locationSettings: locationSettings,
      ).timeout(const Duration(seconds: 12));

      ref.read(pileSessionProvider.notifier).setProjectCoordinates(
            latitude: position.latitude,
            longitude: position.longitude,
          );

      return ref.read(pileSessionProvider);
    } on TimeoutException {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Timed out while fetching location for export.'),
          ),
        );
      }
      return null;
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Unable to fetch location for export: $e'),
          ),
        );
      }
      return null;
    }
  }

  void _confirmClearSession(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: Text("Clear Session?",
            style: GoogleFonts.inter(fontWeight: FontWeight.bold)),
        content: Text(
            "Are you sure you want to clear all log data? This cannot be undone.",
            style: GoogleFonts.inter()),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text("Cancel",
                style: GoogleFonts.inter(color: Colors.grey[600])),
          ),
          TextButton(
            onPressed: () {
              ref.read(pileSessionProvider.notifier).clearSession();
              Navigator.of(context).popUntil((route) => route.isFirst);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text("Session data cleared.")),
              );
            },
            child: Text("Clear",
                style: GoogleFonts.inter(
                    color: Colors.red, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  Widget _buildInfoItem(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Text(label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: GoogleFonts.inter(fontSize: 10, color: Colors.grey)),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: GoogleFonts.inter(fontSize: 13, fontWeight: FontWeight.bold),
        ),
      ],
    );
  }

  Widget _buildTableHeader(String text) {
    return Text(
      text,
      textAlign: TextAlign.center,
      style: GoogleFonts.inter(
        fontSize: 14,
        fontWeight: FontWeight.bold,
        color: Colors.black87,
      ),
    );
  }

  Widget _buildTableCell(String text) {
    return Text(
      text,
      textAlign: TextAlign.center,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: GoogleFonts.inter(fontSize: 14, color: Colors.black87),
    );
  }
}
