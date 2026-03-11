import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import '../core/hammer_logic.dart';
import '../core/pile_session_logic.dart';

class BearingCapacityScreen extends ConsumerStatefulWidget {
  const BearingCapacityScreen({super.key});

  @override
  ConsumerState<BearingCapacityScreen> createState() => _BearingCapacityScreenState();
}

class _BearingCapacityScreenState extends ConsumerState<BearingCapacityScreen> {
  final _strokeController = TextEditingController();
  final _blowsController = TextEditingController();
  final _resistanceController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _strokeController.addListener(_calculateResistance);
    _blowsController.addListener(_calculateResistance);
  }

  @override
  void dispose() {
    _strokeController.dispose();
    _blowsController.dispose();
    _resistanceController.dispose();
    super.dispose();
  }

  void _calculateResistance() {
    final hammerState = ref.read(hammerSelectionProvider);
    final hammer = hammerState.selectedHammer;

    if (hammer == null) {
      _resistanceController.text = "Select a hammer first";
      return;
    }

    final double h = double.tryParse(_strokeController.text) ?? 0.0;
    final double n = double.tryParse(_blowsController.text) ?? 0.0;
    final double weightInLbs = hammer.weight * 1000; // Database weight is in kips

    if (h > 0 && n > 0) {
      // Rn = 1.75 * sqrt(E) * log10(10N) - 100
      // E = Weight (lbs) * H (ft)
      final double energy = weightInLbs * h;
      if (energy > 0) {
        final double rn = 1.75 * math.sqrt(energy) * (math.log(10 * n) / math.ln10) - 100;
        _resistanceController.text = rn.toStringAsFixed(2);
        
        // Mark as calculated in session state
        ref.read(pileSessionProvider.notifier).setBearingCapacityCalculated(true);
      } else {
        _resistanceController.text = "0.00";
      }
    } else {
      _resistanceController.text = "0.00";
    }
  }

  @override
  Widget build(BuildContext context) {
    final hammerState = ref.watch(hammerSelectionProvider);
    final selectedHammer = hammerState.selectedHammer;

    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      appBar: AppBar(
        backgroundColor: const Color(0xFF424242),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
        centerTitle: true,
        title: Text(
          'Bearing Capacity',
          style: GoogleFonts.inter(
            fontWeight: FontWeight.bold,
            color: Colors.white,
          ),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (selectedHammer != null)
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.blue[50],
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.blue[100]!),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      "Current Hammer: ${selectedHammer.make} ${selectedHammer.model}",
                      softWrap: true,
                      style: GoogleFonts.inter(
                        fontWeight: FontWeight.bold,
                        color: Colors.blue[900],
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      "Ram Weight: ${selectedHammer.weight} kips (${(selectedHammer.weight * 1000).toStringAsFixed(0)} lbs)",
                      softWrap: true,
                      style: GoogleFonts.inter(color: Colors.blue[800]),
                    ),
                  ],
                ),
              )
            else
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.orange[50],
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.orange[100]!),
                ),
                child: Text(
                  "Warning: No hammer selected on Setup screen.",
                  style: GoogleFonts.inter(
                    fontWeight: FontWeight.bold,
                    color: Colors.orange[900],
                  ),
                ),
              ),
            const SizedBox(height: 24),
            _buildInputField(
              controller: _strokeController,
              label: "Calculated Stroke, H (ft)",
              hint: "Enter stroke height",
              enabled: selectedHammer != null,
            ),
            _buildInputField(
              controller: _blowsController,
              label: "Blows Per Inch, N",
              hint: "Enter blows/inch",
              enabled: selectedHammer != null,
            ),
            const Divider(height: 48),
            _buildInputField(
              controller: _resistanceController,
              label: "Estimated Nominal Pile Resistance, Rn (kips)",
              hint: "Calculated Resistance",
              readOnly: true,
              style: GoogleFonts.inter(
                fontWeight: FontWeight.bold,
                color: Colors.green[700],
              ),
            ),
            const SizedBox(height: 16),
            Text(
              "Formula: Rn = 1.75√E log(10N) - 100",
              textAlign: TextAlign.center,
              style: GoogleFonts.inter(
                fontSize: 12,
                color: Colors.grey[600],
                fontStyle: FontStyle.italic,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInputField({
    required TextEditingController controller,
    required String label,
    required String hint,
    bool readOnly = false,
    bool enabled = true,
    TextStyle? style,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 20.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            softWrap: true,
            style: GoogleFonts.inter(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: Colors.grey[700],
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: controller,
            readOnly: readOnly,
            enabled: enabled,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            style: style,
            decoration: InputDecoration(
              hintText: hint,
              filled: true,
              fillColor: enabled ? Colors.white : Colors.grey[100],
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: Colors.grey[300]!),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: Colors.grey[300]!),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: const BorderSide(color: Color(0xFF424242), width: 2),
              ),
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            ),
          ),
        ],
      ),
    );
  }
}
