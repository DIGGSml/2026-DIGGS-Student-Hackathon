import 'dart:async';
import 'dart:io';
import 'dart:math' as dart_math;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'settings_logic.dart';
import 'package:mic_stream/mic_stream.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

// --- State Definition ---
class SaximeterState {
  final bool isRecording;
  final bool isCalibrating; // NEW: Is calibration mode active?
  final double threshold; // NEW: Dynamic threshold

  final int strokeCount;
  final double latestStrokeHeight; // Peak amplitude (0.0 - 1.0)
  final double latestBPM; // Calculated BPM
  final double lastCalculatedStroke; // Calculated Stroke in ft
  final List<double> waveformBuffer; // Recent samples for visualization

  final double baselineRMS; // Stored baseline noise
  final double customThresholdMultiplier; // User adjustable multiplier
  final bool isAutoSensitivity; // NEW: Should the app self-adjust?

  SaximeterState({
    this.isRecording = false,
    this.isCalibrating = false,
    this.threshold = 0.6, // Default safety threshold
    this.strokeCount = 0,
    this.latestStrokeHeight = 0.0,
    this.latestBPM = 0.0,
    this.lastCalculatedStroke = 0.0,
    this.waveformBuffer = const [],
    this.baselineRMS = 0.0,
    this.customThresholdMultiplier = 12.0,
    this.isAutoSensitivity = false,
  });

  SaximeterState copyWith({
    bool? isRecording,
    bool? isCalibrating,
    double? threshold,
    int? strokeCount,
    double? latestStrokeHeight,
    double? latestBPM,
    double? lastCalculatedStroke,
    List<double>? waveformBuffer,
    double? baselineRMS,
    double? customThresholdMultiplier,
    bool? isAutoSensitivity,
  }) {
    return SaximeterState(
      isRecording: isRecording ?? this.isRecording,
      isCalibrating: isCalibrating ?? this.isCalibrating,
      threshold: threshold ?? this.threshold,
      strokeCount: strokeCount ?? this.strokeCount,
      latestStrokeHeight: latestStrokeHeight ?? this.latestStrokeHeight,
      latestBPM: latestBPM ?? this.latestBPM,
      lastCalculatedStroke: lastCalculatedStroke ?? this.lastCalculatedStroke,
      waveformBuffer: waveformBuffer ?? this.waveformBuffer,
      baselineRMS: baselineRMS ?? this.baselineRMS,
      customThresholdMultiplier:
          customThresholdMultiplier ?? this.customThresholdMultiplier,
      isAutoSensitivity: isAutoSensitivity ?? this.isAutoSensitivity,
    );
  }
}

// --- Notifier Provider ---
class AudioProcessor extends StateNotifier<SaximeterState> {
  StreamSubscription<List<int>>? _micSubscription;
  Stream<List<int>>? _micStream;

  // Audio Processing Parameters
  static const int _sampleRate = 44100;
  static const int _calibrationDurationMs = 3000;

  // 400ms max duration for high-frequency impact pulse
  static const int _maxDurationSamples = 17640;
  // 800ms debounce @ 44.1kHz = 35280 samples
  static const int _debounceSamples = 35280;

  int _lastStrokeSampleIndex = 0; // Sample index of the last valid stroke peak

  // Filter State (FIR Band Pass: 300Hz - 2500Hz, 64-tap Linear Phase)
  final List<double> _firBuffer = List.filled(64, 0.0);
  int _firIndex = 0;

  static const List<double> _firCoefficients = [
    0.0,
    -5.071613e-05,
    -0.0001963615,
    -0.0003976574,
    -0.0005839158,
    -0.0006727263,
    -0.0005978698,
    -0.0003392776,
    5.251454e-05,
    0.0004447906,
    0.0006295021,
    0.000350827,
    -0.0006484166,
    -0.002567637,
    -0.005486318,
    -0.009310641,
    -0.0137407,
    -0.01826799,
    -0.02220859,
    -0.0247718,
    -0.02515789,
    -0.02267284,
    -0.01684394,
    -0.007518266,
    0.00507258,
    0.0202945,
    0.03714616,
    0.05434631,
    0.07046433,
    0.08407789,
    0.09393731,
    0.09911423,
    0.09911423,
    0.09393731,
    0.08407789,
    0.07046433,
    0.05434631,
    0.03714616,
    0.0202945,
    0.00507258,
    -0.007518266,
    -0.01684394,
    -0.02267284,
    -0.02515789,
    -0.0247718,
    -0.02220859,
    -0.01826799,
    -0.0137407,
    -0.009310641,
    -0.005486318,
    -0.002567637,
    -0.0006484166,
    0.000350827,
    0.0006295021,
    0.0004447906,
    5.251454e-05,
    -0.0003392776,
    -0.0005978698,
    -0.0006727263,
    -0.0005839158,
    -0.0003976574,
    -0.0001963615,
    -5.071613e-05,
    0.0
  ];

