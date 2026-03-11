import 'package:csv/csv.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'pile_model.dart';
import 'settings_logic.dart';
import 'package:collection/collection.dart';

// --- Repository ---

class PileRepository {
  /// Map of (pile type, unit system) to list of sections loaded from CSV
  final Map<String, List<PileSection>> _sectionsCache = {};

  static const Map<UnitSystem, Map<PileType, String>> _csvFileNames = {
    UnitSystem.imperial: {
      PileType.hPile: 'assets/h_pile_sections.csv',
      PileType.pipePile: 'assets/pipe_pile_sections.csv',
      PileType.squarePile: 'assets/square_pile_sections.csv',
      PileType.octagonalPile: 'assets/octagonal_pile_sections.csv',
      PileType.circularPile: 'assets/circular_pile_sections.csv',
    },
    UnitSystem.metric: {
      PileType.hPile: 'assets/h_pile_sections_en_10365.csv',
      PileType.pipePile: 'assets/pipe_pile_section_en_10219.csv',
    },
  };

  String _getCacheKey(PileType type, UnitSystem unitSystem) =>
      "${type.name}_${unitSystem.name}";

  /// Load sections for a specific pile type from CSV
  Future<void> loadSectionsForType(PileType type, UnitSystem unitSystem) async {
    final cacheKey = _getCacheKey(type, unitSystem);
    if (_sectionsCache.containsKey(cacheKey)) {
      return; // Already loaded
    }

    final fileName = _csvFileNames[unitSystem]?[type];
    if (fileName == null) {
      _sectionsCache[cacheKey] = [];
      return;
    }

    try {
      final String rawData = await rootBundle.loadString(fileName);
      final List<List<dynamic>> csvData =
          const CsvToListConverter(eol: '\n').convert(rawData);

      // Check if first row is header (contains "Section" or similar)
      int startIndex = 0;
      if (csvData.isNotEmpty) {
        final firstCell = csvData[0][0].toString().toLowerCase();
        if (firstCell.contains('section') ||
            firstCell.contains('size') ||
            firstCell.contains('designation')) {
          startIndex = 1;
        }
      }

      final List<PileSection> sections = [];
      for (int i = startIndex; i < csvData.length; i++) {
        final row = csvData[i];
        if (row.length >= 2) {
          sections.add(PileSection.fromCsvList(row, type));
        }
      }

      _sectionsCache[cacheKey] = sections;
    } catch (e) {
      print(
          "Error loading pile sections for ${type.displayName} ($unitSystem): $e");
      _sectionsCache[cacheKey] = []; // Empty list on error
    }
  }

  /// Get available section sizes for a pile type
  List<String> getSectionSizes(PileType type, UnitSystem unitSystem) {
    final sections = _sectionsCache[_getCacheKey(type, unitSystem)] ?? [];
    return sections.map((s) => s.sectionSize).toList();
  }

  /// Get a specific section by type and size
  PileSection? getSection(
      PileType type, String sectionSize, UnitSystem unitSystem) {
    final sections = _sectionsCache[_getCacheKey(type, unitSystem)] ?? [];
    return sections.firstWhereOrNull((s) => s.sectionSize == sectionSize);
  }
}

final pileRepositoryProvider = Provider<PileRepository>((ref) {
  return PileRepository();
});

// --- State Management ---

class PileSelectionState {
  final UnitSystem unitSystem;
  final PileMaterial? selectedMaterial;
  final PileType? selectedPileType;
  final String? selectedSectionSize;
  final PileSection? selectedSection; // Contains auto-populated data
  final List<String> availableSectionSizes;
  final bool isLoading;
  final String? sectionStatusMessage;

  PileSelectionState({
    required this.unitSystem,
    this.selectedMaterial,
    this.selectedPileType,
    this.selectedSectionSize,
    this.selectedSection,
    this.availableSectionSizes = const [],
    this.isLoading = false,
    this.sectionStatusMessage,
  });

  /// Get available materials based on unit system
  List<PileMaterial> get availableMaterials {
    if (unitSystem == UnitSystem.metric) {
      return [PileMaterial.steel];
    }
    return PileMaterial.values;
  }

  /// Get available pile types based on selected material and unit system
  List<PileType> get availablePileTypes {
    if (selectedMaterial == null) return [];
    final allForMaterial = PileType.forMaterial(selectedMaterial!);
    if (unitSystem == UnitSystem.metric) {
      // For metric, only H-Pile and Pipe Pile (which are Steel)
      return allForMaterial
          .where((t) => t == PileType.hPile || t == PileType.pipePile)
          .toList();
    }
    return allForMaterial;
  }

