"""
Geocoding API - address to lat/lon (Nominatim).
"""
import requests
from flask import Blueprint, request, jsonify

geocode_bp = Blueprint('geocode', __name__, url_prefix='/api')


@geocode_bp.route('/geocode', methods=['POST'])
def geocode_address():
    """Convert address to lat/lon using Nominatim API."""
    try:
        data = request.json
        address = data.get('address', '').strip()

        if not address:
            return jsonify({"status": "error", "message": "Please enter an address"}), 400

        url = "https://nominatim.openstreetmap.org/search"
        params = {
            "q": address,
            "format": "json",
            "limit": 1,
            "addressdetails": 1
        }
        headers = {
            "User-Agent": "Liquefaction Analysis Tool"
        }

        response = requests.get(url, params=params, headers=headers, timeout=10)

        if response.status_code == 200:
            results = response.json()

            if not results or len(results) == 0:
                return jsonify({
                    "status": "error",
                    "message": "Address not found. Please try a more detailed address or use latitude/longitude input."
                }), 404

            result = results[0]
            lat = float(result.get('lat', 0))
            lon = float(result.get('lon', 0))
            display_name = result.get('display_name', address)

            return jsonify({
                "status": "success",
                "data": {
                    "latitude": lat,
                    "longitude": lon,
                    "display_name": display_name,
                    "address": address
                }
            })
        else:
            return jsonify({
                "status": "error",
                "message": f"Geocoding service error: {response.status_code}"
            }), response.status_code

    except Exception as e:
        return jsonify({
            "status": "error",
            "message": f"Geocoding failed: {str(e)}"
        }), 500