  // Envelope Follower State: Ultra-Fast Attack (for precise timing)
  static const double _attackAlpha = 0.2;
  static const double _releaseAlpha = 0.001;
  double _envelope = 0.0;

  // Calibration State
  final List<double> _calibrationRMSValues = [];
  Timer? _calibrationTimer;

  // Pulse Tracking State
  int _totalProcessedSamples = 0;
  bool _isTrackingPulse = false;
  int _pulseStartSample = 0;
  double _pulsePeakAmp = 0.0;
  int _pulseTimingSample = 0; // Locked impact point

  // Trigger Confirmation (Energy Accumulation)
  bool _isConfirmingTrigger = false;
  double _triggerAccumulator = 0.0;
  int _triggerSampleCount = 0;
  int _candidatePulseStartSample = 0;

  // History Buffer for "Earliest Peak" Logic (Size 2048 covers ~46ms)
  final List<double> _ampHistory = List.filled(2048, 0.0);
  int _ampHistoryIndex = 0;

  // Look-Back Rolling Peak (30ms) for Jitter Elimination
  double _rollingMaxAbsVal = 0.0;
  int _rollingMaxAbsValSample = 0;
  static const int _lookBackSamples = 1323; // 30ms @ 44.1kHz
  static const int _lookForwardSamples = 441; // 10ms @ 44.1kHz

  double _prevAbsVal = 0.0;
  int _lookForwardEndSample = 0;
  int _cooldownUntilSample = 0; // For debounce

  // Auto-Sensitivity Tracking
  final List<double> _recentBlowPeaks = [];
  static const int _maxBlowHistory = 5;

  final Ref _ref;

  AudioProcessor(this._ref) : super(SaximeterState());

  Future<void> toggleRecording() async {
    if (state.isRecording) {
      await _stopListening();
    } else {
      await _startListening();
    }
  }

  void startCalibration() async {
    if (!state.isRecording) {
      await _startListening();
    }

    // Start Calibration Mode
    _calibrationRMSValues.clear();
    state = state.copyWith(isCalibrating: true);

    // Stop after duration
    _calibrationTimer?.cancel();
    _calibrationTimer =
        Timer(const Duration(milliseconds: _calibrationDurationMs), () {
      _finishCalibration();
    });
  }

  void _finishCalibration() {
    if (_calibrationRMSValues.isEmpty) {
      state = state.copyWith(isCalibrating: false);
      return; // Failed to collect samples
    }

    // Calculate Average RMS (Baseline Noise)
    double sum = 0.0;
    for (var val in _calibrationRMSValues) {
      sum += val;
    }
    final double averageRMS = sum / _calibrationRMSValues.length;

    // Set Threshold = Multiplier x Average RMS
    final double multiplier = state.customThresholdMultiplier;
    final double newThreshold = averageRMS * multiplier;

    // Clamp threshold (e.g., between 0.40 and 0.90)
    final double clampedThreshold = newThreshold.clamp(0.40, 0.90);

    print(
        "Calibration Complete. Noise RMS: $averageRMS, Multiplier: $multiplier, New Threshold: $clampedThreshold");

    _lastStrokeSampleIndex = 0; // Reset stroke timer so next blow is "first"

    state = state.copyWith(
      isCalibrating: false,
      threshold: clampedThreshold,
      baselineRMS: averageRMS,
    );
  }

  void setThresholdMultiplier(double multiplier) {
    // Recalculate threshold based on existing baseline
    final double newThreshold = state.baselineRMS * multiplier;
    final double clampedThreshold = newThreshold.clamp(0.40, 0.90);

    state = state.copyWith(
      customThresholdMultiplier: multiplier,
      threshold: clampedThreshold,
    );
  }

  void toggleAutoSensitivity(bool value) {
    state = state.copyWith(isAutoSensitivity: value);
    if (value) {
      _recentBlowPeaks.clear();
      // Keep existing multiplier as starting point
    }
  }

