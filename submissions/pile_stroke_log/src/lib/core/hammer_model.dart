class Hammer {
  final String make;
  final String model;
  final double weight;
  final double stroke;
  final double power;

  Hammer({
    required this.make,
    required this.model,
    required this.weight,
    required this.stroke,
    required this.power,
  });

  factory Hammer.fromCsvList(List<dynamic> row) {
    // Assuming CSV order: Manufacturer,Model,Weight,Stroke,Power
    return Hammer(
      make: row[0].toString().trim(),
      model: row[1].toString().trim(),
      weight: _parseDouble(row[2]),
      stroke: _parseDouble(row[3]),
      power: _parseDouble(row[4]),
    );
  }

  static double _parseDouble(dynamic value) {
    if (value == null) return 0.0;
    if (value is num) return value.toDouble();
    return double.tryParse(value.toString()) ?? 0.0;
  }
}
