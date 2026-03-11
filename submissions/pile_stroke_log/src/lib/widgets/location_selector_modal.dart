import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geocoding/geocoding.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:latlong2/latlong.dart';

class LocationSelectionResult {
  final double latitude;
  final double longitude;
  final String? resolvedAddress;

  const LocationSelectionResult({
    required this.latitude,
    required this.longitude,
    this.resolvedAddress,
  });
}

Future<LocationSelectionResult?> showLocationSelectorModal(
  BuildContext context, {
  double? initialLat,
  double? initialLon,
}) {
  return showModalBottomSheet<LocationSelectionResult>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (_) => FractionallySizedBox(
      heightFactor: 0.92,
      child: LocationSelectorModal(
        initialLat: initialLat,
        initialLon: initialLon,
      ),
    ),
  );
}

class LocationSelectorModal extends StatefulWidget {
  final double? initialLat;
  final double? initialLon;

  const LocationSelectorModal({
    super.key,
    this.initialLat,
    this.initialLon,
  });

  @override
  State<LocationSelectorModal> createState() => _LocationSelectorModalState();
}

class _LocationSelectorModalState extends State<LocationSelectorModal> {
  static const double _fallbackLat = 39.099724;
  static const double _fallbackLon = -94.578331;
  static const double _defaultZoom = 15.0;

  final MapController _mapController = MapController();
  final TextEditingController _addressController = TextEditingController();

