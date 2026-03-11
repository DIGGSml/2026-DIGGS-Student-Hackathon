import 'package:flutter_riverpod/flutter_riverpod.dart';

// --- Data Models ---

class BlowDetail {
  final double strokeHeight;
  final DateTime timestamp;

  BlowDetail({
    required this.strokeHeight,
    required this.timestamp,
  });
}

class PileLogEntry {
  final double
      depth; // Penetration depth or current elevation? User said "Depth (ft)" in log.
  final int blowCount;
  final DateTime timestamp;
  final double stroke; // Calculated stroke for this interval
  final List<BlowDetail> blows; // Individual blow details

  PileLogEntry({
    required this.depth,
    required this.blowCount,
    required this.timestamp,
    required this.stroke,
    this.blows = const [],
  });
}

class SessionState {
  final String projectName;
  final String projectLocation;
  final double? projectLatitude;
  final double? projectLongitude;
  final String contractorName;
  final String inspectorName;
  final String pileGroup;
  final String pileNumber;
  final String pileLength;
  final double groundElevation;
  final double startDepth;
  final double maxHammerStroke; // Maximum rated stroke of selected hammer

  final double currentDepth; // Current penetration depth relative to start
  final List<PileLogEntry> logs;

  // Real-time tracking for the current interval
  final int currentIntervalBlowCount;
  final double
      currentIntervalStrokeSum; // To average stroke over the interval? Or just latest?
  // Usually for a log entry (1ft), you'd average the stroke or take the max/min.
  // I will average the stroke for the interval.
  final int strokeSampleCount;
  final List<BlowDetail> currentIntervalBlows; // Track individual blows
  final bool
      isBearingCapacityCalculated; // NEW: Track if calculation was performed

  SessionState({
    this.projectName = '',
    this.projectLocation = '',
    this.projectLatitude,
    this.projectLongitude,
    this.contractorName = '',
    this.inspectorName = '',
    this.pileGroup = '',
    this.pileNumber = '',
    this.pileLength = '',
    this.groundElevation = 0.0,
    this.startDepth = 0.0,
    this.maxHammerStroke = 999.0, // Default to large value if not set
    this.currentDepth = 0.0,
    this.logs = const [],
    this.currentIntervalBlowCount = 0,
    this.currentIntervalStrokeSum = 0.0,
    this.strokeSampleCount = 0,
    this.currentIntervalBlows = const [],
    this.isBearingCapacityCalculated = false,
  });

  SessionState copyWith({
    String? projectName,
    String? projectLocation,
    double? projectLatitude,
    double? projectLongitude,
    String? contractorName,
    String? inspectorName,
    String? pileGroup,
    String? pileNumber,
    String? pileLength,
    double? groundElevation,
    double? startDepth,
    double? maxHammerStroke,
    double? currentDepth,
    List<PileLogEntry>? logs,
    int? currentIntervalBlowCount,
    double? currentIntervalStrokeSum,
    int? strokeSampleCount,
    List<BlowDetail>? currentIntervalBlows,
    bool? isBearingCapacityCalculated,
  }) {
    return SessionState(
      projectName: projectName ?? this.projectName,
      projectLocation: projectLocation ?? this.projectLocation,
      projectLatitude: projectLatitude ?? this.projectLatitude,
      projectLongitude: projectLongitude ?? this.projectLongitude,
      contractorName: contractorName ?? this.contractorName,
      inspectorName: inspectorName ?? this.inspectorName,
      pileGroup: pileGroup ?? this.pileGroup,
      pileNumber: pileNumber ?? this.pileNumber,
      pileLength: pileLength ?? this.pileLength,
      groundElevation: groundElevation ?? this.groundElevation,
      startDepth: startDepth ?? this.startDepth,
      maxHammerStroke: maxHammerStroke ?? this.maxHammerStroke,
      currentDepth: currentDepth ?? this.currentDepth,
      logs: logs ?? this.logs,
      currentIntervalBlowCount:
          currentIntervalBlowCount ?? this.currentIntervalBlowCount,
      currentIntervalStrokeSum:
          currentIntervalStrokeSum ?? this.currentIntervalStrokeSum,
      strokeSampleCount: strokeSampleCount ?? this.strokeSampleCount,
      currentIntervalBlows: currentIntervalBlows ?? this.currentIntervalBlows,
      isBearingCapacityCalculated:
          isBearingCapacityCalculated ?? this.isBearingCapacityCalculated,
    );
  }
}

// --- Notifier ---

class PileSessionNotifier extends StateNotifier<SessionState> {
  PileSessionNotifier() : super(SessionState());

