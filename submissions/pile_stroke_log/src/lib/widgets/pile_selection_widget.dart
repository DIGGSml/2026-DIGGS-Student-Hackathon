import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import '../core/pile_logic.dart';
import '../core/pile_model.dart';
import '../core/settings_logic.dart';

class PileSelectionWidget extends ConsumerWidget {
  const PileSelectionWidget({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pileState = ref.watch(pileSelectionProvider);
    final notifier = ref.read(pileSelectionProvider.notifier);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildSectionHeader("Pile Details"),

        // 1. Pile Material Dropdown
        _buildDropdown<PileMaterial>(
          label: "Pile Material",
          value: pileState.selectedMaterial,
          items: pileState.availableMaterials,
          itemLabel: (m) => m.displayName,
          onChanged: notifier.selectMaterial,
          hint: "Select Material",
        ),

        // 2. Pile Type Dropdown (filtered by material)
        _buildDropdown<PileType>(
          label: "Pile Type",
          value: pileState.selectedPileType,
          items: pileState.availablePileTypes,
          itemLabel: (t) => t.displayName,
          onChanged: (type) {
            if (type != null) notifier.selectPileType(type);
          },
          hint: "Select Pile Type",
          isDisabled: pileState.selectedMaterial == null,
        ),
        if (pileState.selectedMaterial != null &&
            pileState.availablePileTypes.isEmpty)
          _buildStatusHint(
            "No pile types are available for this material/unit combination.",
            isError: true,
          ),

        // 3. Section Size Dropdown
        _buildStringDropdown(
          label: "Section Size",
          value: pileState.selectedSectionSize,
          items: pileState.availableSectionSizes,
          onChanged: notifier.selectSectionSize,
          hint: "Select Section Size",
          isDisabled: pileState.selectedPileType == null,
          isLoading: pileState.isLoading,
        ),
        if (pileState.selectedPileType != null && !pileState.isLoading)
          _buildSectionCountHint(pileState.availableSectionSizes.length),
        if (pileState.selectedPileType != null &&
            !pileState.isLoading &&
            pileState.availableSectionSizes.isEmpty)
          _buildStatusHint(
            pileState.sectionStatusMessage ??
                "No sections matched the current filters.",
            isError: true,
          ),

        const SizedBox(height: 8),

        // Auto-populated Cross-Section Area field
        if (pileState.selectedSection != null) ...[
          Builder(builder: (context) {
            final unitSystem = ref.watch(settingsProvider).unitSystem;
            final isMetric = unitSystem == UnitSystem.metric;
            final double area = pileState.selectedSection!.crossSectionArea;

            // Value is used directly from CSV (Imperial CSV has sq. in, Metric CSV has sq. cm)
            final String unitLabel = isMetric ? "sq. cm" : "sq. in.";

            return _buildReadOnlyField(
              label: "Cross-Section Area ($unitLabel)",
              value: area.toStringAsFixed(2),
            );
          }),
          const SizedBox(height: 16),
        ],
      ],
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8.0),
      child: Text(
        title,
        style: GoogleFonts.inter(fontSize: 14, color: Colors.grey[600]),
      ),
    );
  }

  Widget _buildDropdown<T>({
    required String label,
    required T? value,
    required List<T> items,
    required String Function(T) itemLabel,
    required ValueChanged<T?> onChanged,
    required String hint,
    bool isDisabled = false,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16.0),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(8),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        child: DropdownButtonHideUnderline(
          child: DropdownButtonFormField<T>(
            decoration: InputDecoration(
              labelText: label,
              border: InputBorder.none,
              contentPadding: EdgeInsets.zero,
            ),
            isExpanded: true,
            hint: Text(hint),
            initialValue: items.contains(value) ? value : null,
            items: items.map((T item) {
              return DropdownMenuItem<T>(
                value: item,
                child: Text(itemLabel(item)),
              );
            }).toList(),
            onChanged: isDisabled ? null : onChanged,
          ),
        ),
      ),
    );
  }

  Widget _buildStringDropdown({
    required String label,
    required String? value,
    required List<String> items,
    required ValueChanged<String?> onChanged,
    required String hint,
    bool isDisabled = false,
    bool isLoading = false,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16.0),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(8),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        child: isLoading
            ? Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Row(
                  children: [
                    const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      "Loading sections...",
                      style: GoogleFonts.inter(color: Colors.grey[600]),
                    ),
                  ],
                ),
              )
            : DropdownButtonHideUnderline(
                child: DropdownButtonFormField<String>(
                  decoration: InputDecoration(
                    labelText: label,
                    border: InputBorder.none,
                    contentPadding: EdgeInsets.zero,
                  ),
                  isExpanded: true,
                  hint: Text(hint),
                  initialValue: items.contains(value) ? value : null,
                  items: items.map((String item) {
                    return DropdownMenuItem<String>(
                      value: item,
                      child: Text(item),
                    );
                  }).toList(),
                  onChanged: isDisabled ? null : onChanged,
                ),
              ),
      ),
    );
  }

  Widget _buildReadOnlyField({required String label, required String value}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: GoogleFonts.inter(fontSize: 12, color: Colors.grey[600]),
        ),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 12),
          decoration: BoxDecoration(
            color: Colors.grey[100],
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: Colors.grey[300]!),
          ),
          child: Text(
            value,
            style: GoogleFonts.inter(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: Colors.black87,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildSectionCountHint(int count) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: const Color(0xFFE8F0FE),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            "Section options loaded: $count",
            style: GoogleFonts.inter(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: Colors.blue[800],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildStatusHint(String message, {bool isError = false}) {
    final bgColor = isError ? const Color(0xFFFFEBEE) : const Color(0xFFE8F5E9);
    final textColor = isError ? Colors.red[700] : Colors.green[700];

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: bgColor,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: isError ? const Color(0xFFFFCDD2) : const Color(0xFFC8E6C9),
          ),
        ),
        child: Text(
          message,
          style: GoogleFonts.inter(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: textColor,
          ),
        ),
      ),
    );
  }
}
