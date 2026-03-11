
import 'dart:math';

void main() {
  const int taps = 64;
  const int fs = 44100;
  const double fLow = 300.0;
  const double fHigh = 2500.0;
  final List<double> coeffs = [];

  const double mid = (taps - 1) / 2.0;

  for (int n = 0; n < taps; n++) {
    double val;
    if (n == mid) {
      val = 2.0 * (fHigh - fLow) / fs;
    } else {
      final double term1 = sin(2 * pi * fHigh * (n - mid) / fs) / (pi * (n - mid));
      final double term2 = sin(2 * pi * fLow * (n - mid) / fs) / (pi * (n - mid));
      val = term1 - term2;
    }
    
    // Hann Window
    final double window = 0.5 * (1 - cos(2 * pi * n / (taps - 1)));
    coeffs.add(val * window);
  }

  print(coeffs.join(', '));
}
