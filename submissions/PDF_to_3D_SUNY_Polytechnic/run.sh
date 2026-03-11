#!/bin/bash
echo "========================================"
echo " DIGGS 2.6 Converter - Setup and Launch"
echo "========================================"
echo

# Create required directories if they don't exist
mkdir -p output/xml output/excel output/plots output/logs intermediate Files/uploads data docs

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    echo "Virtual environment created."
    echo
else
    echo "Virtual environment already exists."
    echo
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt --quiet
echo "Dependencies installed or ready."
echo

# Open browser after a short delay so Flask has time to start
echo "Launching DIGGS Converter..."
echo "App will be available at http://127.0.0.1:5000"
echo

(sleep 2 && \
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        xdg-open http://127.0.0.1:5000
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        open http://127.0.0.1:5000
    fi
) &

python3 app.py