  Future<void> _startListening() async {
    final status = await Permission.microphone.request();
    if (status != PermissionStatus.granted) {
      print("Microphone permission denied");
      return;
    }

    try {
      final audioSource =
          Platform.isIOS ? AudioSource.DEFAULT : AudioSource.UNPROCESSED;

      _micStream = MicStream.microphone(
        audioSource: audioSource,
        sampleRate: _sampleRate,
        channelConfig: ChannelConfig.CHANNEL_IN_MONO,
        audioFormat: AudioFormat.ENCODING_PCM_16BIT,
      );

      _micSubscription = _micStream?.listen(_onData);
      state = state.copyWith(isRecording: true);

      // Enable Wakelock to keep screen on while recording
      WakelockPlus.toggle(enable: true);

      _lastStrokeSampleIndex = 0;
      // Reset filter state
      _firBuffer.fillRange(0, 64, 0.0);
      _firIndex = 0;

      // Reset Tracking
      _totalProcessedSamples = 0;
      _isTrackingPulse = false;
      _isConfirmingTrigger = false;
      _triggerAccumulator = 0.0;
      _triggerSampleCount = 0;
      _candidatePulseStartSample = 0;
      _cooldownUntilSample = 0;
      _pulsePeakAmp = 0.0;
      _pulseTimingSample = 0;
      _pulseStartSample = 0;
      _rollingMaxAbsVal = 0.0;
      _rollingMaxAbsValSample = 0;
      _lookForwardEndSample = 0;
      _prevAbsVal = 0.0;
      _envelope = 0.0;
    } catch (e) {
      print("Error starting mic stream: $e");
    }
  }

  Future<void> _stopListening() async {
    _micSubscription?.cancel();
    _micSubscription = null;
    _calibrationTimer?.cancel();

    // Disable Wakelock when recording stops
    WakelockPlus.toggle(enable: false);

    state = state.copyWith(isRecording: false, isCalibrating: false);
  }

  void resetStrokeTimer() {
    _lastStrokeSampleIndex = 0;
  }

