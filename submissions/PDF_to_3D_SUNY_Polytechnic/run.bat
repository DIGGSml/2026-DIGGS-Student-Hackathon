@echo off
echo ========================================
echo  DIGGS 2.6 Converter - Setup and Launch
echo ========================================
echo.

REM Create required directories if they don't exist
if not exist "output\xml" mkdir "output\xml"
if not exist "output\excel" mkdir "output\excel"
if not exist "output\plots" mkdir "output\plots"
if not exist "output\logs" mkdir "output\logs"
if not exist "intermediate\" mkdir intermediate
if not exist "Files\uploads\" mkdir Files\uploads
if not exist "data\" mkdir data
if not exist "docs\" mkdir docs

REM Check if virtual environment exists
if not exist "venv\" (
    echo Creating virtual environment...
    python -m venv venv
    echo Virtual environment created.
    echo.
) else (
    echo Virtual environment already exists.
    echo.
)

REM Activate virtual environment
echo Activating virtual environment...
call venv\Scripts\activate.bat

REM Install dependencies (quiet, only if needed)
echo Installing dependencies...
pip install -r requirements.txt --quiet
echo Dependencies installed or ready.
echo.

REM Give Flask a moment to start before opening browser
echo Launching DIGGS Converter...
echo App will be available at http://127.0.0.1:5000
echo.
start /b cmd /c "timeout /t 2 >nul && start http://127.0.0.1:5000"

python app.py

pause
