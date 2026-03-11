import 'package:flutter_test/flutter_test.dart';
import 'package:pile_stroke_log/core/audio_processor.dart';
import 'package:pile_stroke_log/core/settings_logic.dart';

void main() {
  group('AudioProcessor Logic Tests', () {
    test('calculateStrokeDepth returns correct values', () {
      // Test Case 1: 1000ms (1 second)
      // T = 1.0
      // T/2 = 0.5
      // (T/2)^2 = 0.25
      // 1/2 * g * 0.25 = 0.5 * 32.174 * 0.25 = 4.02175
      // stroke = 4.02175 - 0.328 = 3.69375
      expect(
        AudioProcessor.calculateStrokeDepth(1000, UnitSystem.imperial),
        closeTo(3.69375, 0.0001),
      );

      // Test Case 2: 2000ms (2 seconds)
      // T = 2.0
      // T/2 = 1.0
      // (T/2)^2 = 1.0
      // 1/2 * g * 1.0 = 0.5 * 32.174 * 1.0 = 16.087
      // stroke = 16.087 - 0.328 = 15.759
      expect(
        AudioProcessor.calculateStrokeDepth(2000, UnitSystem.imperial),
        closeTo(15.759, 0.0001),
      );

      // Test Case 3: Small value where result might be negative without clamping
      // If result < 0, it should return 0.0
      // Let's find T for stroke = 0
      // 0 = 0.5 * 32.174 * (T/2)^2 - 0.328
      // 0.328 = 16.087 * (T/2)^2
      // (T/2)^2 = 0.328 / 16.087 = 0.0203904
      // T/2 = sqrt(0.0203904) = 0.14279
      // T = 0.28558 seconds = 285.58 ms
      // So if deltaMs is 200ms, it should be 0.
      expect(
        AudioProcessor.calculateStrokeDepth(200, UnitSystem.imperial),
        0.0,
      );
    });
  });
}