  void _onData(List<int> samples) {
    if (samples.isEmpty) return;

    // Temporary vars for RMS calc of this chunk
    double sumSquares = 0.0;
    int chunkSampleCount = 0;

    for (int i = 0; i < samples.length; i += 2) {
      if (i + 1 >= samples.length) break;

      final byte1 = samples[i];
      final byte2 = samples[i + 1];
      int s16 = (byte2 << 8) | byte1;
      if (s16 > 32767) s16 -= 65536;

      // Normalize
      final double raw = s16 / 32768.0;

      // FIR Band Pass Filter (300Hz - 2500Hz)
      _firBuffer[_firIndex] = raw;

      double sum = 0.0;
      for (int k = 0; k < 64; k++) {
        // Convolve: sum(h[k] * x[n-k])
        // _firBuffer wraps around. Most recent is at _firIndex.
        // x[n-k] is at (_firIndex - k) % 64.
        // Dart % handles negatives correctly for this if we do (index + 64 - k) % 64
        final int bufferIdx = (_firIndex + 64 - k) % 64;
        sum += _firCoefficients[k] * _firBuffer[bufferIdx];
      }
      _firIndex = (_firIndex + 1) % 64;

      final double filtered = sum;

      final double absVal = filtered.abs(); // Rectified amplitude
      final double rawSlope = absVal - _prevAbsVal;
      _prevAbsVal = absVal;

      // Update History Buffer
      _ampHistory[_ampHistoryIndex] = absVal;
      _ampHistoryIndex = (_ampHistoryIndex + 1) % 2048;

      // Update Smooth Energy Envelope with Fast Attack, Slow Release
      if (absVal > _envelope) {
        _envelope = _envelope + _attackAlpha * (absVal - _envelope);
      } else {
        _envelope = _envelope + _releaseAlpha * (absVal - _envelope);
      }

      // --- Look-Back Rolling Peak Tracking ---
      // We always track the highest high-frequency spike in the last 30ms.
      if (absVal > _rollingMaxAbsVal) {
        _rollingMaxAbsVal = absVal;
        _rollingMaxAbsValSample = _totalProcessedSamples;
      }
      if (_totalProcessedSamples - _rollingMaxAbsValSample > _lookBackSamples) {
        _rollingMaxAbsVal = 0.0;
      }

      // --- Calibration Mode ---
      if (state.isCalibrating) {
        sumSquares += (filtered * filtered);
        chunkSampleCount++;
        continue; // Skip detection logic
      }

      // --- Detection Mode ---
      _totalProcessedSamples++;

      // 1. Debounce / Cooldown Check
      if (_totalProcessedSamples < _cooldownUntilSample) {
        continue;
      }

      // 2. Pulse State Machine
      if (!_isTrackingPulse) {
        if (!_isConfirmingTrigger) {
          // [IDLE STATE]
          // Trigger on SHARP RAW SLOPE or exceeding volume threshold
          if (rawSlope > (state.threshold * 0.6) ||
              _envelope > state.threshold) {
            // START CONFIRMATION WINDOW (3ms)
            _isConfirmingTrigger = true;
            _triggerAccumulator = 0.0;
            _triggerSampleCount = 0;
            _candidatePulseStartSample = _totalProcessedSamples;
          }
        } else {
          // [CONFIRMATION STATE] - Accumulate energy for ~3ms to reject clicks
          _triggerAccumulator += absVal;
          _triggerSampleCount++;

          if (_triggerSampleCount >= 132) {
            // ~3ms @ 44.1kHz
            final double avgEnergy = _triggerAccumulator / _triggerSampleCount;
            _isConfirmingTrigger = false;

            // CHECK: Did the signal sustain enough energy?
            // We use a lower threshold (0.4x) for the average because the attack phase might be ramping up.
            if (avgEnergy > (state.threshold * 0.4)) {
              // CONFIRMED BLOW
              _isTrackingPulse = true;
              _pulseStartSample = _candidatePulseStartSample;
              _pulsePeakAmp = _envelope; // Start with current envelope

              // 2. Look-Forward: Set a window to check the next 10ms (and past 30ms) for logical peak.
              _lookForwardEndSample =
                  _totalProcessedSamples + _lookForwardSamples;
              _rollingMaxAbsVal = 0.0; // Reset for next blow
            } else {
              // FALSE ALARM (Transient click or noise)
              // Just go back to IDLE, no cooldown needed for noise.
              print(
                  "Rejected transient noise (Avg amp: ${avgEnergy.toStringAsFixed(4)})");
            }
          }
        }
      } else {
        // [TRACKING STATE]

        // 1. Update overall envelope peak for validation
        if (_envelope > _pulsePeakAmp) {
          _pulsePeakAmp = _envelope;
        }

        // 2. CENTERING LOGIC: Wait for Look-Forward window to close, then find optimal peak.
        if (_totalProcessedSamples == _lookForwardEndSample) {
          // Window: [Start - 30ms] to [Start + 10ms]
          final int windowStart = _pulseStartSample - 1323; // 30ms
          final int windowEnd =
              _totalProcessedSamples; // Current (10ms after trigger)

          double maxScore = -1.0;
          int bestPeakIndex = _pulseStartSample; // Default

          // Single Pass: Find Peak with Highest Score (Amplitude * Slope)
          for (int i = windowStart; i <= windowEnd; i++) {
            if (i <= 3) continue; // Need i-3 to be valid

            // Circular buffer index lookup
            final double val = _ampHistory[i % 2048];
            // 3-Sample Slope: Rise over ~0.07ms for robustness against noise
            final double prevVal = _ampHistory[(i - 3) % 2048];

            final double slope = val - prevVal;

            // Only consider rising edges with significant amplitude
            if (slope > 0 && val > (state.threshold * 0.2)) {
              // Score: Prioritize sharp impacts (High Slope) AND significant energy (High Amp)
              final double score = val * slope;

              if (score > maxScore) {
                maxScore = score;
                bestPeakIndex = i;
              }
            }
          }

          _pulseTimingSample = bestPeakIndex;
          // print("Peak Centering (Score-Based): Selected peak at ${(_pulseTimingSample - _pulseStartSample)/44.1}ms (Score: $maxScore)");
        }

        final int durationSamples = _totalProcessedSamples - _pulseStartSample;

        // Pulse termination (Drop or Timeout)
        if (_envelope < (state.threshold * 0.5) ||
            durationSamples >= _maxDurationSamples) {
          // Validate and Process
          if (_pulsePeakAmp > state.threshold) {
            // SUCCESSFUL DETECTION
            _processStroke(_pulsePeakAmp, _pulseTimingSample);
            // Ensure lockout covers at least X ms after the peak, AND at least 100ms after the signal dies down
            // to prevent immediate re-triggering if the pulse was forced to terminate by timeout.
            _cooldownUntilSample = dart_math.max(
                _pulseTimingSample + _debounceSamples,
                _totalProcessedSamples + 4410 // 100ms safety buffer
                );
          } else {
            // Optional shadow update to keep rhythmic sync if loud but short
            if (_pulsePeakAmp > state.threshold * 0.8) {
              _lastStrokeSampleIndex = _pulseTimingSample;
            }
          }
          _isTrackingPulse = false;
        }
      }
    }

    // After chunk processing (Calibration)
    if (state.isCalibrating && chunkSampleCount > 0) {
      final double meanSquare = sumSquares / chunkSampleCount;
      final double rms = dart_math.sqrt(meanSquare);
      _calibrationRMSValues.add(rms);
    }
  }