  void startSession({
    required String projectName,
    required String projectLocation,
    double? projectLatitude,
    double? projectLongitude,
    required String contractorName,
    required String inspectorName,
    required String pileGroup,
    required String pileNumber,
    required String pileLength,
    required double groundElevation,
    required double startDepth,
    required double maxHammerStroke,
  }) {
    state = SessionState(
      projectName: projectName,
      projectLocation: projectLocation,
      projectLatitude: projectLatitude,
      projectLongitude: projectLongitude,
      contractorName: contractorName,
      inspectorName: inspectorName,
      pileGroup: pileGroup,
      pileNumber: pileNumber,
      pileLength: pileLength,
      groundElevation: groundElevation,
      startDepth: startDepth,
      maxHammerStroke: maxHammerStroke,
      currentDepth: startDepth,
      logs: [],
    );
  }

  void setProjectCoordinates({
    required double latitude,
    required double longitude,
  }) {
    state = state.copyWith(
      projectLatitude: latitude,
      projectLongitude: longitude,
    );
  }

  void setProjectLocation(String location) {
    state = state.copyWith(projectLocation: location);
  }

  // Called when audio processor detects a blow with specific BPM/Stroke
  void recordBlow(double strokeHeight) {
    final newBlow = BlowDetail(
      strokeHeight: strokeHeight,
      timestamp: DateTime.now(),
    );

    // Only increment blow count if it has a realistic stroke height (> 0.5 ft)
    // OR if it is the very first blow of the interval.
    // This helps filter out the "immediate false triggers" described by the user.
    final bool shouldIncrementCount =
        strokeHeight > 0.5 || state.currentIntervalBlowCount == 0;

    // A stroke is valid for averaging if it is between 0.5 ft and the hammer's rated maximum.
    final bool isValidStroke =
        strokeHeight > 0.5 && strokeHeight <= state.maxHammerStroke;

    state = state.copyWith(
      currentIntervalBlowCount: shouldIncrementCount
          ? state.currentIntervalBlowCount + 1
          : state.currentIntervalBlowCount,
      currentIntervalStrokeSum: isValidStroke
          ? state.currentIntervalStrokeSum + strokeHeight
          : state.currentIntervalStrokeSum,
      strokeSampleCount:
          isValidStroke ? state.strokeSampleCount + 1 : state.strokeSampleCount,
      currentIntervalBlows: shouldIncrementCount
          ? [...state.currentIntervalBlows, newBlow]
          : state.currentIntervalBlows,
    );
  }

  // Called when user presses "Increment" (driven 1 ft)
  void incrementDepth() {
    final double avgStroke = state.strokeSampleCount > 0
        ? state.currentIntervalStrokeSum / state.strokeSampleCount
        : 0.0;

    // Calculate next depth: round up to next whole number if current has decimal,
    // otherwise just add 1.0
    double newDepth;
    if (state.currentDepth % 1.0 != 0) {
      // Has decimal - round up to next whole number
      newDepth = state.currentDepth.ceilToDouble();
    } else {
      // Already whole number - just add 1
      newDepth = state.currentDepth + 1.0;
    }

    final newLog = PileLogEntry(
      depth: newDepth, // Use the target depth for the log entry
      blowCount: state.currentIntervalBlowCount,
      timestamp: DateTime.now(),
      stroke: avgStroke,
      blows: state
          .currentIntervalBlows, // Store all counted blows for accurate PDF reporting
    );

    state = state.copyWith(
      logs: [newLog, ...state.logs], // Add to front for reverse chrono order
      currentDepth: newDepth,
      currentIntervalBlowCount: 0,
      currentIntervalStrokeSum: 0.0,
      strokeSampleCount: 0,
      currentIntervalBlows: [], // Clear blows for next interval
    );
  }

  void clearSession() {
    state = SessionState(
      projectName: state.projectName,
      // Others reset to defaults
    );
  }

  void setBearingCapacityCalculated(bool calculated) {
    state = state.copyWith(isBearingCapacityCalculated: calculated);
  }

  void finalizeSession(double finalDepth) {
    // Calculate stats for pending blows
    final double avgStroke = state.strokeSampleCount > 0
        ? state.currentIntervalStrokeSum / state.strokeSampleCount
        : 0.0;

    // If we have data, create a log entry
    List<PileLogEntry> updatedLogs = state.logs;

    // Only add a log entry if we have blows.
    if (state.currentIntervalBlowCount > 0) {
      final newLog = PileLogEntry(
        depth: finalDepth,
        blowCount: state.currentIntervalBlowCount,
        timestamp: DateTime.now(),
        stroke: avgStroke,
        blows: state.currentIntervalBlows,
      );
      updatedLogs = [newLog, ...state.logs];
    }

    state = state.copyWith(
      currentDepth: finalDepth,
      logs: updatedLogs,
      currentIntervalBlowCount: 0,
      currentIntervalStrokeSum: 0.0,
      strokeSampleCount: 0,
      currentIntervalBlows: [],
    );
  }
}

final pileSessionProvider =
    StateNotifierProvider<PileSessionNotifier, SessionState>((ref) {
  return PileSessionNotifier();
});
