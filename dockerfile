FROM mcr.microsoft.com/vscode/devcontainers/python:3.9

# Copy the requirements file into the container at /tmp/
COPY requirements.txt /tmp/

# Install any dependencies
RUN pip install --requirement /tmp/requirements.txt

# Continue with any other commands you might need