  void _processStroke(double maxAmplitude, int peakSampleIndex) {
    // Note: Debounce is already handled by sample counting logic above.

    // DETECTED STROKE
    double bpm = 0.0;
    double stroke = 0.0;

    if (_lastStrokeSampleIndex != 0) {
      final int deltaSamples = peakSampleIndex - _lastStrokeSampleIndex;

      // Calculate time in seconds: samples / sampleRate
      final double deltaSeconds = deltaSamples / _sampleRate;
      final double deltaMs = deltaSeconds * 1000.0;

      if (deltaMs > 0) {
        print("Stroke Detected: deltaT = ${deltaMs.toStringAsFixed(1)}ms");
        // BPM = 60 / deltaSeconds
        bpm = 60.0 / deltaSeconds;

        final unitSystem = _ref.read(settingsProvider).unitSystem;
        stroke = calculateStrokeDepth(deltaMs, unitSystem);

        // Note: Removed the hard 12.5ft rejection to prevent 'reset to zero' issues.
        // Large values now reflect reality (missing blows) rather than hiding data.
      }
    }

    _lastStrokeSampleIndex = peakSampleIndex;

    state = state.copyWith(
      strokeCount: state.strokeCount + 1,
      latestStrokeHeight: maxAmplitude,
      latestBPM: bpm,
      lastCalculatedStroke: stroke,
    );

    // Adaptive Auto-Sensitivity Logic
    if (state.isAutoSensitivity) {
      _recentBlowPeaks.add(maxAmplitude);
      if (_recentBlowPeaks.length > _maxBlowHistory) {
        _recentBlowPeaks.removeAt(0);
      }

      if (_recentBlowPeaks.length >= 3) {
        // Calculate average peak of recent blows
        double sumPeaks = 0;
        for (var p in _recentBlowPeaks) {
          sumPeaks += p;
        }
        final double avgPeak = sumPeaks / _recentBlowPeaks.length;

        // Set threshold halfway between background noise and impact peak
        // Multiplier = (AvgPeak / baselineRMS) / 2
        if (state.baselineRMS > 0) {
          // Set threshold at 70% of the peak level
          final double peakToNoiseRatio = avgPeak / state.baselineRMS;
          double targetMultiplier = (peakToNoiseRatio * 0.7);

          // Clamp for safety
          if (targetMultiplier < 4.0) targetMultiplier = 4.0;
          if (targetMultiplier > 30.0) targetMultiplier = 30.0;

          // Apply adjustment
          setThresholdMultiplier(targetMultiplier);
          print(
              "Auto-Sensitivity: Adjusted multiplier to ${targetMultiplier.toStringAsFixed(1)} based on avg blow peak ${avgPeak.toStringAsFixed(3)}");
        }
      }
    }
  }

  /// Calculates stroke depth based on time between strokes (deltaMs).
  /// Formula: stroke = 1/2 * g * (T/2)^2 - offset
  /// For Imperial: g = 32.174 ft/s^2, offset = 0.328 ft
  /// For Metric: g = 9.80665 m/s^2, offset = 0.1 m
  static double calculateStrokeDepth(double deltaMs, UnitSystem unitSystem) {
    if (deltaMs <= 0) return 0.0;

    final bool isMetric = unitSystem == UnitSystem.metric;
    final double g = isMetric ? 9.80665 : 32.174;
    final double offset = isMetric ? 0.1 : 0.328;

    final double tSeconds = deltaMs / 1000.0; // Period T in seconds

    // stroke = 1/2 * g * (T/2)^2 - offset
    final double halfT = tSeconds / 2.0;
    final double stroke = 0.5 * g * (halfT * halfT) - offset;

    // Ensure we don't return negative values
    return stroke > 0 ? stroke : 0.0;
  }

  @override
  void dispose() {
    _stopListening();
    _calibrationTimer?.cancel();
    super.dispose();
  }
}

// --- Provider ---
final audioProcessorProvider =
    StateNotifierProvider<AudioProcessor, SaximeterState>((ref) {
  return AudioProcessor(ref);
});