  late double _selectedLat;
  late double _selectedLon;
  double _currentZoom = _defaultZoom;
  bool _isSatellite = true;
  bool _isSearching = false;
  bool _isResolvingCurrentLocation = false;
  String? _resolvedAddress;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    _selectedLat = widget.initialLat ?? _fallbackLat;
    _selectedLon = widget.initialLon ?? _fallbackLon;
  }

  @override
  void dispose() {
    _addressController.dispose();
    super.dispose();
  }

  Future<void> _findAddress() async {
    final query = _addressController.text.trim();
    if (query.isEmpty) {
      setState(() {
        _errorText = 'Enter an address to search.';
      });
      return;
    }

    setState(() {
      _isSearching = true;
      _errorText = null;
    });

    try {
      final matches = await locationFromAddress(query);
      if (matches.isEmpty) {
        setState(() {
          _errorText = 'No results found for that address.';
        });
        return;
      }

      final best = matches.first;
      _setSelection(
        latitude: best.latitude,
        longitude: best.longitude,
        moveMap: true,
        clearAddress: false,
      );
      await _reverseGeocode(best.latitude, best.longitude, fallback: query);
    } catch (_) {
      setState(() {
        _errorText = 'Address lookup failed. Try a different query.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isSearching = false;
        });
      }
    }
  }

  Future<void> _jumpToCurrentLocation() async {
    if (_isResolvingCurrentLocation) return;

    setState(() {
      _isResolvingCurrentLocation = true;
      _errorText = null;
    });

    try {
      final enabled = await Geolocator.isLocationServiceEnabled();
      if (!enabled) {
        setState(() {
          _errorText =
              'Location services are disabled. Turn on GPS to use this action.';
        });
        return;
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }

      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        setState(() {
          _errorText =
              'Location permission denied. Search or drag the map to select a point.';
        });
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
        ),
      ).timeout(const Duration(seconds: 12));

      _setSelection(
        latitude: position.latitude,
        longitude: position.longitude,
        moveMap: true,
      );
      await _reverseGeocode(position.latitude, position.longitude);
    } on TimeoutException {
      setState(() {
        _errorText =
            'Current location timed out. Try again or place the pin manually.';
      });
    } catch (_) {
      setState(() {
        _errorText =
            'Unable to read current location. Search or place the pin manually.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isResolvingCurrentLocation = false;
        });
      }
    }
  }

  Future<void> _reverseGeocode(
    double latitude,
    double longitude, {
    String? fallback,
  }) async {
    try {
      final placemarks = await placemarkFromCoordinates(latitude, longitude);
      if (placemarks.isEmpty) {
        if (fallback != null && fallback.isNotEmpty) {
          setState(() {
            _resolvedAddress = fallback;
          });
        }
        return;
      }

      final place = placemarks.first;
      final parts = <String>[
        if (place.name != null && place.name!.trim().isNotEmpty) place.name!,
        if (place.locality != null && place.locality!.trim().isNotEmpty)
          place.locality!,
        if (place.administrativeArea != null &&
            place.administrativeArea!.trim().isNotEmpty)
          place.administrativeArea!,
      ];
      final formatted = parts.join(', ');

      setState(() {
        _resolvedAddress = formatted.isNotEmpty ? formatted : fallback;
      });
    } catch (_) {
      if (fallback != null && fallback.isNotEmpty) {
        setState(() {
          _resolvedAddress = fallback;
        });
      }
    }
  }

  void _setSelection({
    required double latitude,
    required double longitude,
    bool moveMap = false,
    bool clearAddress = true,
  }) {
    setState(() {
      _selectedLat = latitude;
      _selectedLon = longitude;
      _errorText = null;
      if (clearAddress) {
        _resolvedAddress = null;
      }
    });

    if (moveMap) {
      _mapController.move(LatLng(latitude, longitude), _currentZoom);
    }
  }

  void _confirmSelection() {
    Navigator.of(context).pop(
      LocationSelectionResult(
        latitude: _selectedLat,
        longitude: _selectedLon,
        resolvedAddress: _resolvedAddress?.trim().isEmpty ?? true
            ? null
            : _resolvedAddress?.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final center = LatLng(_selectedLat, _selectedLon);

    return Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        8,
        16,
        16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 44,
              height: 5,
              decoration: BoxDecoration(
                color: Colors.grey[400],
                borderRadius: BorderRadius.circular(99),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Select Stop Location',
            style: GoogleFonts.inter(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: const Color(0xFF424242),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Search an address, drag the map, tap to place, or jump to your current location.',
            style: GoogleFonts.inter(
              color: Colors.grey[700],
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _addressController,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => _findAddress(),
                  decoration: InputDecoration(
                    labelText: 'Search Address',
                    hintText: 'Type an address',
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 12,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              SizedBox(
                height: 52,
                child: ElevatedButton.icon(
                  onPressed: _isSearching ? null : _findAddress,
                  icon: _isSearching
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.search),
                  label: Text(
                    'Find',
                    style: GoogleFonts.inter(fontWeight: FontWeight.w600),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.blue[700],
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: Stack(
                children: [
                  FlutterMap(
                    mapController: _mapController,
                    options: MapOptions(
                      initialCenter: center,
                      initialZoom: _defaultZoom,
                      minZoom: 3,
                      maxZoom: 20,
                      onTap: (_, point) {
                        _setSelection(
                          latitude: point.latitude,
                          longitude: point.longitude,
                          moveMap: true,
                        );
                      },
                      onPositionChanged: (camera, hasGesture) {
                        _currentZoom = camera.zoom;
                        if (hasGesture) {
                          _setSelection(
                            latitude: camera.center.latitude,
                            longitude: camera.center.longitude,
                          );
                        }
                      },
                    ),
                    children: [
                      TileLayer(
                        urlTemplate: _isSatellite
                            ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                            : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                        userAgentPackageName: 'com.pile_stroke_log.app',
                      ),
                      RichAttributionWidget(
                        attributions: [
                          if (_isSatellite)
                            const TextSourceAttribution('Esri World Imagery'),
                          if (!_isSatellite)
                            const TextSourceAttribution(
                              'OpenStreetMap contributors',
                            ),
                        ],
                      ),
                    ],
                  ),
                  const Center(
                    child: IgnorePointer(
                      child: Icon(
                        Icons.location_pin,
                        size: 48,
                        color: Colors.red,
                      ),
                    ),
                  ),
                  Positioned(
                    top: 12,
                    left: 12,
                    child: ElevatedButton(
                      onPressed: () {
                        setState(() {
                          _isSatellite = !_isSatellite;
                        });
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.black.withValues(alpha: 0.78),
                        foregroundColor: Colors.white,
                      ),
                      child: Text(
                        _isSatellite ? 'Street' : 'Satellite',
                        style: GoogleFonts.inter(fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
                  Positioned(
                    right: 12,
                    bottom: 12,
                    child: FloatingActionButton.small(
                      heroTag: 'selector-current-location',
                      onPressed: _jumpToCurrentLocation,
                      backgroundColor: Colors.white,
                      foregroundColor: Colors.blue[700],
                      child: _isResolvingCurrentLocation
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.my_location),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Coordinates: ${_selectedLat.toStringAsFixed(6)}, ${_selectedLon.toStringAsFixed(6)}',
            style: GoogleFonts.inter(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: const Color(0xFF2D2D2D),
            ),
          ),
          if (_resolvedAddress != null && _resolvedAddress!.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              _resolvedAddress!,
              style: GoogleFonts.inter(
                color: Colors.grey[700],
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
          if (_errorText != null) ...[
            const SizedBox(height: 4),
            Text(
              _errorText!,
              style: GoogleFonts.inter(
                color: Colors.red[700],
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
          const SizedBox(height: 12),
          SizedBox(
            height: 52,
            child: ElevatedButton(
              onPressed: _confirmSelection,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.blue[700],
                foregroundColor: Colors.white,
              ),
              child: Text(
                'Use This Location',
                style: GoogleFonts.inter(
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(
              'Cancel',
              style: GoogleFonts.inter(
                color: Colors.grey[700],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
