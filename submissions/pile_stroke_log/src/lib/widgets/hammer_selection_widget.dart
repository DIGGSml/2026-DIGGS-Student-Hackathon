import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import '../core/hammer_logic.dart';
import '../core/settings_logic.dart';

class HammerSelectionWidget extends ConsumerWidget {
  const HammerSelectionWidget({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hammerState = ref.watch(hammerSelectionProvider);
    final notifier = ref.read(hammerSelectionProvider.notifier);

    if (hammerState.isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildSectionHeader("Hammer Details"),
        
        // 1. Manufacturer Dropdown
        _buildDropdown(
          label: "Hammer Manufacturer",
          value: hammerState.selectedMake,
          items: hammerState.availableMakes,
          onChanged: notifier.selectMake,
          hint: "Select Manufacturer",
        ),
        
        // 2. Model Dropdown
        _buildDropdown(
          label: "Hammer Model",
          value: hammerState.selectedModel,
          items: hammerState.availableModels,
          onChanged: notifier.selectModel,
          hint: "Select Model",
          isDisabled: hammerState.selectedMake == null,
        ),

        const SizedBox(height: 8),

        // Auto-populated fields row
        Builder(builder: (context) {
          final unitSystem = ref.watch(settingsProvider).unitSystem;
          final isMetric = unitSystem == UnitSystem.metric;
          final hammer = hammerState.selectedHammer;

          String weightVal = "-";
          String strokeVal = "-";
          String powerVal = "-";

          final String weightLabel = isMetric ? "Weight (kN)" : "Weight (kips)";
          final String strokeLabel = isMetric ? "Stroke (m)" : "Stroke (ft)";
          final String powerLabel = isMetric ? "Power (kNm)" : "Power (kip-ft)";

          if (hammer != null) {
            final double weight = isMetric ? hammer.weight * 4.4482216153 : hammer.weight;
            final double stroke = isMetric ? hammer.stroke * 0.3048 : hammer.stroke;
            final double power = isMetric ? hammer.power * 1.355818 : hammer.power;

            weightVal = weight.toStringAsFixed(3);
            strokeVal = stroke.toStringAsFixed(3);
            powerVal = power.toStringAsFixed(3);
          }

          return Row(
            children: [
              Expanded(
                child: _buildReadOnlyField(
                  label: weightLabel,
                  value: weightVal,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _buildReadOnlyField(
                  label: strokeLabel,
                  value: strokeVal,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _buildReadOnlyField(
                  label: powerLabel,
                  value: powerVal,
                ),
              ),
            ],
          );
        }),
        const SizedBox(height: 16),
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

  Widget _buildDropdown({
    required String label,
    required String? value,
    required List<String> items,
    required ValueChanged<String?> onChanged,
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
          child: DropdownButtonFormField<String>(
            decoration: InputDecoration(
              labelText: label,
              border: InputBorder.none,
              contentPadding: EdgeInsets.zero,
            ),
            isExpanded: true,
            hint: Text(hint),
            initialValue: value,
            items: items.map((String item) {
              return DropdownMenuItem<String>(
                value: item,
                child: Text(item),
              );
            }).toList(),
            onChanged: isDisabled ? null : onChanged,
            // Ensure we handle invalid values casually if list updates
            // (though state logic should handle this)
          ),
        ),
      ),
    );
  }

  Widget _buildReadOnlyField({required String label, required String value}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Text(
          label,
          textAlign: TextAlign.center,
          style: GoogleFonts.inter(fontSize: 10, color: Colors.grey[600]),
        ),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
          decoration: BoxDecoration(
            color: Colors.grey[100],
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: Colors.grey[300]!),
          ),
          child: Text(
            value,
            textAlign: TextAlign.center,
            style: GoogleFonts.inter(
              fontSize: 14, 
              fontWeight: FontWeight.w500,
              color: Colors.black87
            ),
          ),
        ),
      ],
    );
  }
}
