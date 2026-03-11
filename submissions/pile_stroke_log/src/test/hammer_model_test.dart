import 'package:flutter_test/flutter_test.dart';
import 'package:pile_stroke_log/core/hammer_model.dart';

void main() {
  group('Hammer Model Tests', () {
    test('Hammer.fromCsvList parses correctly', () {
      final row = ['APE', 'D 1-42', 0.208, 6.333, 1.317];
      final hammer = Hammer.fromCsvList(row);

      expect(hammer.make, 'APE');
      expect(hammer.model, 'D 1-42');
      expect(hammer.weight, 0.208);
      expect(hammer.stroke, 6.333);
      expect(hammer.power, 1.317);
    });

    test('Hammer.fromCsvList handles stringly typed numbers', () {
      final row = ['APE', 'D 1-42', '0.208', '6.333', '1.317'];
      final hammer = Hammer.fromCsvList(row);

      expect(hammer.weight, 0.208);
      expect(hammer.stroke, 6.333);
    });

    test('Hammer.fromCsvList handles nulls gracefully', () {
      final row = ['APE', 'D 1-42', null, null, null];
      final hammer = Hammer.fromCsvList(row);

      expect(hammer.weight, 0.0);
      expect(hammer.stroke, 0.0);
    });
  });
}
