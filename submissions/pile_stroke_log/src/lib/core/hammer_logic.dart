import 'package:csv/csv.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'hammer_model.dart';
import 'package:collection/collection.dart'; // For firstWhereOrNull

// --- Repository ---

class HammerRepository {
  List<Hammer> _hammers = [];

  Future<void> loadHammers() async {
    try {
      final String rawData = await rootBundle.loadString('assets/hammer_database.csv');
      final List<List<dynamic>> csvData = const CsvToListConverter(eol: '\n').convert(rawData);

      // Skip header if present (Assuming row 0 is header)
      // Check if first row contains "Manufacturer"
      int startIndex = 0;
      if (csvData.isNotEmpty && csvData[0][0].toString().toLowerCase().contains('manufacturer')) {
        startIndex = 1;
      }

      _hammers = [];
      for (int i = startIndex; i < csvData.length; i++) {
        final row = csvData[i];
        if (row.length >= 5) {
          final make = row[0]?.toString().trim() ?? '';
          final model = row[1]?.toString().trim() ?? '';
          if (make.isNotEmpty && model.isNotEmpty) {
            _hammers.add(Hammer.fromCsvList(row));
          }
        }
      }
    } catch (e) {
      print("Error loading hammer database: $e");
    }
  }

  List<String> getManufacturers() {
    return _hammers.map((h) => h.make).toSet().toList();
  }

  List<String> getModels(String make) {
    return _hammers
        .where((h) => h.make == make)
        .map((h) => h.model)
        .toSet()
        .toList();
  }

  Hammer? getHammer(String make, String model) {
    return _hammers.firstWhereOrNull(
      (h) => h.make == make && h.model == model,
    );
  }
}

final hammerRepositoryProvider = Provider<HammerRepository>((ref) {
  return HammerRepository();
});

// --- State Management ---

class HammerSelectionState {
  final List<String> availableMakes; // To populate first dropdown
  final List<String> availableModels; // To populate second dropdown
  final String? selectedMake;
  final String? selectedModel;
  final Hammer? selectedHammer; // Contains auto-populated data
  final bool isLoading;

  HammerSelectionState({
    this.availableMakes = const [],
    this.availableModels = const [],
    this.selectedMake,
    this.selectedModel,
    this.selectedHammer,
    this.isLoading = true,
  });

  HammerSelectionState copyWith({
    List<String>? availableMakes,
    List<String>? availableModels,
    String? selectedMake,
    String? selectedModel,
    Hammer? selectedHammer,
    bool? isLoading,
  }) {
    return HammerSelectionState(
      availableMakes: availableMakes ?? this.availableMakes,
      availableModels: availableModels ?? this.availableModels,
      selectedMake: selectedMake, // Allow null
      selectedModel: selectedModel, // Allow null
      selectedHammer: selectedHammer, // Allow null
      isLoading: isLoading ?? this.isLoading,
    );
  }
}

class HammerSelectionNotifier extends StateNotifier<HammerSelectionState> {
  final HammerRepository _repository;

  HammerSelectionNotifier(this._repository)
      : super(HammerSelectionState()) {
    _init();
  }

  Future<void> _init() async {
    await _repository.loadHammers();
    state = state.copyWith(
      isLoading: false,
      availableMakes: _repository.getManufacturers(),
    );
  }

  void selectMake(String? make) {
    if (make == null || make == state.selectedMake) return;
    
    final models = _repository.getModels(make);
    state = HammerSelectionState( // Reset selection
      availableMakes: state.availableMakes,
      availableModels: models,
      selectedMake: make,
      selectedModel: null,
      selectedHammer: null,
      isLoading: false,
    );
  }

  void selectModel(String? model) {
    if (model == null || state.selectedMake == null) return;

    final hammer = _repository.getHammer(state.selectedMake!, model);
    
    // We update state using current values + new selection
    // Note: Can't easily use copyWith for nulling out fields without explicit null handling logic above
    // So for clarity, I will construct a new state preserving what needs to be preserved.
    state = HammerSelectionState(
      availableMakes: state.availableMakes,
      availableModels: state.availableModels,
      selectedMake: state.selectedMake,
      selectedModel: model,
      selectedHammer: hammer,
      isLoading: false,
    );
  }
}

final hammerSelectionProvider =
    StateNotifierProvider<HammerSelectionNotifier, HammerSelectionState>((ref) {
  final repo = ref.watch(hammerRepositoryProvider);
  return HammerSelectionNotifier(repo);
});
