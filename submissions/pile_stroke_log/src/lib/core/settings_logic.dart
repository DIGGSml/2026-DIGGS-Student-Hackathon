import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum UnitSystem {
  imperial('Imperial (ft)', 'ft'),
  metric('Metric (m)', 'm');

  final String displayName;
  final String unitSuffix;
  const UnitSystem(this.displayName, this.unitSuffix);
}

class SettingsState {
  final UnitSystem unitSystem;

  SettingsState({
    this.unitSystem = UnitSystem.imperial,
  });

  SettingsState copyWith({
    UnitSystem? unitSystem,
  }) {
    return SettingsState(
      unitSystem: unitSystem ?? this.unitSystem,
    );
  }
}

class SettingsNotifier extends StateNotifier<SettingsState> {
  static const String _unitKey = 'unit_system';
  final SharedPreferences _prefs;

  SettingsNotifier(this._prefs) : super(SettingsState()) {
    _loadSettings();
  }

  void _loadSettings() {
    final unitIndex = _prefs.getInt(_unitKey) ?? 0;
    state = state.copyWith(
      unitSystem: UnitSystem.values[unitIndex.clamp(0, UnitSystem.values.length - 1)],
    );
  }

  Future<void> setUnitSystem(UnitSystem unit) async {
    await _prefs.setInt(_unitKey, unit.index);
    state = state.copyWith(unitSystem: unit);
  }
}

// Global provider for settings
final settingsProvider = StateNotifierProvider<SettingsNotifier, SettingsState>((ref) {
  throw UnimplementedError('Provider not initialized with SharedPreferences');
});

// Future provider to initialize preferences
final sharedPrefsProvider = FutureProvider<SharedPreferences>((ref) async {
  return await SharedPreferences.getInstance();
});
