/// Represents different pile materials
enum PileMaterial {
  steel('Steel'),
  concrete('Concrete');

  final String displayName;
  const PileMaterial(this.displayName);
}

/// Represents different pile types
enum PileType {
  hPile('H-Pile', PileMaterial.steel),
  pipePile('Pipe Pile', PileMaterial.steel),
  squarePile('Square Pile', PileMaterial.concrete),
  octagonalPile('Octagonal Pile', PileMaterial.concrete),
  circularPile('Circular Pile', PileMaterial.concrete);

  final String displayName;
  final PileMaterial material;
  const PileType(this.displayName, this.material);

  /// Get pile types available for a specific material
  static List<PileType> forMaterial(PileMaterial material) {
    return PileType.values.where((type) => type.material == material).toList();
  }
}

/// Represents a pile section with its dimensions and cross-section area
class PileSection {
  final String sectionSize; // e.g., "HP14x117" or "12" (inches)
  final double crossSectionArea; // in square units (sq. in. for Imperial, sq. cm. for Metric)
  final PileType pileType;

  PileSection({
    required this.sectionSize,
    required this.crossSectionArea,
    required this.pileType,
  });

  /// Factory to create from CSV row
  /// Expected format: SectionSize, CrossSectionArea
  factory PileSection.fromCsvList(List<dynamic> row, PileType type) {
    return PileSection(
      sectionSize: row[0].toString().trim(),
      crossSectionArea: _parseDouble(row[1]),
      pileType: type,
    );
  }

  static double _parseDouble(dynamic value) {
    if (value == null) return 0.0;
    if (value is num) return value.toDouble();
    return double.tryParse(value.toString().trim()) ?? 0.0;
  }

  @override
  String toString() => 'PileSection($sectionSize, $crossSectionArea units)';
}
