document.addEventListener('DOMContentLoaded', () => {
    // Globals
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    // Drag & Drop
    if (dropZone) {
        dropZone.addEventListener('click', () => fileInput && fileInput.click());

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
        });

        dropZone.addEventListener('drop', handleDrop, false);
    }

    if (fileInput) {
        fileInput.addEventListener('change', handleFiles, false);
    }

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles({ target: { files: files } });
    }

    function handleFiles(e) {
        const file = e.target.files[0];
        if (file && file.type === 'application/pdf') {
            uploadFile(file);
        } else {
            alert('Please upload a valid PDF file.');
        }
    }

    function uploadFile(file) {
        const dropContent = document.getElementById('drop-content');
        const loadingState = document.getElementById('loading-state');

        if (dropContent) dropContent.classList.add('hidden');
        if (loadingState) loadingState.classList.remove('hidden');

        const formData = new FormData();
        formData.append('file', file);

        fetch('/convert', {
            method: 'POST',
            body: formData
        })
            .then(response => response.json().then(data => ({ status: response.status, data })))
            .then(({ status, data }) => {
                if (status === 422 && data.type === 'not_a_borehole_log') {
                    showRejection(data.error);
                } else if (data.error) {
                    alert("Error: " + data.error);
                    resetDropZone();
                } else {
                    showResults(data);
                }
            })
            .catch(error => {
                console.error('Error:', error);
                alert('An unexpected error occurred: ' + error.message);
                resetDropZone();
            });
    }

    function showResults(data) {
        // Force hide loader immediately
        const dropZone = document.getElementById('drop-zone');
        const loadingState = document.getElementById('loading-state');
        if (loadingState) loadingState.classList.add('hidden');
        if (dropZone) dropZone.style.display = 'none';

        const resultsPanel = document.getElementById('results-panel');
        if (!resultsPanel) {
            alert("Critical Error: Results Panel not found in DOM!");
            return;
        }

        const xmlContent = document.getElementById('xml-content');
        const validationLogs = document.getElementById('validation-logs');
        const downloadBtn = document.getElementById('download-btn');
        const statusBadge = document.getElementById('status-badge');

        resultsPanel.classList.remove('hidden');
        setTimeout(() => resultsPanel.classList.add('visible'), 50);

        if (xmlContent) xmlContent.textContent = data.xml_content;

        if (statusBadge) {
            if (data.validation_status === 'VALID') {
                statusBadge.textContent = "PASSED";
                statusBadge.className = "badge valid";
            } else {
                statusBadge.textContent = "FAILED";
                statusBadge.className = "badge invalid";
            }
        }

        if (validationLogs) {
            if (data.validation_details && data.validation_details.trim() !== "") {
                validationLogs.textContent = data.validation_details;
            } else {
                validationLogs.textContent = data.validation_status === 'VALID'
                    ? "PASSED: Content matches DIGGS 2.6 Schema."
                    : "FAILED: Critical schema errors detected.";
            }
            validationLogs.style.color = data.validation_status === 'VALID' ? '#34d399' : '#f87171';
        }

        if (downloadBtn) {
            downloadBtn.href = data.download_url;
            // Use actual filename from server, not a hardcoded generic name
            downloadBtn.download = data.download_url.split('/').pop();
        }

        // Wire Excel download button
        const excelBtn = document.getElementById('excel-download-btn');
        if (excelBtn) {
            if (data.excel_download_url) {
                excelBtn.href = data.excel_download_url;
                excelBtn.download = data.excel_download_url.split('/').pop();
                excelBtn.classList.remove('hidden');
            } else {
                excelBtn.classList.add('hidden');
            }
        }

        // Gate 2: surface any soft warnings (e.g. missing borehole ID)
        showWarnings(data.warnings || []);
    }

    function showRejection(message) {
        // Hide upload zone, show the red rejection panel
        const dropZoneEl = document.getElementById('drop-zone');
        const loadingState = document.getElementById('loading-state');
        const rejectionPanel = document.getElementById('rejection-panel');
        const rejectionMessage = document.getElementById('rejection-message');

        if (loadingState) loadingState.classList.add('hidden');
        if (dropZoneEl) dropZoneEl.style.display = 'none';
        if (rejectionMessage) rejectionMessage.textContent = message;
        if (rejectionPanel) {
            rejectionPanel.classList.remove('hidden');
            setTimeout(() => rejectionPanel.classList.add('visible'), 50);
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function showWarnings(warnings) {
        const banner = document.getElementById('warning-banner');
        const warningText = document.getElementById('warning-text');
        if (!banner || !warningText) return;
        if (warnings && warnings.length > 0) {
            warningText.textContent = warnings.join(' | ');
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    }

    // Expose reset as a global so the HTML button can call it
    window.resetToUpload = function () {
        const dropContent = document.getElementById('drop-content');
        const loadingState = document.getElementById('loading-state');
        const resultsPanel = document.getElementById('results-panel');
        const rejectionPanel = document.getElementById('rejection-panel');

        if (loadingState) loadingState.classList.add('hidden');
        if (dropContent) dropContent.classList.remove('hidden');
        if (fileInput) fileInput.value = '';
        if (dropZone) dropZone.style.display = '';

        if (resultsPanel) {
            resultsPanel.classList.remove('visible');
            resultsPanel.classList.add('hidden');
        }
        if (rejectionPanel) {
            rejectionPanel.classList.remove('visible');
            rejectionPanel.classList.add('hidden');
        }

        // Smooth scroll back to top of section
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    function resetDropZone() {
        window.resetToUpload();
    }
});
