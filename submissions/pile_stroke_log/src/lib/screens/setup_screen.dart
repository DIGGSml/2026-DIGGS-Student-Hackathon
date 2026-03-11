import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../core/auth_logic.dart';
import '../core/hammer_logic.dart';
import '../core/pile_session_logic.dart';
import '../core/settings_logic.dart';
import '../widgets/hammer_selection_widget.dart';
import '../widgets/pile_selection_widget.dart';
import 'log_screen.dart';
import 'saved_projects_screen.dart';

class SetupScreen extends ConsumerStatefulWidget {
  const SetupScreen({super.key});

  @override
  ConsumerState<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends ConsumerState<SetupScreen> {
  static const bool _prefillTestDataEnabled =
      bool.fromEnvironment('PREFILL_TEST_DATA', defaultValue: false);

  final _formKey = GlobalKey<FormState>();
  final _projectController = TextEditingController();
  final _projectLocationController = TextEditingController();
  final _contractorNameController = TextEditingController();
  final _inspectorNameController = TextEditingController();
  final _pileGroupController = TextEditingController();
  final _pileNumberController = TextEditingController();
  final _pileLengthController = TextEditingController();
  final _groundElevationController = TextEditingController();
  final _startDepthController = TextEditingController();

  @override
  void initState() {
    super.initState();

    // Initialize from current session state if we navigated back.
    final currentState = ref.read(pileSessionProvider);
    _projectController.text = currentState.projectName;
    _projectLocationController.text = currentState.projectLocation;
    _contractorNameController.text = currentState.contractorName;
    _inspectorNameController.text = currentState.inspectorName;
    _pileGroupController.text = currentState.pileGroup;
    _pileNumberController.text = currentState.pileNumber;
    _pileLengthController.text = currentState.pileLength;

    if (currentState.groundElevation != 0.0) {
      _groundElevationController.text = currentState.groundElevation.toString();
    }
    if (currentState.startDepth != 0.0) {
      _startDepthController.text = currentState.startDepth.toString();
    }

    _applyPrefillIfEnabled();
  }

  void _applyPrefillIfEnabled() {
    if (!_prefillTestDataEnabled || !kDebugMode) return;

    if (_projectController.text.trim().isEmpty) {
      _projectController.text = 'Doc Export Test';
    }
    if (_projectLocationController.text.trim().isEmpty) {
      _projectLocationController.text = 'Kansas City, MO';
    }
    if (_contractorNameController.text.trim().isEmpty) {
      _contractorNameController.text = 'Test Contractor';
    }
    if (_inspectorNameController.text.trim().isEmpty) {
      _inspectorNameController.text = 'Test Inspector';
    }
    if (_pileGroupController.text.trim().isEmpty) {
      _pileGroupController.text = 'Pier A';
    }
    if (_pileNumberController.text.trim().isEmpty) {
      _pileNumberController.text = '1';
    }
    if (_pileLengthController.text.trim().isEmpty) {
      _pileLengthController.text = '100';
    }
    if (_groundElevationController.text.trim().isEmpty) {
      _groundElevationController.text = '100.0';
    }
    if (_startDepthController.text.trim().isEmpty) {
      _startDepthController.text = '0.0';
    }
  }

  @override
  void dispose() {
    _projectController.dispose();
    _projectLocationController.dispose();
    _contractorNameController.dispose();
    _inspectorNameController.dispose();
    _pileGroupController.dispose();
    _pileNumberController.dispose();
    _pileLengthController.dispose();
    _groundElevationController.dispose();
    _startDepthController.dispose();
    super.dispose();
  }

  void _startLog() {
    if (_formKey.currentState!.validate()) {
      // Get the selected hammer's max stroke
      final hammerState = ref.read(hammerSelectionProvider);
      final double maxStroke = hammerState.selectedHammer?.stroke ?? 999.0;

      // Save details to provider
      ref.read(pileSessionProvider.notifier).startSession(
            projectName: _projectController.text,
            projectLocation: _projectLocationController.text,
            contractorName: _contractorNameController.text,
            inspectorName: _inspectorNameController.text,
            pileGroup: _pileGroupController.text,
            pileNumber: _pileNumberController.text,
            pileLength: _pileLengthController.text,
            groundElevation: double.parse(_groundElevationController.text),
            startDepth: double.parse(_startDepthController.text),
            maxHammerStroke: maxStroke,
          );

      // Navigate to Log Screen
      Navigator.of(
        context,
      ).push(MaterialPageRoute(builder: (context) => const LogScreen()));
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);
    final authBypass = ref.watch(authBypassProvider);

    // Listen for session resets to clear fields automatically
    ref.listen(pileSessionProvider, (previous, next) {
      if (next.pileGroup.isEmpty && _pileGroupController.text.isNotEmpty) {
        _projectController.clear();
        _projectLocationController.clear();
        _contractorNameController.clear();
        _inspectorNameController.clear();
        _pileGroupController.clear();
        _pileNumberController.clear();
        _pileLengthController.clear();
        _groundElevationController.clear();
        _startDepthController.clear();
      }
    });

    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA), // Light grey background
      appBar: AppBar(
        centerTitle: true,
        title: Text(
          'Pile Stroke Log',
          style: GoogleFonts.inter(
            fontWeight: FontWeight.bold,
            color: Colors.white,
          ),
        ),
        backgroundColor: const Color(0xFF424242), // Dark grey
        elevation: 0,
        actions: [
          if (!authBypass && authState.user?.email != null)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Center(
                child: Text(
                  authState.user!.email!,
                  style: GoogleFonts.inter(
                    color: Colors.white70,
                    fontSize: 11,
                  ),
                ),
              ),
            ),
          IconButton(
            icon: const Icon(Icons.folder_open, color: Colors.white),
            tooltip: 'Saved Projects',
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (context) => const SavedProjectsScreen(),
                ),
              );
            },
          ),
          if (!authBypass)
            IconButton(
              icon: const Icon(Icons.logout, color: Colors.white),
              tooltip: 'Logout',
              onPressed: () async {
                ref.read(pileSessionProvider.notifier).clearSession();
                await ref.read(authProvider.notifier).signOut();
              },
            ),
          IconButton(
            icon: const Icon(Icons.settings, color: Colors.white),
            onPressed: () => _showSettingsDialog(context),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24.0),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _buildSectionHeader('Project Details'),
              _buildTextField(
                controller: _projectController,
                hint: '[Enter Project Name]',
                label: 'Project Name',
                textCapitalization: TextCapitalization.words,
              ),
              _buildTextField(
                controller: _projectLocationController,
                hint: '[Enter Project Location]',
                label: 'Project Location',
                textCapitalization: TextCapitalization.words,
              ),
              _buildTextField(
                controller: _contractorNameController,
                hint: '[Enter Contractor Name]',
                label: 'Contractor Name',
                textCapitalization: TextCapitalization.words,
              ),
              _buildTextField(
                controller: _inspectorNameController,
                hint: '[Enter Inspector Name]',
                label: 'Inspector Name',
                textCapitalization: TextCapitalization.words,
              ),
              _buildTextField(
                controller: _pileGroupController,
                hint: '[Enter Substructure Element]',
                label: 'Substructure Element',
                textCapitalization: TextCapitalization.words,
              ),
              _buildTextField(
                controller: _pileNumberController,
                hint: '[Enter Pile Number]',
                label: 'Pile Number',
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
              ),
              _buildTextField(
                controller: _pileLengthController,
                hint: '[Enter Pile Length]',
                label:
                    'Pile Length (${ref.watch(settingsProvider).unitSystem.unitSuffix})',
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
              ),
              const SizedBox(height: 24),
              _buildSectionHeader('Reference Levels'),
              _buildTextField(
                controller: _groundElevationController,
                hint: '[Enter Elevation]',
                label:
                    'Ground Elevation (${ref.watch(settingsProvider).unitSystem.unitSuffix})',
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
              ),
              _buildTextField(
                controller: _startDepthController,
                hint: '[Enter Depth]',
                label:
                    'Pile Penetration Depth (${ref.watch(settingsProvider).unitSystem.unitSuffix})',
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
              ),
              const PileSelectionWidget(),
              const SizedBox(height: 24),
              const HammerSelectionWidget(),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton(
                  onPressed: _startLog,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.green[700],
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  child: Text(
                    'Start',
                    style: GoogleFonts.inter(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8.0),
      child: Text(
        title,
        style: GoogleFonts.inter(fontSize: 14, color: Colors.grey[600]),
      ),
    );
  }

  Widget _buildTextField({
    required TextEditingController controller,
    required String hint,
    required String label,
    TextInputType keyboardType = TextInputType.text,
    TextCapitalization textCapitalization = TextCapitalization.none,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16.0),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(8),
        ),
        child: TextFormField(
          controller: controller,
          keyboardType: keyboardType,
          textCapitalization: textCapitalization,
          decoration: InputDecoration(
            labelText: label,
            hintText: hint,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide.none,
            ),
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 16,
              vertical: 12,
            ),
          ),
          validator: (value) {
            if (value == null || value.isEmpty) return 'Required';
            return null;
          },
        ),
      ),
    );
  }

  void _showSettingsDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) => Consumer(
        builder: (context, ref, child) {
          final currentUnit = ref.watch(settingsProvider).unitSystem;
          return AlertDialog(
            scrollable: true,
            title: Text(
              'App Settings',
              style: GoogleFonts.inter(fontWeight: FontWeight.bold),
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Unit System',
                  style: GoogleFonts.inter(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 12),
                SegmentedButton<UnitSystem>(
                  segments: UnitSystem.values
                      .map(
                        (unit) => ButtonSegment<UnitSystem>(
                          value: unit,
                          label: Text(unit.displayName,
                              style: GoogleFonts.inter()),
                        ),
                      )
                      .toList(),
                  selected: {currentUnit},
                  showSelectedIcon: false,
                  onSelectionChanged: (selection) {
                    if (selection.isEmpty) return;
                    ref
                        .read(settingsProvider.notifier)
                        .setUnitSystem(selection.first);
                  },
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: Text('Close', style: GoogleFonts.inter()),
              ),
            ],
          );
        },
      ),
    );
  }
}