  PileSelectionState copyWith({
    UnitSystem? unitSystem,
    PileMaterial? selectedMaterial,
    PileType? selectedPileType,
    String? selectedSectionSize,
    PileSection? selectedSection,
    List<String>? availableSectionSizes,
    bool? isLoading,
    String? sectionStatusMessage,
    bool clearPileType = false,
    bool clearSectionSize = false,
    bool clearSection = false,
    bool clearMaterial = false,
    bool clearSectionStatusMessage = false,
  }) {
    return PileSelectionState(
      unitSystem: unitSystem ?? this.unitSystem,
      selectedMaterial:
          clearMaterial ? null : (selectedMaterial ?? this.selectedMaterial),
      selectedPileType:
          clearPileType ? null : (selectedPileType ?? this.selectedPileType),
      selectedSectionSize: clearSectionSize
          ? null
          : (selectedSectionSize ?? this.selectedSectionSize),
      selectedSection:
          clearSection ? null : (selectedSection ?? this.selectedSection),
      availableSectionSizes:
          availableSectionSizes ?? this.availableSectionSizes,
      isLoading: isLoading ?? this.isLoading,
      sectionStatusMessage: clearSectionStatusMessage
          ? null
          : (sectionStatusMessage ?? this.sectionStatusMessage),
    );
  }
}

class PileSelectionNotifier extends StateNotifier<PileSelectionState> {
  final PileRepository _repository;

  PileSelectionNotifier(this._repository, UnitSystem unitSystem)
      : super(PileSelectionState(unitSystem: unitSystem)) {
    // If only one material is available (e.g. Metric), select it automatically
    final materials = state.availableMaterials;
    if (materials.length == 1) {
      state = state.copyWith(selectedMaterial: materials.first);
    }
  }

  /// Update unit system (usually called when settings change)
  void updateUnitSystem(UnitSystem unitSystem) {
    if (state.unitSystem == unitSystem) return;

    // Reset state when units change as CSVs and available types change
    state = PileSelectionState(unitSystem: unitSystem);
  }

  /// Called when user selects a pile material
  void selectMaterial(PileMaterial? material) {
    if (material == null || material == state.selectedMaterial) return;

    // Reset downstream selections when material changes
    state = state.copyWith(
      selectedMaterial: material,
      clearPileType: true,
      clearSectionSize: true,
      clearSection: true,
      availableSectionSizes: [],
      clearSectionStatusMessage: true,
    );
  }

  /// Called when user selects a pile type
  Future<void> selectPileType(PileType? pileType) async {
    if (pileType == null || pileType == state.selectedPileType) return;

    // Show loading while fetching sections
    state = state.copyWith(
      selectedPileType: pileType,
      isLoading: true,
      clearSectionSize: true,
      clearSection: true,
      availableSectionSizes: [],
      clearSectionStatusMessage: true,
    );

    // Load sections for this pile type and unit system
    await _repository.loadSectionsForType(pileType, state.unitSystem);

    // Update state with available section sizes
    final sectionSizes =
        _repository.getSectionSizes(pileType, state.unitSystem);
    final statusMessage = sectionSizes.isEmpty
        ? "No section data available for ${pileType.displayName} (${state.unitSystem.displayName})."
        : null;

    state = state.copyWith(
      availableSectionSizes: sectionSizes,
      isLoading: false,
      sectionStatusMessage: statusMessage,
      clearSectionStatusMessage: statusMessage == null,
    );
  }

  /// Called when user selects a section size
  void selectSectionSize(String? sectionSize) {
    if (sectionSize == null || state.selectedPileType == null) return;

    final section = _repository.getSection(
        state.selectedPileType!, sectionSize, state.unitSystem);

    state = state.copyWith(
      selectedSectionSize: sectionSize,
      selectedSection: section,
    );
  }
}

final pileSelectionProvider =
    StateNotifierProvider<PileSelectionNotifier, PileSelectionState>((ref) {
  final repo = ref.watch(pileRepositoryProvider);
  final settings = ref.watch(settingsProvider);
  final notifier = PileSelectionNotifier(repo, settings.unitSystem);

  // We don't need to manually listen here if we just recreate the notifier,
  // but it's better to recreate it when units change to ensure fresh state.
  return notifier;
});
