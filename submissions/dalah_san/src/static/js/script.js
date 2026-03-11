// ==========================================
// 1. ，
// ==========================================
// ：
let map = null;
let marker = null;

// Geosetta (borehole points) layer state
let geosettaTabMap = null;
let geosettaTabMarkers = null;
let geosettaTabCenterMarker = null;
let geosettaTabItems = [];
let geosettaTabFetchTimer = null;
let geosettaTabLastFetchKey = '';
let geosettaTabFetchInFlight = false;
let geosettaDbStatusCache = { checkedTs: 0, exists: false, boreholes: 0, db_path: '' };

async function ensureGeosettaDbStatus(force = false) {
    const now = Date.now();
    if (!force && geosettaDbStatusCache.checkedTs && (now - geosettaDbStatusCache.checkedTs) < 10_000) {
        return geosettaDbStatusCache;
    }
    try {
        const resp = await fetch('/api/geosetta/db/status', { method: 'GET' });
        const data = await resp.json();
        if (resp.ok && data && data.status === 'success' && data.data) {
            geosettaDbStatusCache = {
                checkedTs: now,
                exists: !!data.data.exists,
                boreholes: Number(data.data.boreholes || 0),
                db_path: String(data.data.db_path || '')
            };
        } else {
            geosettaDbStatusCache = { checkedTs: now, exists: false, boreholes: 0, db_path: '' };
        }
    } catch (_) {
        geosettaDbStatusCache = { checkedTs: now, exists: false, boreholes: 0, db_path: '' };
    }
    return geosettaDbStatusCache;
}

function _geosettaMergeOverlappingClusters(clusters, zoom, map) {
    if (!Array.isArray(clusters) || clusters.length === 0) return clusters;
    const z = Number(zoom);
    if (!isFinite(z)) return clusters;
    // Merge threshold (deg): ensure bubbles (~34px) don't overlap on screen.
    // At low zoom, use larger mergeDeg so adjacent clusters are merged.
    let mergeDeg;
    if (map && map.getContainer && map.getBounds) {
        try {
            const container = map.getContainer();
            const bounds = map.getBounds();
            const w = container ? container.offsetWidth : 400;
            const h = container ? container.offsetHeight : 420;
            const degLon = Math.max(1, bounds.getEast() - bounds.getWest());
            const degLat = Math.max(0.5, bounds.getNorth() - bounds.getSouth());
            const pxPerDegLon = w / degLon;
            const pxPerDegLat = h / degLat;
            // Need ~40px min spacing between bubble centers to avoid overlap (bubble ~34px)
            const minPx = 42;
            mergeDeg = Math.max(0.15, Math.min(20, Math.max(minPx / pxPerDegLon, minPx / pxPerDegLat)));
        } catch (_) {
            mergeDeg = _geosettaMergeDegFromZoom(z);
        }
    } else {
        mergeDeg = _geosettaMergeDegFromZoom(z);
    }
    // Only merge when zoomed out (low zoom); at high zoom, skip merge
    if (z > 10 && mergeDeg < 0.02) return clusters;
    const buckets = new Map();
    clusters.forEach(c => {
        const lat = Number(c?.lat);
        const lon = Number(c?.lon);
        const count = Number(c?.count || 0);
        if (!isFinite(lat) || !isFinite(lon) || count <= 0) return;
        const key = `${Math.floor(lat / mergeDeg)}:${Math.floor(lon / mergeDeg)}`;
        const b = buckets.get(key) || { latSum: 0, lonSum: 0, count: 0 };
        b.latSum += lat * count;
        b.lonSum += lon * count;
        b.count += count;
        buckets.set(key, b);
    });
    return Array.from(buckets.values()).map(b => ({
        lat: b.latSum / b.count,
        lon: b.lonSum / b.count,
        count: b.count
    }));
}

function _geosettaMergeDegFromZoom(z) {
    if (z <= 1) return 12;
    if (z <= 2) return 8;
    if (z <= 3) return 5;
    if (z <= 4) return 3;
    if (z <= 5) return 1.8;
    if (z <= 6) return 1.0;
    if (z <= 7) return 0.5;
    if (z <= 8) return 0.3;
    if (z <= 9) return 0.15;
    return 0.08;
}

function renderGeosettaDbClusters(clusters) {
    initGeosettaTabMap(true);
    if (!geosettaTabMap || !geosettaTabMarkers) return;
    try { geosettaTabMarkers.clearLayers(); } catch (_) {}

    const zoom = geosettaTabMap ? geosettaTabMap.getZoom() : 10;
    const merged = _geosettaMergeOverlappingClusters(clusters || [], zoom, geosettaTabMap);

    const bounds = [];
    merged.forEach(c => {
        const lat = Number(c?.lat);
        const lon = Number(c?.lon);
        const count = Number(c?.count || 0);
        if (!isFinite(lat) || !isFinite(lon) || !isFinite(count) || count <= 0) return;
        bounds.push([lat, lon]);

        // Color by count: large=orange, medium=amber, small=yellow
        let colorClass = 'geosetta-cluster-small';
        if (count >= 100) colorClass = 'geosetta-cluster-large';
        else if (count >= 25) colorClass = 'geosetta-cluster-medium';

        const icon = L.divIcon({
            className: 'geosetta-cluster ' + colorClass,
            html: `<div>${count}</div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        });
        const m = L.marker([lat, lon], { icon });
        m.bindPopup(`
            <div style="font-size:12px; line-height:1.35;">
                <div style="font-weight:900; margin-bottom:6px;">${count} boreholes</div>
                <div style="color:#444;">Zoom in to see exact locations.</div>
            </div>
        `);
        m.on('click', () => {
            try {
                const nextZ = Math.min((geosettaTabMap.getZoom() || 10) + 2, 16);
                geosettaTabMap.setView([lat, lon], nextZ);
            } catch (_) {}
        });
        geosettaTabMarkers.addLayer(m);
    });

    // Do not auto-fit; we are rendering the current viewport aggregation.
}
let geosettaLayer = null;
let geosettaFeatureByKey = {};
let geosettaSelected = null; // cached selected feature summary (for export/report)
let geosettaLastRequestId = 0;

// DIGGS XML layer state
let diggsMap = null;
let diggsLayer = null;
let diggsMapExcavation = null;
let diggsLayerExcavation = null;
let diggsExcavationFeatureIdToLayer = {};
let diggsMapDiaphragm = null;
let diggsLayerDiaphragm = null;
let diggsDiaphragmFeatureIdToLayer = {};
let diggsMapShallow = null;
let diggsLayerShallow = null;
let diggsShallowFeatureIdToLayer = {};
let diggsFeatureByKey = {};
let diggsAllFeatures = [];  // Store all features for filtering
let diggsCurrentFilter = 'all';  // Current filter: 'all', 'cpt', 'spt'
let diggsBoreholeList = {};  // {cpt: [{id, name, ...}], spt: [{id, name, ...}]}
let diggsSelected = null;
let diggsLastRequestId = 0;
let diggsAutoLoaded = false;
let diggsDetailCache = {};
let diggsDetailIndex = {};  // { locationId: { lithology_uscs, ... } } from boreholes API - instant display without borehole_detail call
let diggsAutoLoadRetryCount = 0;
let diggsSelectedTests = [];  // [{boreholeId, boreholeName, testType, testId, testName}, ...]
let diggsSelectedBoreholes = [];  // [{id, title, feature_type, ...}, ...] - 

// ==========================================
// 
// ==========================================
function updateUnitSystem() {
    const unitSystemRadio = document.querySelector('input[name="unit-system"]:checked');
    const unitSystem = unitSystemRadio ? unitSystemRadio.value : 'imperial';
    const previousUnitSystem = window.__liquefactionUnitSystem || unitSystem;
    const unitChanged = previousUnitSystem !== unitSystem;
    
    // 
    const units = {
        imperial: {
            length: 'ft',
            pressure: 'tsf',
            unitWeight: 'pcf',
            depth: 'ft',
            gwt: 'ft'
        },
        metric: {
            length: 'm',
            pressure: 'kPa',
            unitWeight: 'kN/m³',
            depth: 'm',
            gwt: 'm'
        }
    };
    
    const currentUnits = units[unitSystem];
    
    // 1. Manual Input Groundwater Level 
    const manualGwtLabel = document.querySelector('label[for="manual-gwt"]');
    if (manualGwtLabel) {
        const unitSpan = manualGwtLabel.querySelector('.unit-gwt-manual');
        if (unitSpan) {
            unitSpan.textContent = currentUnits.gwt;
        } else {
            manualGwtLabel.innerHTML = `Groundwater Level (<span class="unit-gwt-manual">${currentUnits.gwt}</span>)`;
        }
    }
    
    // 2. USGS Input Groundwater Level 
    //  label
    let usgsGwtLabel = document.querySelector('label[for="usgs-gwt"]');
    if (!usgsGwtLabel) {
        // ， input  label
        const usgsGwtInput = document.getElementById('usgs-gwt');
        if (usgsGwtInput) {
            const formGroup = usgsGwtInput.closest('.form-group');
            if (formGroup) {
                usgsGwtLabel = formGroup.querySelector('label');
            }
        }
    }
    if (usgsGwtLabel) {
        // ，
        const unitSpan = usgsGwtLabel.querySelector('.unit-gwt');
        if (unitSpan) {
            unitSpan.textContent = currentUnits.gwt;
        } else {
            //  unit-gwt span， label
            usgsGwtLabel.innerHTML = `Groundwater Level (<span class="unit-gwt">${currentUnits.gwt}</span>)`;
        }
    }
    
    // ： class  unit-gwt span（）
    const unitGwtSpans = document.querySelectorAll('.unit-gwt');
    unitGwtSpans.forEach(span => {
        span.textContent = currentUnits.gwt;
    });
    
    // 3. SPT Groundwater Level 
    const sptGwtSpan = document.querySelector('.unit-spt-gwt');
    if (sptGwtSpan) {
        sptGwtSpan.textContent = `(${currentUnits.gwt})`;
    }
    const sptGwtDesignSpan = document.querySelector('.unit-spt-gwt-design');
    if (sptGwtDesignSpan) {
        sptGwtDesignSpan.textContent = `(${currentUnits.gwt})`;
    }
    
    // 4. CPT Groundwater Level 
    const cptGwtSpan = document.querySelector('.unit-cpt-gwt');
    if (cptGwtSpan) {
        cptGwtSpan.textContent = `(${currentUnits.gwt})`;
    }
    const cptGwtDesignSpan = document.querySelector('.unit-cpt-gwt-design');
    if (cptGwtDesignSpan) {
        cptGwtDesignSpan.textContent = `(${currentUnits.gwt})`;
    }
    
    // 5. SPT  -  Depth  γt
    const sptTables = document.querySelectorAll('.spt-data-table');
    sptTables.forEach(table => {
        if (table.id === 'sf-layers-table') {
            // Shallow Foundation has its own unit system handler and keeps subscript HTML labels.
            return;
        }
        const headers = table.querySelectorAll('thead th');
        headers.forEach((th) => {
            const text = th.textContent.trim();
            if (text.includes('Depth (m)') || text.includes('Depth (ft)')) {
                th.textContent = `Depth (${currentUnits.depth})`;
            } else if (text.includes('γt (tf/m³)') || text.includes('γt (kN/m³)') || text.includes('γt (pcf)')) {
                th.textContent = `γt (${currentUnits.unitWeight})`;
            }
        });
    });
    
    // 6. CPT 
    const cptTables = document.querySelectorAll('.cpt-data-table');
    cptTables.forEach(table => {
        const headers = table.querySelectorAll('thead th');
        headers.forEach((th) => {
            const text = th.textContent.trim();
            if (text.includes('Depth (m)') || text.includes('Depth (ft)')) {
                th.textContent = `Depth (${currentUnits.depth})`;
            } else if (text.includes('qc (kPa)') || text.includes('qc (tsf)')) {
                th.textContent = unitSystem === 'imperial' ? 'qc (tsf)' : 'qc (kPa)';
            } else if (text.includes('fs (kPa)') || text.includes('fs (tsf)')) {
                th.textContent = unitSystem === 'imperial' ? 'fs (tsf)' : 'fs (kPa)';
            } else if (text.includes('u₂ (kPa)') || text.includes('u₂ (tsf)') || text.includes('u₂ (m)') || text.includes('u₂ (ft)')) {
                // CPT input u2 is treated as water head (length), not pressure
                th.textContent = unitSystem === 'imperial' ? 'u₂ (ft)' : 'u₂ (m)';
            }
        });
    });

    // 6b. CPT Data Input unit hint (label next to title)
    const cptUnitHints = document.querySelectorAll('.cpt-data-unit-hint');
    cptUnitHints.forEach(el => {
        if (unitSystem === 'imperial') {
            el.textContent = '[Depth (ft), qc/fs (tsf), u₂ (ft)]';
        } else {
            el.textContent = '[Depth (m), qc/fs (kPa), u₂ (m)]';
        }
    });
    
    // 7. （）
    const stratTable = document.getElementById('stratigraphic-table');
    if (stratTable) {
        const headers = stratTable.querySelectorAll('thead th');
        headers.forEach((th) => {
            const text = th.textContent.trim();
            if (text.includes('Depth (m)') || text.includes('Depth (ft)')) {
                th.textContent = `Depth (${currentUnits.depth})`;
            } else if (text.includes('γt (tf/m³)') || text.includes('γt (kN/m³)') || text.includes('γt (pcf)')) {
                th.textContent = `γt (${currentUnits.unitWeight})`;
            }
        });
    }

    // Convert existing liquefaction table values when user switches unit system.
    // Without this, labels change but numbers stay in old units and calculations become wrong.
    if (unitChanged) {
        const FT_TO_M = 0.3048;
        const TSF_TO_KPA = 95.7605;
        const PCF_PER_KN_M3 = 6.36588;

        const convertDepth = (v) => (previousUnitSystem === 'imperial' && unitSystem === 'metric')
            ? (v * FT_TO_M)
            : (v / FT_TO_M);
        const convertStress = (v) => (previousUnitSystem === 'imperial' && unitSystem === 'metric')
            ? (v * TSF_TO_KPA)
            : (v / TSF_TO_KPA);
        const convertUnitWeight = (v) => (previousUnitSystem === 'imperial' && unitSystem === 'metric')
            ? (v / PCF_PER_KN_M3)
            : (v * PCF_PER_KN_M3);

        // SPT rows: depth range + gamma.
        document.querySelectorAll('.spt-data-table tbody tr').forEach((row) => {
            const inputs = row.querySelectorAll('input');
            if (!inputs || inputs.length < 2) return;

            const depthInput = inputs[0];
            const gammaInput = inputs[1];

            if (depthInput && depthInput.value) {
                const m = String(depthInput.value).trim().match(/(-?\d+\.?\d*)\s*-\s*(-?\d+\.?\d*)/);
                if (m) {
                    const a = Number(m[1]);
                    const b = Number(m[2]);
                    if (isFinite(a) && isFinite(b)) {
                        depthInput.value = `${convertDepth(a).toFixed(2)} - ${convertDepth(b).toFixed(2)}`;
                    }
                }
            }

            if (gammaInput && gammaInput.value !== '') {
                const g = Number(gammaInput.value);
                if (isFinite(g)) gammaInput.value = convertUnitWeight(g).toFixed(2);
            }
        });

        // CPT rows: depth, qc, fs, u2(head).
        document.querySelectorAll('.cpt-data-table tbody tr').forEach((row) => {
            const inputs = row.querySelectorAll('input');
            if (!inputs || inputs.length < 4) return;
            const depthInput = inputs[0];
            const qcInput = inputs[1];
            const fsInput = inputs[2];
            const u2Input = inputs[3];

            if (depthInput && depthInput.value !== '') {
                const v = Number(depthInput.value);
                if (isFinite(v)) depthInput.value = convertDepth(v).toFixed(2);
            }
            if (qcInput && qcInput.value !== '') {
                const v = Number(qcInput.value);
                if (isFinite(v)) qcInput.value = convertStress(v).toFixed(2);
            }
            if (fsInput && fsInput.value !== '') {
                const v = Number(fsInput.value);
                if (isFinite(v)) fsInput.value = convertStress(v).toFixed(2);
            }
            if (u2Input && u2Input.value !== '') {
                const v = Number(u2Input.value);
                if (isFinite(v)) u2Input.value = convertDepth(v).toFixed(2);
            }
        });

        // Convert visible GWT inputs.
        ['manual-gwt', 'usgs-gwt', 'spt-gwt', 'spt-gwt-design', 'cpt-gwt', 'cpt-gwt-design'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el || el.value === '') return;
            const v = Number(el.value);
            if (isFinite(v)) el.value = convertDepth(v).toFixed(2);
        });

        // Convert in-memory per-borehole GWT states.
        try {
            if (typeof sptBoreholeData === 'object' && sptBoreholeData) {
                Object.keys(sptBoreholeData).forEach((k) => {
                    const obj = sptBoreholeData[k] || {};
                    if (isFinite(Number(obj.gwt))) obj.gwt = convertDepth(Number(obj.gwt));
                    if (isFinite(Number(obj.gwtDesign))) obj.gwtDesign = convertDepth(Number(obj.gwtDesign));
                });
            }
        } catch (_) {}
        try {
            if (typeof cptBoreholeData === 'object' && cptBoreholeData) {
                Object.keys(cptBoreholeData).forEach((k) => {
                    const obj = cptBoreholeData[k] || {};
                    if (isFinite(Number(obj.gwt))) obj.gwt = convertDepth(Number(obj.gwt));
                    if (isFinite(Number(obj.gwtDesign))) obj.gwtDesign = convertDepth(Number(obj.gwtDesign));
                });
            }
        } catch (_) {}
    }
    
    window.__liquefactionUnitSystem = unitSystem;
    console.log(`Unit system updated to: ${unitSystem}`);
}

// ==========================================
// CPT （qt, Qt, Fr, Ic）
// ==========================================
function computeCPTDerivedParameters({ cptRows, gwt, unitSystem, netAreaRatio }) {
    // Assumptions:
    // - Input units follow current UI unit system:
    //   - metric: depth(m), qc/fs(kPa), u2(head, m), gwt(m)
    //   - imperial: depth(ft), qc/fs(tsf), u2(head, ft), gwt(ft)
    // - For stress profile, we currently assume a representative total unit weight:
    //   gamma_t ≈ 18.0 kN/m^3 (about 115 pcf). This affects sigma_v0 and sigma'_v0.
    //   (Future: implement gamma_method options with literature correlations.)

    const TSF_TO_KPA = 95.7605;
    const FT_TO_M = 0.3048;
    const gamma_kN_m3 = 18.0; // kN/m^3 == kPa/m
    const gamma_w = 9.81; // kN/m^3 == kPa/m

    const rowsSI = (cptRows || [])
        .map(r => {
            const depth = unitSystem === 'imperial' ? (parseFloat(r.depth) * FT_TO_M) : parseFloat(r.depth);
            const qc = unitSystem === 'imperial' ? (parseFloat(r.qc) * TSF_TO_KPA) : parseFloat(r.qc);
            const fs = unitSystem === 'imperial' ? (parseFloat(r.fs) * TSF_TO_KPA) : parseFloat(r.fs);
            // u2 is treated as water head (length). Convert to pressure (kPa) for qt correction.
            const u2_head_m = (r.u2 === null || r.u2 === undefined || r.u2 === '') ? null :
                (unitSystem === 'imperial' ? (parseFloat(r.u2) * FT_TO_M) : parseFloat(r.u2));
            const u2_kpa = (u2_head_m === null || !Number.isFinite(u2_head_m)) ? null : (u2_head_m * gamma_w); // kPa
            return {
                depth_m: depth,
                qc_kpa: qc,
                fs_kpa: fs,
                u2_head_m: (u2_head_m === null || !Number.isFinite(u2_head_m)) ? null : u2_head_m,
                u2_kpa: u2_kpa
            };
        })
        .filter(r => Number.isFinite(r.depth_m) && Number.isFinite(r.qc_kpa) && Number.isFinite(r.fs_kpa))
        .sort((a, b) => a.depth_m - b.depth_m);

    const gwt_m = unitSystem === 'imperial' ? (parseFloat(gwt) * FT_TO_M) : parseFloat(gwt);
    const an = Number.isFinite(parseFloat(netAreaRatio)) ? parseFloat(netAreaRatio) : 0.8;

    let sigma_v0 = 0.0; // kPa
    let prevDepth = 0.0; // m

    const out = [];
    for (const r of rowsSI) {
        const depth = r.depth_m;
        const thickness = Math.max(0, depth - prevDepth);
        sigma_v0 += thickness * gamma_kN_m3; // kPa

        const u = (Number.isFinite(gwt_m) && depth > gwt_m) ? (depth - gwt_m) * gamma_w : 0.0; // kPa
        const sigma_v0_eff = Math.max(0.0001, sigma_v0 - u); // avoid 0

        // qt correction (if u2 provided); otherwise use qc as proxy
        const qt = (r.u2_kpa === null) ? r.qc_kpa : (r.qc_kpa + (1.0 - an) * r.u2_kpa);

        const denom = Math.max(0.0001, (qt - sigma_v0));
        const Qt = denom / sigma_v0_eff;
        const Fr = (r.fs_kpa / denom) * 100.0;

        // Ic (Robertson-style)
        let Ic = null;
        if (Qt > 0 && Fr > 0) {
            const logQt = Math.log10(Qt);
            const logFr = Math.log10(Fr);
            Ic = Math.sqrt(Math.pow(3.47 - logQt, 2) + Math.pow(logFr + 1.22, 2));
        }

        // Convert back to display units
        const depth_out = unitSystem === 'imperial' ? (depth / FT_TO_M) : depth;
        const stress_out = unitSystem === 'imperial' ? (sigma_v0 / TSF_TO_KPA) : sigma_v0;
        const stress_eff_out = unitSystem === 'imperial' ? (sigma_v0_eff / TSF_TO_KPA) : sigma_v0_eff;
        const qc_out = unitSystem === 'imperial' ? (r.qc_kpa / TSF_TO_KPA) : r.qc_kpa;
        const fs_out = unitSystem === 'imperial' ? (r.fs_kpa / TSF_TO_KPA) : r.fs_kpa;
        // Display u2 as head (length), matching CPT input
        const u2_head_out = (r.u2_head_m === null) ? null : (unitSystem === 'imperial' ? (r.u2_head_m / FT_TO_M) : r.u2_head_m);
        const qt_out = unitSystem === 'imperial' ? (qt / TSF_TO_KPA) : qt;

        out.push({
            depth: depth_out,
            qc: qc_out,
            fs: fs_out,
            u2: u2_head_out,
            qt: qt_out,
            sigma_v0: stress_out,
            sigma_v0_eff: stress_eff_out,
            Qt: Qt,
            Fr: Fr,
            Ic: Ic
        });

        prevDepth = depth;
    }

    return {
        unitSystem,
        assumptions: {
            gamma_assumed_kN_m3: gamma_kN_m3,
            gamma_w_kN_m3: gamma_w,
            net_area_ratio: an
        },
        rows: out
    };
}

// ==========================================
// Summary Modal  tab
// ==========================================
function switchSummaryModalTab(tabKey) {
    const summary = document.getElementById('summary-tab-summary');
    const cpt = document.getElementById('summary-tab-cpt');
    const btnSummary = document.getElementById('summary-tab-btn-summary');
    const btnCpt = document.getElementById('summary-tab-btn-cpt');
    if (!summary || !cpt || !btnSummary || !btnCpt) return;

    const activeStyle = 'background: rgba(0, 217, 255, 0.25); border: 1px solid rgba(0, 217, 255, 0.5); color: var(--text-primary);';
    const inactiveStyle = 'background: transparent; border: 1px solid rgba(0, 217, 255, 0.25); color: var(--text-secondary);';

    if (tabKey === 'cpt') {
        summary.style.display = 'none';
        cpt.style.display = 'block';
        btnSummary.style.cssText = btnSummary.style.cssText.replace(activeStyle, inactiveStyle);
        btnCpt.style.cssText = btnCpt.style.cssText.replace(inactiveStyle, activeStyle);
        btnSummary.setAttribute('data-active', '0');
        btnCpt.setAttribute('data-active', '1');
    } else {
        cpt.style.display = 'none';
        summary.style.display = 'block';
        btnCpt.style.cssText = btnCpt.style.cssText.replace(activeStyle, inactiveStyle);
        btnSummary.style.cssText = btnSummary.style.cssText.replace(inactiveStyle, activeStyle);
        btnCpt.setAttribute('data-active', '0');
        btnSummary.setAttribute('data-active', '1');
    }
}

document.addEventListener("DOMContentLoaded", function() {
    // Lucide Icons: ensure sidebar icons render even if inline init is blocked by CSP
    try {
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons({ attrs: { width: 20, height: 20, 'stroke-width': 1.5 } });
        }
    } catch (_) {}

    // ： sidebar-wrapper  Y ， elementFromPoint； hover/
    (function() {
        var layer = document.getElementById('sidebar-click-layer');
        var sidebar = document.getElementById('sidebar');
        if (!layer || !sidebar) return;

        function getItemAt(x, y) {
            var items = sidebar.querySelectorAll('.menu-item');
            for (var i = 0; i < items.length; i++) {
                var r = items[i].getBoundingClientRect();
                if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return items[i];
            }
            return null;
        }

        function clearHoverPress() {
            sidebar.querySelectorAll('.menu-item').forEach(function(el) {
                el.classList.remove('sidebar-hover', 'sidebar-press');
            });
        }

        layer.addEventListener('mousemove', function(e) {
            var item = getItemAt(e.clientX, e.clientY);
            sidebar.querySelectorAll('.menu-item').forEach(function(el) {
                el.classList.toggle('sidebar-hover', el === item);
            });
        });
        layer.addEventListener('mouseleave', clearHoverPress);

        layer.addEventListener('mousedown', function(e) {
            var item = getItemAt(e.clientX, e.clientY);
            if (item) item.classList.add('sidebar-press');
        });
        layer.addEventListener('mouseup', function() { clearHoverPress(); });
        layer.addEventListener('click', function(e) {
            var item = getItemAt(e.clientX, e.clientY);
            if (!item) return;
            var name = item.getAttribute('data-tab');
            if (name && typeof window.changeTab === 'function') {
                e.preventDefault();
                e.stopPropagation();
                window.changeTab(name);
            }
            clearHoverPress();
        });
    })();

    //  Welcome
    changeTab('Welcome');

    // ， Welcome （）
    setTimeout(function() { generateBoreholeTables(); }, 0);
    
    // （）
    toggleInputMode();
    
    // ，
    const liquefactionPage = document.getElementById('liquefaction-page');
    if (liquefactionPage) {
        //  MutationObserver 
        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const isVisible = liquefactionPage.style.display !== 'none' && 
                                     window.getComputedStyle(liquefactionPage).display !== 'none';
                    if (isVisible) {
                        // 
                        setTimeout(() => {
                            initLiquefactionMaps();
                        }, 300);
                    }
                }
            });
        });
        observer.observe(liquefactionPage, { attributes: true, attributeFilter: ['style'] });
    }
    
    // ：（ initLiquefactionMaps ）
    // ，
    
    // 
    window.initLiquefactionMaps = function() {
        //  Leaflet 
        function tryInit() {
            if (typeof L === 'undefined') {
                setTimeout(tryInit, 100);
                return;
            }
            
            //  USGS 
            const mapContainer = document.getElementById('map-container');
            if (mapContainer) {
                // 
                if (mapContainer.offsetHeight === 0) {
                    mapContainer.style.height = '300px';
                }
                
                const containerParent = mapContainer.closest('.page-content');
                const isPageVisible = containerParent && containerParent.style.display !== 'none';
                
                if (isPageVisible) {
                    if (!map) {
                        console.log('Initializing USGS map from initLiquefactionMaps...');
                        initMap(true);
                    } else {
                        console.log('USGS map exists, invalidating size...');
                        map.invalidateSize();
                    }
                }
            }
            
            //  DIGGS 
            const diggsMapContainer = document.getElementById('diggs-map-container');
            if (diggsMapContainer) {
                // 
                if (diggsMapContainer.offsetHeight === 0) {
                    diggsMapContainer.style.height = '600px';
                }
                
                const diggsParent = diggsMapContainer.closest('.page-content');
                const isDiggsPageVisible = diggsParent && diggsParent.style.display !== 'none';
                
                if (isDiggsPageVisible) {
                    if (!diggsMap) {
                        console.log('Initializing DIGGS map from initLiquefactionMaps...');
                        initDiggsMap(true);
                    } else {
                        console.log('DIGGS map exists, invalidating size...');
                        diggsMap.invalidateSize();
                    }
                }
            }
        }
        tryInit();
    };
    
    // （ CSP ）
    const liquefactionCard = document.getElementById('liquefaction-card');
    if (liquefactionCard) {
        liquefactionCard.addEventListener('click', function() {
            console.log('=== LIQUEFACTION CARD CLICKED ===');
            const lp = document.getElementById('liquefaction-page');
            console.log('liquefaction-page before:', lp ? lp.style.display : 'not found');
            const changeTabFn = window.changeTab;
            console.log('changeTab available:', typeof changeTabFn, 'window.changeTab:', typeof window.changeTab);
            
            if (typeof changeTabFn === 'function') {
                changeTabFn('Soil Mechanics');
                setTimeout(() => {
                    const lp2 = document.getElementById('liquefaction-page');
                    console.log('liquefaction-page after:', lp2 ? lp2.style.display : 'not found');
                    if (lp2 && lp2.style.display === 'none') {
                        console.log('Force showing page');
                        lp2.style.display = 'block';
                    }
                    if (typeof window.initLiquefactionMaps === 'function') {
                        setTimeout(() => window.initLiquefactionMaps(), 500);
                    }
                }, 200);
            } else {
                console.error('changeTab not found, using fallback');
                document.querySelectorAll('.page-content').forEach(p => p.style.display = 'none');
                if (lp) lp.style.display = 'block';
                const titleEl = document.getElementById('current-title');
                if (titleEl) titleEl.innerHTML = 'Soil Mechanics Analysis';
                document.querySelectorAll('.menu-item').forEach(item => {
                    item.classList.remove('active');
                    if (item.innerText.includes('Soil')) item.classList.add('active');
                });
                if (typeof window.initLiquefactionMaps === 'function') {
                    setTimeout(() => window.initLiquefactionMaps(), 500);
                }
            }
        });
    }

    //  Deep Excavation （）
    const excavationCard = document.getElementById('excavation-card');
    if (excavationCard) {
        excavationCard.style.pointerEvents = 'auto';
        excavationCard.style.position = 'relative';
        excavationCard.style.zIndex = '1000';
        excavationCard.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof window.changeTab === 'function') {
                window.changeTab('Deep Excavation');
            }
        });
    }
    
    //  USGS API 
    const fetchBtn = document.getElementById('fetch-usgs-btn');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', fetchUSGSData);
    }

    //  DIGGSImport Data - 
    document.addEventListener('click', function(e) {
        const btn = e.target && e.target.closest ? e.target.closest('#diggs-import-data-btn') : null;
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            try {
                importSelectedBoreholesData();
            } catch (err) {
                console.error('[DIGGS] importSelectedBoreholesData() failed:', err);
                alert('Import failed: ' + (err?.message || String(err)));
            }
            return;
        }
        // DIGGSSelect this point（popup ，CSP ）
        const selectBtn = e.target && e.target.closest ? e.target.closest('.diggs-select-point-btn') : null;
        if (selectBtn && selectBtn.dataset && selectBtn.dataset.diggsKey) {
            e.preventDefault();
            try {
                selectDiggsFeature(selectBtn.dataset.diggsKey);
            } catch (err) {
                console.error('[DIGGS] selectDiggsFeature failed:', err);
            }
            return;
        }
        // DIGGSImport SPT（popup ，）
        const importSptBtn = e.target && e.target.closest ? e.target.closest('.diggs-import-spt-btn') : null;
        if (importSptBtn && importSptBtn.dataset) {
            e.preventDefault();
            e.stopPropagation();
            try {
                importDiggsSptFromPopup(importSptBtn.dataset.featureId || '', importSptBtn.dataset.boreholeName || 'DIGGS Point');
            } catch (err) {
                console.error('[DIGGS] importDiggsSptFromPopup failed:', err);
                alert('Import failed: ' + (err?.message || String(err)));
            }
            return;
        }
        // DIGGSImport Stratigraphy（popup ， Deep Excavation）
        const importStratBtn = e.target && e.target.closest ? e.target.closest('.diggs-import-stratigraphy-btn') : null;
        if (importStratBtn && importStratBtn.dataset) {
            e.preventDefault();
            e.stopPropagation();
            try {
                importDiggsStratigraphyFromPopup(importStratBtn.dataset.featureId || '', importStratBtn.dataset.boreholeName || 'DIGGS Point');
            } catch (err) {
                console.error('[DIGGS] importDiggsStratigraphyFromPopup failed:', err);
            }
            return;
        }
        // DIGGSImport Stratigraphy to Supported Diaphragm
        const importStratDiaBtn = e.target && e.target.closest ? e.target.closest('.diggs-import-stratigraphy-diaphragm-btn') : null;
        if (importStratDiaBtn && importStratDiaBtn.dataset) {
            e.preventDefault();
            e.stopPropagation();
            try {
                importDiggsStratigraphyToDiaphragmFromPopup(importStratDiaBtn.dataset.featureId || '', importStratDiaBtn.dataset.boreholeName || 'DIGGS Point');
            } catch (err) {
                console.error('[DIGGS] importDiggsStratigraphyToDiaphragmFromPopup failed:', err);
            }
            return;
        }
        // DIGGSImport Stratigraphy to Shallow Foundation
        const importStratShallowBtn = e.target && e.target.closest ? e.target.closest('.diggs-import-stratigraphy-shallow-btn') : null;
        if (importStratShallowBtn && importStratShallowBtn.dataset) {
            e.preventDefault();
            e.stopPropagation();
            try {
                importDiggsStratigraphyToShallowFromPopup(importStratShallowBtn.dataset.featureId || '', importStratShallowBtn.dataset.boreholeName || 'DIGGS Point');
            } catch (err) {
                console.error('[DIGGS] importDiggsStratigraphyToShallowFromPopup failed:', err);
            }
            return;
        }
        // DIGGSImport CPT（popup ，）
        const importCptBtn = e.target && e.target.closest ? e.target.closest('.diggs-import-cpt-btn') : null;
        if (importCptBtn && importCptBtn.dataset) {
            e.preventDefault();
            e.stopPropagation();
            try {
                importDiggsCptFromPopup(importCptBtn.dataset.featureId || '', importCptBtn.dataset.boreholeName || 'DIGGS Point');
            } catch (err) {
                console.error('[DIGGS] importDiggsCptFromPopup failed:', err);
                alert('Import failed: ' + (err?.message || String(err)));
            }
            return;
        }
    });

    //  Geosetta 
    const fetchGeoBtn = document.getElementById('fetch-geosetta-btn');
    if (fetchGeoBtn) {
        fetchGeoBtn.addEventListener('click', function() {
            fetchGeosettaBoreholes({ zoomToResults: true });
        });
    }
    const clearGeoBtn = document.getElementById('clear-geosetta-btn');
    if (clearGeoBtn) {
        clearGeoBtn.addEventListener('click', function() {
            clearGeosettaLayer();
        });
    }
    const geoRadius = document.getElementById('geosetta-radius');
    if (geoRadius) {
        geoRadius.addEventListener('change', function() {
            const mode = getInputMode();
            const autoLoad = document.getElementById('geosetta-auto-load');
            if (mode === 'geosetta' && autoLoad && autoLoad.checked) {
                scheduleGeosettaFetch(250);
            }
        });
    }

    const geoAuto = document.getElementById('geosetta-auto-load');
    if (geoAuto) {
        geoAuto.addEventListener('change', function() {
            const mode = getInputMode();
            if (mode === 'geosetta' && geoAuto.checked) {
                scheduleGeosettaFetch(150);
            }
        });
    }

    // DIGGS XML data is auto-loaded; no manual load button is required.
    const clearDiggsBtn = document.getElementById('clear-diggs-btn');
    if (clearDiggsBtn) {
        clearDiggsBtn.addEventListener('click', function() {
            clearDiggsLayer();
        });
    }
    const diggsSelect = document.getElementById('diggs-xml-select');
    if (diggsSelect) {
        diggsSelect.addEventListener('change', function() {
            fetchDiggsBoreholes({ zoomToResults: true });
        });
    }
    const fetchDiggsBtn = document.getElementById('fetch-diggs-btn');
    if (fetchDiggsBtn) {
        fetchDiggsBtn.addEventListener('click', function() {
            fetchDiggsBoreholes({ zoomToResults: true });
        });
    }
    const fetchDiggsExcavationBtn = document.getElementById('fetch-diggs-excavation-btn');
    if (fetchDiggsExcavationBtn) {
        fetchDiggsExcavationBtn.addEventListener('click', function() {
            fetchDiggsBoreholesForExcavation({ zoomToResults: true });
        });
    }
    const diggsSelectExcavation = document.getElementById('diggs-xml-select-excavation');
    if (diggsSelectExcavation) {
        diggsSelectExcavation.addEventListener('change', function() {
            fetchDiggsBoreholesForExcavation({ zoomToResults: true });
        });
    }
    const fetchDiggsDiaphragmBtn = document.getElementById('fetch-diggs-diaphragm-btn');
    if (fetchDiggsDiaphragmBtn) {
        fetchDiggsDiaphragmBtn.addEventListener('click', function() {
            fetchDiggsBoreholesForDiaphragm({ zoomToResults: true });
        });
    }
    const diggsSelectDiaphragm = document.getElementById('diggs-xml-select-diaphragm');
    if (diggsSelectDiaphragm) {
        diggsSelectDiaphragm.addEventListener('change', function() {
            fetchDiggsBoreholesForDiaphragm({ zoomToResults: true });
        });
    }
    const fetchDiggsShallowBtn = document.getElementById('fetch-diggs-shallow-btn');
    if (fetchDiggsShallowBtn) {
        fetchDiggsShallowBtn.addEventListener('click', function() {
            fetchDiggsBoreholesForShallow({ zoomToResults: true });
        });
    }
    const diggsSelectShallow = document.getElementById('diggs-xml-select-shallow');
    if (diggsSelectShallow) {
        diggsSelectShallow.addEventListener('change', function() {
            fetchDiggsBoreholesForShallow({ zoomToResults: true });
        });
    }
    // Clear user uploads on refresh, then populate XML dropdowns (preset only)
    fetch('/api/diggs/clear-uploads', { method: 'POST' })
        .then(function() {
            if (typeof populateDiggsXmlDropdowns === 'function') populateDiggsXmlDropdowns();
        })
        .catch(function() {
            if (typeof populateDiggsXmlDropdowns === 'function') populateDiggsXmlDropdowns();
        });
    const uploadLiq = document.getElementById('diggs-xml-upload-liquefaction');
    if (uploadLiq) {
        uploadLiq.addEventListener('change', function() {
            if (this.files && this.files[0]) handleDiggsXmlUpload(this.files[0], 'liquefaction');
            this.value = '';
        });
    }
    const uploadExc = document.getElementById('diggs-xml-upload-excavation');
    if (uploadExc) {
        uploadExc.addEventListener('change', function() {
            if (this.files && this.files[0]) handleDiggsXmlUpload(this.files[0], 'excavation');
            this.value = '';
        });
    }
    const uploadDia = document.getElementById('diggs-xml-upload-diaphragm');
    if (uploadDia) {
        uploadDia.addEventListener('change', function() {
            if (this.files && this.files[0]) handleDiggsXmlUpload(this.files[0], 'diaphragm');
            this.value = '';
        });
    }
    const uploadShallow = document.getElementById('diggs-xml-upload-shallow');
    if (uploadShallow) {
        uploadShallow.addEventListener('change', function() {
            if (this.files && this.files[0]) handleDiggsXmlUpload(this.files[0], 'shallow');
            this.value = '';
        });
    }
    const diggsBoreholeSelectExcavation = document.getElementById('diggs-borehole-select-excavation');
    if (diggsBoreholeSelectExcavation) {
        diggsBoreholeSelectExcavation.addEventListener('change', function() {
            const importBtn = document.getElementById('diggs-import-stratigraphy-excavation-btn');
            if (importBtn) importBtn.disabled = !this.value;
            const featureId = this.value;
            if (featureId && diggsMapExcavation && diggsExcavationFeatureIdToLayer[featureId]) {
                const layer = diggsExcavationFeatureIdToLayer[featureId];
                try {
                    const ll = layer.getLatLng();
                    if (ll) {
                        diggsMapExcavation.setView([ll.lat, ll.lng], Math.max(diggsMapExcavation.getZoom(), 14));
                        layer.openPopup();
                    }
                } catch (_) {}
            }
        });
    }
    const diggsImportStratigraphyExcavationBtn = document.getElementById('diggs-import-stratigraphy-excavation-btn');
    if (diggsImportStratigraphyExcavationBtn) {
        diggsImportStratigraphyExcavationBtn.addEventListener('click', function() {
            const select = document.getElementById('diggs-borehole-select-excavation');
            if (!select || !select.value) return;
            const featureId = select.value;
            const name = (select.options[select.selectedIndex] && select.options[select.selectedIndex].textContent) || featureId;
            if (typeof window.importDiggsStratigraphyFromPopup === 'function') {
                window.importDiggsStratigraphyFromPopup(featureId, name);
            }
        });
    }
    const diggsBoreholeSelectDiaphragm = document.getElementById('diggs-borehole-select-diaphragm');
    if (diggsBoreholeSelectDiaphragm) {
        diggsBoreholeSelectDiaphragm.addEventListener('change', function() {
            const importBtn = document.getElementById('diggs-import-stratigraphy-diaphragm-btn');
            if (importBtn) importBtn.disabled = !this.value;
            const featureId = this.value;
            if (featureId && diggsMapDiaphragm && diggsDiaphragmFeatureIdToLayer[featureId]) {
                const layer = diggsDiaphragmFeatureIdToLayer[featureId];
                try {
                    const ll = layer.getLatLng();
                    if (ll) {
                        diggsMapDiaphragm.setView([ll.lat, ll.lng], Math.max(diggsMapDiaphragm.getZoom(), 14));
                        layer.openPopup();
                    }
                } catch (_) {}
            }
        });
    }
    const diggsImportStratigraphyDiaphragmBtn = document.getElementById('diggs-import-stratigraphy-diaphragm-btn');
    if (diggsImportStratigraphyDiaphragmBtn) {
        diggsImportStratigraphyDiaphragmBtn.addEventListener('click', function() {
            const select = document.getElementById('diggs-borehole-select-diaphragm');
            if (!select || !select.value) return;
            const featureId = select.value;
            const name = (select.options[select.selectedIndex] && select.options[select.selectedIndex].textContent) || featureId;
            if (typeof window.importDiggsStratigraphyToDiaphragmFromPopup === 'function') {
                window.importDiggsStratigraphyToDiaphragmFromPopup(featureId, name);
            }
        });
    }
    const diggsBoreholeSelectShallow = document.getElementById('diggs-borehole-select-shallow');
    if (diggsBoreholeSelectShallow) {
        diggsBoreholeSelectShallow.addEventListener('change', function() {
            const importBtn = document.getElementById('diggs-import-stratigraphy-shallow-btn');
            if (importBtn) importBtn.disabled = !this.value;
            const featureId = this.value;
            if (featureId && diggsMapShallow && diggsShallowFeatureIdToLayer[featureId]) {
                const layer = diggsShallowFeatureIdToLayer[featureId];
                try {
                    const ll = layer.getLatLng();
                    if (ll) {
                        diggsMapShallow.setView([ll.lat, ll.lng], Math.max(diggsMapShallow.getZoom(), 14));
                        layer.openPopup();
                    }
                } catch (_) {}
            }
        });
    }
    const diggsImportStratigraphyShallowBtn = document.getElementById('diggs-import-stratigraphy-shallow-btn');
    if (diggsImportStratigraphyShallowBtn) {
        diggsImportStratigraphyShallowBtn.addEventListener('click', function() {
            const select = document.getElementById('diggs-borehole-select-shallow');
            if (!select || !select.value) return;
            const featureId = select.value;
            const name = (select.options[select.selectedIndex] && select.options[select.selectedIndex].textContent) || featureId;
            if (typeof window.importDiggsStratigraphyToShallowFromPopup === 'function') {
                window.importDiggsStratigraphyToShallowFromPopup(featureId, name);
            }
        });
    }

    // Data source tabs (avoid inline onclick - CSP safe)
    const srcDiggs = document.getElementById('source-tab-diggs');
    const srcGeo = document.getElementById('source-tab-geosetta');
    if (srcDiggs) srcDiggs.addEventListener('click', () => selectDrillingSource('diggs'));
    if (srcGeo) srcGeo.addEventListener('click', () => selectDrillingSource('geosetta'));

    // Geosetta: historic-in-radius search button (in data-source tab)
    const geosettaSearchBtn = document.getElementById('geosetta-search-btn');
    if (geosettaSearchBtn) {
        geosettaSearchBtn.addEventListener('click', function() {
            geosettaSearchHistoricInRadius();
        });
    }

    // Geosetta: address search - geocode and zoom map to location
    const geosettaAddressSearchBtn = document.getElementById('geosetta-address-search-btn');
    const geosettaAddressInput = document.getElementById('geosetta-address');
    if (geosettaAddressSearchBtn && geosettaAddressInput) {
        const doGeosettaAddressSearch = () => geosettaSearchByAddress();
        geosettaAddressSearchBtn.addEventListener('click', doGeosettaAddressSearch);
        geosettaAddressInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doGeosettaAddressSearch();
            }
        });
    }

    // Vs30 -> auto Site Class
    const vs30Input = document.getElementById('deagg-vs30');
    if (vs30Input) {
        const handler = () => {
            const v = parseFloat(vs30Input.value);
            applyAutoSiteClassFromVs30(v);
        };
        vs30Input.addEventListener('input', handler);
        vs30Input.addEventListener('change', handler);
        // initialize once (even if disabled, value exists)
        handler();
    }
    
    // （）
    const latInput = document.getElementById('latitude-input');
    const lonInput = document.getElementById('longitude-input');
    if (latInput && lonInput) {
        latInput.addEventListener('change', updateMapFromInputs);
        lonInput.addEventListener('change', updateMapFromInputs);
    }
    
    // 
    const searchBtn = document.getElementById('search-address-btn');
    if (searchBtn) {
        searchBtn.addEventListener('click', searchAddress);
    }
    
    //  Enter 
    const addressInput = document.getElementById('address-search-input');
    if (addressInput) {
        addressInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                searchAddress();
            }
        });
    }
    
    // （）
    updateUnitSystem();
});

function inferSiteClassFromVs30(vs30) {
    if (vs30 === null || vs30 === undefined || isNaN(vs30)) return null;
    // NEHRP/ASCE-style breakpoints
    if (vs30 > 1500) return 'A';
    if (vs30 >= 760) return 'B';
    if (vs30 >= 360) return 'C';
    if (vs30 >= 180) return 'D';
    return 'E';
}

function applyAutoSiteClassFromVs30(vs30) {
    const cls = inferSiteClassFromVs30(vs30);
    const badge = document.getElementById('auto-site-class');
    const badgeValue = document.getElementById('auto-site-class-value');

    if (badge && badgeValue) {
        if (cls) {
            badgeValue.textContent = `Class ${cls}`;
            badge.style.display = 'block';
        } else {
            badgeValue.textContent = 'Class -';
            badge.style.display = 'block';
        }
    }
}

function getInputMode() {
    const checked = document.querySelector('input[name="input-mode"]:checked');
    return checked ? String(checked.value || 'manual') : 'manual';
}

function setElementEnabled(el, enabled) {
    if (!el) return;
    el.disabled = !enabled;
    // visual feedback
    if (enabled) {
        el.style.opacity = '1';
        el.style.cursor = (el.tagName === 'BUTTON') ? 'pointer' : 'text';
    } else {
        el.style.opacity = '0.6';
        el.style.cursor = 'not-allowed';
    }
}

// ==========================================
// 
// ==========================================
function toggleInputMode() {
    const mode = getInputMode(); // 'manual' | 'usgs' | 'geosetta'
    const isManualMode = mode === 'manual';
    const isUsgsMode = mode === 'usgs';
    const isGeosettaMode = mode === 'geosetta';
    console.log(' - mode:', mode);
    
    // 
    const manualInputs = [
        document.getElementById('manual-pga'),
        document.getElementById('manual-mw')
    ];
    
    // Location inputs (shared for USGS/Geosetta)
    const locationInputs = [
        document.getElementById('address-search-input'),
        document.getElementById('search-address-btn'),
        document.getElementById('latitude-input'),
        document.getElementById('longitude-input')
    ];

    // USGS-only inputs
    const usgsInputs = [
        document.getElementById('code-model-select'),
        document.getElementById('risk-category-select'),
        document.getElementById('deagg-vs30'),
        document.getElementById('fetch-usgs-btn')
    ];

    // Geosetta-only inputs
    const geosettaInputs = [
        document.getElementById('geosetta-radius'),
        document.getElementById('geosetta-auto-load'),
        document.getElementById('fetch-geosetta-btn'),
        document.getElementById('clear-geosetta-btn')
    ];

    // /
    manualInputs.forEach(el => setElementEnabled(el, isManualMode));
    locationInputs.forEach(el => setElementEnabled(el, !isManualMode));
    usgsInputs.forEach(el => setElementEnabled(el, isUsgsMode));
    geosettaInputs.forEach(el => setElementEnabled(el, isGeosettaMode));
    
    // /
    if (map) {
        if (isManualMode) {
            map.dragging.disable();
            map.touchZoom.disable();
            map.doubleClickZoom.disable();
            map.scrollWheelZoom.disable();
            if (marker) marker.draggable.disable();
        } else {
            map.dragging.enable();
            map.touchZoom.enable();
            map.doubleClickZoom.enable();
            map.scrollWheelZoom.enable();
            if (marker) marker.draggable.enable();
        }
    }
    
    // Switching away from Geosetta: clear points layer to keep map clean for USGS/manual workflows
    if (!isGeosettaMode) {
        clearGeosettaLayer(true);
    }

    // If map not initialized yet and we need it (USGS/Geosetta), initialize it now
    if (!map && !isManualMode) {
        setTimeout(() => {
            const mapContainer = document.getElementById('map-container');
            if (mapContainer) {
                // 
                if (mapContainer.offsetHeight === 0) {
                    mapContainer.style.height = '300px';
                }
                initMap(true); // 
            }
        }, 200);
    }

    // Ensure map size is correct when switching into a map-enabled mode
    if (map && !isManualMode) {
        setTimeout(() => {
            if (map) {
                const mapContainer = document.getElementById('map-container');
                if (mapContainer && mapContainer.offsetHeight === 0) {
                    mapContainer.style.height = '300px';
                }
                map.invalidateSize();
            }
        }, 100);
    }

    // Geosetta UX: entering Geosetta mode should proactively load points (if possible)
    if (isGeosettaMode) {
        setGeosettaStatus('Geosetta mode enabled. Loading boreholes near the selected location…');
        const autoLoad = document.getElementById('geosetta-auto-load');
        // If map isn't ready yet, we'll try again shortly after initMap()
        setTimeout(() => {
            const modeNow = getInputMode();
            if (modeNow !== 'geosetta') return;
            if (!map || !marker) {
                setGeosettaStatus('Map not ready yet. Please wait a moment, or click the map once.', 'info');
                return;
            }
            if (autoLoad && autoLoad.checked) {
                fetchGeosettaBoreholes({ zoomToResults: false });
            } else {
                setGeosettaStatus('Geosetta ready. Click "Load Boreholes from Geosetta" to fetch points.', 'info');
            }
        }, 350);
    } else {
        // Avoid leaving a stale Geosetta status message in non-Geosetta modes
        setGeosettaStatus('');
    }
}

// ==========================================
// 2. 
// ==========================================
// Ensure changeTab is available globally
// Expose changeTab to global scope
window.changeTab = function changeTab(name) {
    try {
    // 
    const titleElement = document.getElementById('current-title');
    if (titleElement) {
        titleElement.innerHTML = name + ' Analysis';
    }

        //  (Highlight )
        const items = document.querySelectorAll('.menu-item');
        items.forEach(item => {
            item.classList.remove('active');
        // ， active
        if(item.innerText.includes(name)) {
                    item.classList.add('active');
                }
            });

    // ， DIGGS 
    if (name !== 'Soil Liquefaction' && name !== 'Soil Mechanics' && window._diggsLoadTimer) {
        clearTimeout(window._diggsLoadTimer);
        window._diggsLoadTimer = null;
    }

    // 
    const allPages = document.querySelectorAll('.page-content');
    allPages.forEach(page => { page.style.display = 'none'; });

    // 
    let pageId = '';
    if (name === 'Welcome') {
        pageId = 'welcome-page';
    } else if (name === 'Deep Excavation') {
            pageId = 'deep-excavation-page';
    } else if (name === 'Shallow Foundation') {
            pageId = 'shallow-foundation-page';
    } else if (name === 'Foundation Piles') {
            pageId = 'pile-foundation-page';
    } else if (name === 'Retaining Wall') {
            pageId = 'retaining-wall-page';
    } else if (name === 'Soil Liquefaction' || name === 'Soil Mechanics') {
        pageId = 'liquefaction-page';
    }

    // 
    if (pageId) {
        const targetPage = document.getElementById(pageId);
        if (targetPage) {
            targetPage.style.display = 'block';
            
            // ，
            if (name === 'Soil Liquefaction' || name === 'Soil Mechanics') {
                // 
                setTimeout(() => {
                    // Ensure the DIGGS panel is visible (and map gets a real size)
                    try { selectDrillingSource('diggs'); } catch (_) {}

                    //  USGS 
                    const mapContainer = document.getElementById('map-container');
                    if (mapContainer) {
                        // （）
                        if (mapContainer.offsetHeight === 0) {
                            mapContainer.style.height = '300px';
                        }
                        
                        // 
                        const containerParent = mapContainer.closest('.page-content');
                        const isPageVisible = containerParent && containerParent.style.display !== 'none';
                        
                        if (isPageVisible) {
                            if (!map) {
                                console.log('Initializing USGS map (forced)...');
                                initMap(true); // 
                            } else {
                                console.log('USGS map exists, invalidating size...');
                                map.invalidateSize();
                            }
                            // 
                            setTimeout(() => {
                                if (map && mapContainer.offsetHeight > 0) {
                                    map.invalidateSize();
                                }
                            }, 300);
                        }
                    }
                    
                    //  DIGGS 
                    const diggsMapContainer = document.getElementById('diggs-map-container');
                    if (diggsMapContainer) {
                        // 
                        if (diggsMapContainer.offsetHeight === 0) {
                            diggsMapContainer.style.height = '600px';
                        }
                        
                        // 
                        const diggsParent = diggsMapContainer.closest('.page-content');
                        const isDiggsPageVisible = diggsParent && diggsParent.style.display !== 'none';
                        
                        if (isDiggsPageVisible) {
                            if (!diggsMap) {
                                console.log('Initializing DIGGS map (forced)...');
                                initDiggsMap(true); // 
                            } else {
                                console.log('DIGGS map exists, invalidating size...');
                                diggsMap.invalidateSize();
                            }
                            setTimeout(() => {
                                if (diggsMap && diggsMapContainer.offsetHeight > 0) {
                                    diggsMap.invalidateSize();
                                }
                            }, 300);
                        }
                    }
                    
                    //  DIGGS： 2 ，
                    if (!diggsAutoLoaded && diggsMap) {
                        const diggsLoadTimer = setTimeout(() => {
                            const stillOnLiquefaction = document.getElementById('liquefaction-page') &&
                                (document.getElementById('liquefaction-page').style.display !== 'none');
                            if (stillOnLiquefaction && !diggsAutoLoaded && diggsMap) {
                                fetchDiggsBoreholes({ zoomToResults: true });
                            }
                        }, 2000);
                        window._diggsLoadTimer = diggsLoadTimer;
                    }
                }, 500); // ， Leaflet 
            }
            // Deep Excavation: initialize heavy widgets ONCE to avoid tab-switch jank
            if (name === 'Deep Excavation') {
                // 1) DIGGS map init (debounced; Leaflet map is cached in diggsMapExcavation)
                if (window.__excavationMapInitTimer) {
                    try { clearTimeout(window.__excavationMapInitTimer); } catch (_) {}
                }
                window.__excavationMapInitTimer = setTimeout(() => {
                    function tryInitExcavationMap(attempt) {
                        const excContainer = document.getElementById('diggs-map-container-excavation');
                        if (!excContainer) return;
                        const page = excContainer.closest('.page-content');
                        if (!page || (page.style.display === 'none' && window.getComputedStyle(page).display === 'none')) return;
                        if (excContainer.offsetHeight === 0) excContainer.style.height = '450px';
                        try {
                            initDiggsMapExcavation(true);
                        } catch (_) {
                            if (attempt < 2) setTimeout(() => tryInitExcavationMap(attempt + 1), 250 + attempt * 200);
                        }
                    }
                    tryInitExcavationMap(0);
                }, 380);

                // 2) Page init (Plotly + table rendering) — run only on first entry
                if (!window.__deepExcavationInitDone) {
                    window.__deepExcavationInitDone = true;
                    // Let the page paint first, then do heavy work.
                    setTimeout(() => {
                        try {
                            if (typeof initExcavationPage === 'function') initExcavationPage();
                            if (typeof switchExcavationTab === 'function') switchExcavationTab('uplift-sand-boil');
                        } catch (e) {
                            console.error('Error initializing excavation page:', e);
                        }
                    }, 0);
                } else {
                    // On subsequent entries: keep it lightweight (resize existing widgets only)
                    try {
                        if (typeof switchExcavationTab === 'function') switchExcavationTab('uplift-sand-boil');
                    } catch (_) {}
                }
            }
            if (name === 'Shallow Foundation') {
                function tryInitShallowMap(attempt) {
                    const sfContainer = document.getElementById('diggs-map-container-shallow');
                    if (!sfContainer) return;
                    const page = sfContainer.closest('.page-content');
                    if (!page || (page.style.display === 'none' && window.getComputedStyle(page).display === 'none')) return;
                    if (sfContainer.offsetHeight === 0) {
                        sfContainer.style.height = '450px';
                    }
                    try {
                        initDiggsMapShallow(true);
                    } catch (_) {
                        if (attempt < 3) setTimeout(() => tryInitShallowMap(attempt + 1), 300 + attempt * 200);
                    }
                }
                setTimeout(() => tryInitShallowMap(0), 280);
                setTimeout(() => tryInitShallowMap(0), 760);
            }
            
            // (Deep Excavation init handled above; do not re-run heavy init on every tab switch)
            } else {
                console.error('Page element not found:', pageId);
        }
        } else {
            console.warn('No page ID mapped for:', name);
    }

    } catch (error) {
        console.error('Error in changeTab:', error);
        alert('Error switching page: ' + error.message);
    }
}

// ==========================================
// 3.  ()
// ==========================================
function runAnalysis() {
    //  ()，，
    const resultArea = document.getElementById('result-area');
    if (!resultArea) return;

    // 
    resultArea.innerHTML = '<p style="color: #a0522d; font-weight: bold;">Dalah San is calculating...</p>';

    //  ()
    const hInput = document.getElementById('wall-height');
    const h = hInput ? hInput.value : 0;

    //  1 
    setTimeout(() => {
        resultArea.innerHTML = `
            <h3>Calculation Results</h3>
            <p>Wall Height: ${h} m</p>
            <p>Sliding Safety Factor: <strong>1.55</strong> (OK)</p>
            <p>Overturning Safety Factor: <strong>2.10</strong> (OK)</p>
            <p style="color: #F57F17; font-size: 12px;">✅ Meets building foundation design code requirements</p>
        `;
    }, 1000);
}

// ==========================================
//  Excel
// ==========================================
async function runLiquefactionAnalysis() {
    console.log('Run Analysis button clicked');
    
    const resultArea = document.getElementById('liquefaction-result-area');
    if (!resultArea) {
        alert('Result display area not found');
        console.error('liquefaction-result-area element not found');
        return;
    }
    
    // 
    resultArea.style.display = 'block';
    // User request: do not show "Calculating..." text
    resultArea.innerHTML = '';
    
    try {
        console.log('Starting analysis...');
        // 1. 
        const manualRadio = document.querySelector('input[name="input-mode"][value="manual"]');
        const isManualMode = manualRadio && manualRadio.checked;
        
        let pga, mw, gwtDrill, gwtDesign;
        
        if (isManualMode) {
            // 
            const pgaInput = document.getElementById('manual-pga');
            const mwInput = document.getElementById('manual-mw');
            
            pga = parseFloat(pgaInput ? pgaInput.value : 0.45);
            mw = parseFloat(mwInput ? mwInput.value : 7.5);
            gwtDrill = 2.0; // will be overridden by borehole/sounding groundwater level inputs
            gwtDesign = 2.0;
        } else {
            // USGS  -  USGS 
            // PGA  USGS  manual-pga （ updatePGAInForm  manual-pga）
            const pgaInput = document.getElementById('manual-pga');
            const mwInput = document.getElementById('usgs-mw');
            const gwtInput = document.getElementById('usgs-gwt');
            
            pga = parseFloat(pgaInput ? pgaInput.value : 0.45);
            mw = parseFloat(mwInput ? mwInput.value : (window.usgsMwValue || 7.5));
            gwtDrill = parseFloat(gwtInput ? gwtInput.value : 2.0);
            gwtDesign = gwtDrill;
        }
        
        // 2. 
        const testTypeRadio = document.querySelector('input[name="test-type"]:checked');
        const testType = testTypeRadio ? testTypeRadio.value : 'SPT';
        
        let layers = [];
        let testData = null;
        let boreholesPayload = [];
        
        if (testType === 'SPT') {
            // SPT ： tab  borehole tags（ UI ， tag ）
            const sptTabs = document.getElementById('borehole-tabs');
            const tabEls = sptTabs ? Array.from(sptTabs.querySelectorAll('.borehole-tab')).filter(t => t.id && t.id !== 'spt-add-tab-btn') : [];
            const boreholeSections = [];
            for (const tab of tabEls) {
                const bhId = tab.id ? tab.id.replace(/^tab-/, '') : '';
                if (!bhId) continue;
                const section = document.getElementById(`content-${bhId}`);
                if (section && section.classList.contains('borehole-section')) boreholeSections.push(section);
            }
            if (boreholeSections.length === 0) {
                alert('Please add at least one borehole data');
                return;
            }

            //  GWL  fallback
            const gwtInput = document.getElementById('spt-gwt');
            const gwtDesignInput = document.getElementById('spt-gwt-design');
            const globalGwtDrill = gwtInput ? (parseFloat(gwtInput.value) || gwtDrill) : gwtDrill;
            const globalGwtDesign = gwtDesignInput ? (parseFloat(gwtDesignInput.value) || gwtDesign) : gwtDesign;

            const parsedBoreholes = [];
            for (let i = 0; i < boreholeSections.length; i++) {
                const section = boreholeSections[i];
                const tabEl = tabEls[i];
                // section.id: content-BH-1 / content-BH-xxx
                const secId = section.id || '';
                const bhId = secId.startsWith('content-') ? secId.replace('content-', '') : secId || 'BH';
                const displayName = (tabEl && tabEl.textContent) ? String(tabEl.textContent).trim() : bhId;
                const bhState = (typeof sptBoreholeData === 'object' && sptBoreholeData[bhId]) ? sptBoreholeData[bhId] : {};
                const bhGwtDrill = (bhState && typeof bhState.gwt === 'number') ? bhState.gwt : globalGwtDrill;
                const bhGwtDesign = (bhState && typeof bhState.gwtDesign === 'number') ? bhState.gwtDesign : globalGwtDesign;

                const tbody = section.querySelector('tbody');
                const tableRows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
                const bhLayers = [];

                for (const row of tableRows) {
                    const allInputs = row.querySelectorAll('input');
                    const numberInputs = row.querySelectorAll('input[type="number"]');
                    const selects = row.querySelectorAll('select');
                    const analyzeSelect = selects.length >= 2 ? selects[1] : null;
                    if (numberInputs.length >= 3 && analyzeSelect) {
                        const analyze = analyzeSelect.value === 'Y';
                        if (!analyze) continue;

                        const depthInput = allInputs[0];
                        const depthText = depthInput ? depthInput.value.trim() : '';
                        const depthMatch = depthText.match(/(\d+\.?\d*)\s*-\s*(\d+\.?\d*)/);
                        if (!depthMatch) continue;

                        const endDepthRaw = parseFloat(depthMatch[2]);
                        const gammaRaw = parseFloat(numberInputs[0].value);
                        const spt_n = parseFloat(numberInputs[1].value);
                        const fc = parseFloat(numberInputs[2].value);
                        // Send in user units: imperial (ft, pcf) or metric (m, kN/m³)
                        const unitSys = (document.querySelector('input[name="unit-system"]:checked') || {}).value || 'imperial';
                        const endDepth = unitSys === 'imperial' ? endDepthRaw : endDepthRaw;  // ft or m
                        const gamma = gammaRaw;   // pcf or kN/m³
                        const soilClassInput = allInputs.length >= 6 ? allInputs[5] : null;
                        const soil_class = soilClassInput ? String(soilClassInput.value || '') : '';

                        if (!isNaN(endDepth) && !isNaN(spt_n) && !isNaN(gamma) && !isNaN(fc)) {
                            bhLayers.push({
                                depth: endDepth,
                                spt_n: spt_n,
                                fc: fc,
                                gamma: gamma,
                                soil_class
                            });
                        }
                    }
                }

                if (bhLayers.length > 0) {
                    parsedBoreholes.push({
                        id: bhId,
                        name: displayName || bhId,
                        gwt_drill: bhGwtDrill,
                        gwt_design: bhGwtDesign,
                        layers: bhLayers
                    });
                }
            }

            if (parsedBoreholes.length === 0) {
                alert('Please select at least one layer for analysis (Analyze = Y). All layers are set to Y by default.');
                return;
            }

            boreholesPayload = parsedBoreholes;

            // Backward compatibility: keep a single `layers` payload (use the first borehole).
            layers = parsedBoreholes[0].layers || [];
            gwtDrill = parsedBoreholes[0].gwt_drill;
            gwtDesign = parsedBoreholes[0].gwt_design;

            testData = {
                type: 'SPT',
                layers: layers
            };

        } else if (testType === 'CPT') {
            // CPT ：
            const cptTabs = Array.from(document.querySelectorAll('.cpt-borehole-tab'));
            if (cptTabs.length === 0) {
                alert('Please add at least one CPT tag');
                return;
            }

            const cptGwtInput = document.getElementById('cpt-gwt');
            const cptGwtDesignInput = document.getElementById('cpt-gwt-design');
            const globalCptGwtDrill = cptGwtInput ? (parseFloat(cptGwtInput.value) || gwtDrill) : gwtDrill;
            const globalCptGwtDesign = cptGwtDesignInput ? (parseFloat(cptGwtDesignInput.value) || gwtDesign) : gwtDesign;

            const parsedSoundings = [];
            for (const tab of cptTabs) {
                const cptId = tab.id ? tab.id.replace('cpt-tab-', '') : '';
                if (!cptId) continue;

                const tbody = document.getElementById(`cpt-table-body-${cptId}`);
                const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
                const cptRows = [];
                for (const row of rows) {
                    const inputs = row.querySelectorAll('input');
                    if (inputs.length >= 3) {
                        const depth = parseFloat(inputs[0].value);
                        const qc = parseFloat(inputs[1].value);
                        const fs = parseFloat(inputs[2].value);
                        const u2 = inputs[3] ? parseFloat(inputs[3].value) : null;
                        if (!isNaN(depth) && !isNaN(qc) && !isNaN(fs)) {
                            cptRows.push({
                                depth,
                                qc,
                                fs,
                                u2: isNaN(u2) ? null : u2
                            });
                        }
                    }
                }
                if (cptRows.length === 0) continue;

                const netAreaRatioInput = document.getElementById(`cpt-net-area-ratio-${cptId}`);
                const gammaMethodSelect = document.getElementById(`cpt-gamma-method-${cptId}`);
                const bhState = (typeof cptBoreholeData === 'object' && cptBoreholeData[cptId]) ? cptBoreholeData[cptId] : {};
                const netAreaRatio = (netAreaRatioInput ? (parseFloat(netAreaRatioInput.value) || 0.8) : (parseFloat(bhState?.netAreaRatio) || 0.8));
                const gammaMethod = (gammaMethodSelect ? (gammaMethodSelect.value || 'robertson') : (bhState?.gammaMethod || 'robertson'));
                const bhGwtDrill = (bhState && typeof bhState.gwt === 'number') ? bhState.gwt : globalCptGwtDrill;
                const bhGwtDesign = (bhState && typeof bhState.gwtDesign === 'number') ? bhState.gwtDesign : globalCptGwtDesign;

                parsedSoundings.push({
                    id: cptId,
                    name: cptId,
                    gwt_drill: bhGwtDrill,
                    gwt_design: bhGwtDesign,
                    cpt_params: {
                        net_area_ratio: netAreaRatio,
                        gamma_method: gammaMethod
                    },
                    cpt_data: cptRows
                });
            }

            if (parsedSoundings.length === 0) {
                alert('Please enter at least one valid CPT data row (Depth, qc, fs) in any tag');
                return;
            }

            boreholesPayload = parsedSoundings;

            // Backward compatibility: keep a single CPT payload (use current active tab if possible)
            const activeTab = document.querySelector('.cpt-borehole-tab[style*="background-color: rgb(74, 144, 226)"]') || 
                              document.querySelector('.cpt-borehole-tab[style*="#4a90e2"]') ||
                              document.querySelector('.cpt-borehole-tab');
            const currentCptId = activeTab ? activeTab.id.replace('cpt-tab-', '') : parsedSoundings[0].id;
            const primary = parsedSoundings.find(s => s.id === currentCptId) || parsedSoundings[0];
            gwtDrill = primary.gwt_drill;
            gwtDesign = primary.gwt_design;

            testData = {
                type: 'CPT',
                data: primary.cpt_data,
                params: primary.cpt_params
            };

            // Single-tag CPT intermediate (used only when exporting single sounding / legacy modal tab)
            try {
                window.cptIntermediate = computeCPTDerivedParameters({
                    cptRows: primary.cpt_data,
                    gwt: gwtDrill,
                    unitSystem: (document.querySelector('input[name="unit-system"]:checked')?.value || 'imperial'),
                    netAreaRatio: primary.cpt_params?.net_area_ratio ?? 0.8
                });
                window.cptIntermediateMeta = {
                    soundingId: primary.id,
                    gamma_method: primary.cpt_params?.gamma_method || 'robertson'
                };
            } catch (_) {
                window.cptIntermediate = null;
                window.cptIntermediateMeta = null;
            }

            layers = (primary.cpt_data || []).map(d => ({
                depth: d.depth,
                qc: d.qc,
                fs: d.fs,
                u2: d.u2
            }));
        }
        
        // ，
        const methods = testType === 'SPT' ? ['IB2014', 'NCEER2001'] : undefined;
        const cptMethods = testType === 'CPT' ? ['Youd2001', 'IB2014'] : undefined;
        
        // 
        const unitSystemRadio = document.querySelector('input[name="unit-system"]:checked');
        const unitSystem = unitSystemRadio ? unitSystemRadio.value : 'imperial';
        
        // 3. 
        const requestData = {
            test_type: testType,  // 'SPT' or 'CPT'
            pga: pga,
            mw: mw,
            gwt: gwtDesign,
            gwt_drill: gwtDrill,
            gwt_design: gwtDesign,
            methods: testType === 'CPT' ? cptMethods : methods,
            cpt_methods: testType === 'CPT' ? cptMethods : undefined,
            layers: layers,
            unit_system: unitSystem,  // 
            geosetta_selected: window.geosettaSelected || null,
            diggs_selected: window.diggsSelected || null
        };

        // Multi-tag payload (preferred). Backend will batch compute and return per-borehole results.
        if (Array.isArray(boreholesPayload) && boreholesPayload.length > 0) {
            requestData.boreholes = boreholesPayload;
        }
        
        //  CPT，
        if (testType === 'CPT' && testData) {
            requestData.cpt_params = testData.params;
            requestData.cpt_data = testData.data;
        }
        
        console.log(':', requestData);
        
        // 4.  API
        const calculateResponse = await fetch('/calculate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        });
        
        const calculateData = await calculateResponse.json();
        
        if (calculateData.status !== 'success') {
            throw new Error(calculateData.message || 'Calculation failed');
        }
        
        // 5. （）
        const latInput = document.getElementById('latitude-input');
        const lonInput = document.getElementById('longitude-input');
        const designCodeSelect = document.getElementById('design-code-select');
        
        //  Excel  methods 
        const excelRequestData = {
            ...requestData,
            project_name: 'Liquefaction Analysis',
            latitude: latInput && latInput.value ? parseFloat(latInput.value) : 'N/A',
            longitude: lonInput && lonInput.value ? parseFloat(lonInput.value) : 'N/A',
            design_code: designCodeSelect ? designCodeSelect.value : 'ASCE 7-22',
            methods: testType === 'CPT' ? cptMethods : methods,
            cpt_methods: testType === 'CPT' ? cptMethods : undefined,
            usgs_seismic: window.usgsSeismicData || null,
            geosetta_selected: window.geosettaSelected || null,
            diggs_selected: window.diggsSelected || null
        };

        // Ensure batch export includes all tags (not just the currently active one).
        if (Array.isArray(boreholesPayload) && boreholesPayload.length > 0) {
            excelRequestData.boreholes = boreholesPayload;
        }

        // CPT： Excel （qt, Qt, Fr, Ic）
        if (testType === 'CPT' && window.cptIntermediate) {
            excelRequestData.cpt_intermediate = window.cptIntermediate;
            excelRequestData.cpt_intermediate_meta = window.cptIntermediateMeta || {};
        }
        
        // 
        window.liquefactionRequestData = excelRequestData;
        window.liquefactionResults = calculateData.results || [];
        window.liquefactionMetadata = {
            ...calculateData.metadata,
            gwt: gwtDesign,
            gwt_drill: gwtDrill,
            gwt_design: gwtDesign
        };
        
        // 6.  Modal
            showAnalysisSummaryModal(calculateData.results || [], {
                ...calculateData.metadata,
            gwt: gwtDesign,
            gwt_drill: gwtDrill,
            gwt_design: gwtDesign
            });
        
    } catch (error) {
        console.error('Liquefaction analysis error:', error);
        console.error('Error stack:', error.stack);
        if (resultArea) {
            resultArea.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
        } else {
            alert(`Error: ${error.message}`);
        }
    }
}

// ==========================================
//  Excel 
// ==========================================
async function downloadExcel() {
    if (!window.liquefactionRequestData) {
        alert('Please run analysis first');
        return;
    }
    
    try {
        const requestData = window.liquefactionRequestData;
        const response = await fetch('/api/export-excel', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        });
        
        if (!response.ok) {
            let errMsg = 'Excel export failed';
            try {
                const text = await response.text();
                const errData = text ? JSON.parse(text) : {};
                errMsg = errData.message || errData.error || errMsg;
                if (!errData.message && text && text.length < 300) errMsg = text;
            } catch (_) {}
            console.error('[Excel] Server error:', response.status, errMsg);
            throw new Error(errMsg);
        }
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) {
            const err = await response.json();
            throw new Error(err.message || 'Excel export failed');
        }
        const blob = await response.blob();
        if (blob.size < 500) {
            const text = await blob.text();
            try {
                const err = JSON.parse(text);
                throw new Error(err.message || 'Excel export failed');
            } catch (parseErr) {
                const hint = text ? ` (Server: ${text.substring(0, 200)}...)` : '';
                throw new Error('Excel file is empty or invalid' + hint);
            }
        }
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'liquefaction_analysis.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        console.log('Excel file downloaded');
    } catch (error) {
        console.error('Excel download error:', error);
        alert('Excel download failed: ' + error.message);
    }
}

// Build payload for SPT plot API (from last run request data)
function buildSptPlotPayload() {
    const req = window.liquefactionRequestData;
    if (!req || (req.test_type || '').toUpperCase() !== 'SPT') return null;
    const methods = Array.isArray(req.methods) && req.methods.length ? req.methods : ['IB2014'];
    const method = methods[0];
    let layers = req.layers || [];
    let gwt_drill = req.gwt_drill, gwt_design = req.gwt_design;
    if (req.boreholes && req.boreholes.length) {
        layers = req.boreholes[0].layers || [];
        gwt_drill = req.boreholes[0].gwt_drill;
        gwt_design = req.boreholes[0].gwt_design;
    }
    if (!layers || !layers.length) return null;
    return {
        test_type: 'SPT',
        pga: req.pga,
        mw: req.mw,
        gwt_drill: gwt_drill,
        gwt_design: gwt_design,
        ce: 0.6,
        layers: layers,
        method: method,
        project_name: req.project_name || 'Liquefaction Analysis',
        unit_system: req.unit_system || 'imperial'
    };
}

async function fetchSptPlotAndShow() {
    const payload = buildSptPlotPayload();
    if (!payload) return;
    const container = document.getElementById('spt-plot-container');
    if (!container) return;
    try {
        const res = await fetch('/api/plot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.status === 'success' && data.image) {
            container.innerHTML = '<img src="' + data.image + '" alt="SPT Liquefaction Analysis" style="max-width:100%; height:auto; border:1px solid #ddd; border-radius:8px;" />';
        } else {
            container.innerHTML = '<div style="color:#b00020; font-size:12px;">Plot failed: ' + escapeHtml(data.message || 'Unknown error') + '</div>';
        }
    } catch (e) {
        container.innerHTML = '<div style="color:#b00020; font-size:12px;">Plot failed: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
}

// ==========================================
//  Modal
// ==========================================
function showAnalysisSummaryModal(results, metadata) {
    const modal = document.getElementById('analysisSummaryModal');
    const tableContainer = document.getElementById('summary-table-container');
    
    if (!modal || !tableContainer) return;

    // Parse FS robustly (avoid Number(null) => 0 bug)
    const parseFsValue = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const minFsFromRows = (rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const vals = rows
            .map(r => parseFsValue(r?.FS ?? r?.['FS']))
            .filter(v => v !== null);
        return vals.length > 0 ? Math.min(...vals) : null;
    };

    // ----------------------------------------------------------
    // Multi-borehole/tags summary (batch mode)
    // Backend returns: { results: { boreholes: [...] } }
    // ----------------------------------------------------------
    const boreholes = results && typeof results === 'object' && results.boreholes && Array.isArray(results.boreholes)
        ? results.boreholes
        : null;

    if (boreholes && boreholes.length > 0) {
        const testType = (metadata && metadata.test_type) ? String(metadata.test_type).toUpperCase() : '';
        const methods = (metadata && Array.isArray(metadata.methods) && metadata.methods.length > 0) ? metadata.methods : [];
        const hasMethods = methods.length > 0;

        const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '' : Number(v).toFixed(d);
        const statusCell = (minFs) => {
            if (minFs === null || minFs === undefined || Number.isNaN(minFs)) return '<span style="color:#64748b;">—</span>';
            const ok = Number(minFs) >= 1.0;
            const c = ok ? '#059669' : '#dc2626';
            return `<strong style="color:${c};">${ok ? 'OK' : 'NG'}</strong>`;
        };

        // Build compact summary table (one row per tag)
        let headerCols = `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: left;">Tag</th>`;
        headerCols += `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">GWL (Drill)</th>`;
        headerCols += `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">GWL (Design)</th>`;

        if (testType === 'SPT' && hasMethods) {
            for (const m of methods) {
                headerCols += `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Min FS<br>${m}</th>`;
            }
            headerCols += `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Status</th>`;
        } else {
            headerCols += `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Min FS</th>`;
            if (testType === 'CPT') headerCols += `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Settlement (m)</th>`;
            headerCols += `<th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Status</th>`;
        }

        let bodyRows = '';
        for (const bh of boreholes) {
            const tag = (bh && (bh.name || bh.id)) ? String(bh.name || bh.id) : 'Tag';
            const gD = (bh && bh.gwt_drill !== undefined) ? bh.gwt_drill : '';
            const gE = (bh && bh.gwt_design !== undefined) ? bh.gwt_design : '';

            bodyRows += `<tr>`;
            bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: left; font-weight: 700;">${escapeHtml(tag)}</td>`;
            bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${escapeHtml(String(gD))}</td>`;
            bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${escapeHtml(String(gE))}</td>`;

            if (testType === 'SPT' && hasMethods) {
                const mins = (bh && bh.min_fs_by_method && typeof bh.min_fs_by_method === 'object') ? bh.min_fs_by_method : {};
                const rbm = (bh && bh.results_by_method && typeof bh.results_by_method === 'object') ? bh.results_by_method : {};
                let worst = null;
                for (const m of methods) {
                    // Prefer backend summary, but recompute from rows when value is null/invalid
                    let minFs = parseFsValue(mins && mins[m]);
                    if (minFs === null) minFs = minFsFromRows(Array.isArray(rbm[m]) ? rbm[m] : []);
                    if (minFs !== null && !Number.isNaN(minFs)) {
                        worst = (worst === null) ? minFs : Math.min(worst, minFs);
                    }
                    bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">
                        <strong style="color:${minFs !== null && minFs < 1.0 ? '#dc2626' : (minFs !== null && minFs < 1.5 ? '#d97706' : '#059669')};">${minFs === null ? '—' : fmt(minFs, 2)}</strong>
                    </td>`;
                }
                bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${statusCell(worst)}</td>`;
            } else {
                // Avoid Number(null) => 0; fallback to recompute from detailed rows
                let minFs = parseFsValue(bh && bh.min_fs);
                if (minFs === null) minFs = minFsFromRows(Array.isArray(bh?.results) ? bh.results : []);
                bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">
                    <strong style="color:${minFs !== null && minFs < 1.0 ? '#dc2626' : (minFs !== null && minFs < 1.5 ? '#d97706' : '#059669')};">${minFs === null ? '—' : fmt(minFs, 2)}</strong>
                </td>`;
                if (testType === 'CPT') {
                    const sett = (bh && bh.metadata && bh.metadata.total_settlement_m !== undefined) ? bh.metadata.total_settlement_m : '';
                    bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${escapeHtml(String(sett))}</td>`;
                }
                bodyRows += `<td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${statusCell(minFs)}</td>`;
            }

            bodyRows += `</tr>`;
        }

        let summaryHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr>
                        ${headerCols}
                    </tr>
                </thead>
                <tbody>
                    ${bodyRows}
                </tbody>
            </table>
            <div class="liquefaction-params-box">
                <div style="margin: 4px 0;"><strong>Analysis Parameters</strong></div>
                <div style="margin: 4px 0;">• Test type: ${escapeHtml(testType || (metadata?.test_type || ''))}</div>
                <div style="margin: 4px 0;">• Mw: ${escapeHtml(String(metadata?.mw ?? ''))}</div>
                <div style="margin: 4px 0;">• PGA: ${escapeHtml(String(metadata?.pga ?? ''))} g</div>
                ${testType === 'SPT' && hasMethods ? `<div style="margin: 4px 0;">• Methods: ${escapeHtml(methods.join(', '))}</div>` : ``}
            </div>
        `;

        // Details: one collapsible block per tag, with full layer table(s)
        let detailsHTML = '';
        for (const bh of boreholes) {
            const tag = (bh && (bh.name || bh.id)) ? String(bh.name || bh.id) : 'Tag';
            const err = bh && bh.error ? String(bh.error) : '';
            if (err) {
                detailsHTML += `
                    <details style="margin-top: 10px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; background: #fff;">
                        <summary style="cursor: pointer; font-weight: 700;">${escapeHtml(tag)} (error)</summary>
                        <div style="margin-top: 8px; color: #dc2626; font-size: 12px;">${escapeHtml(err)}</div>
                    </details>
                `;
                continue;
            }

            let inner = '';
            if (testType === 'SPT' && hasMethods) {
                const rbm = (bh && bh.results_by_method && typeof bh.results_by_method === 'object') ? bh.results_by_method : {};
                for (const m of methods) {
                    const rows = Array.isArray(rbm[m]) ? rbm[m] : [];
                    inner += `<div style="margin-top: 10px; font-weight: 800; color:#333;">${escapeHtml(m)}</div>`;
                    inner += `<div style="overflow-x:auto; max-height: 280px; overflow-y:auto; border: 1px solid #e2e8f0; border-radius: 8px; margin-top: 6px;">
                        <table style="width:100%; border-collapse:collapse; font-size:12px;">
                            <thead>
                                <tr style="background:#f8fafc;">
                                    <th style="padding:6px; border:1px solid #e2e8f0; text-align:right;">Depth</th>
                                    <th style="padding:6px; border:1px solid #e2e8f0; text-align:right;">FS</th>
                                    <th style="padding:6px; border:1px solid #e2e8f0; text-align:center;">Liquefy</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows.map(r => {
                                    const d = r?.Depth ?? r?.depth ?? '';
                                    const fsVal = r?.FS ?? r?.['FS'];
                                    const liq = r?.Liquefy ?? '';
                                    const fsNum = (fsVal === null || fsVal === undefined) ? null : Number(fsVal);
                                    const ok = fsNum !== null && !Number.isNaN(fsNum);
                                    const c = !ok ? '#64748b' : (fsNum < 1.0 ? '#dc2626' : (fsNum < 1.5 ? '#d97706' : '#059669'));
                                    return `<tr>
                                        <td style="padding:6px; border:1px solid #e2e8f0; text-align:right;">${escapeHtml(String(d))}</td>
                                        <td style="padding:6px; border:1px solid #e2e8f0; text-align:right;"><strong style="color:${c};">${!ok ? '—' : fmt(fsNum, 2)}</strong></td>
                                        <td style="padding:6px; border:1px solid #e2e8f0; text-align:center;">${escapeHtml(String(liq))}</td>
                                    </tr>`;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>`;
                }
            } else if (testType === 'CPT') {
                const rows = Array.isArray(bh.results) ? bh.results : [];
                inner += `<div style="overflow-x:auto; max-height: 320px; overflow-y:auto; border: 1px solid #e2e8f0; border-radius: 8px; margin-top: 8px;">
                    <table style="width:100%; border-collapse:collapse; font-size:12px;">
                        <thead>
                            <tr style="background:#f8fafc;">
                                <th style="padding:6px; border:1px solid #e2e8f0; text-align:right;">Depth</th>
                                <th style="padding:6px; border:1px solid #e2e8f0; text-align:right;">CSR</th>
                                <th style="padding:6px; border:1px solid #e2e8f0; text-align:right;">CRR</th>
                                <th style="padding:6px; border:1px solid #e2e8f0; text-align:right;">FS</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(r => {
                                const d = r?.depth ?? r?.Depth ?? '';
                                const csr = r?.CSR ?? '';
                                const crr = r?.CRR ?? r?.CRR_7_5 ?? r?.['CRR_7.5'] ?? '';
                                const fsVal = r?.FS ?? r?.['FS'];
                                const fsNum = (fsVal === null || fsVal === undefined) ? null : Number(fsVal);
                                const ok = fsNum !== null && !Number.isNaN(fsNum);
                                const c = !ok ? '#64748b' : (fsNum < 1.0 ? '#dc2626' : (fsNum < 1.5 ? '#d97706' : '#059669'));
                                return `<tr>
                                    <td style="padding:6px; border:1px solid #e2e8f0; text-align:right;">${escapeHtml(String(d))}</td>
                                    <td style="padding:6px; border:1px solid #e2e8f0; text-align:right;">${escapeHtml(String(csr))}</td>
                                    <td style="padding:6px; border:1px solid #e2e8f0; text-align:right;">${escapeHtml(String(crr))}</td>
                                    <td style="padding:6px; border:1px solid #e2e8f0; text-align:right;"><strong style="color:${c};">${!ok ? '—' : fmt(fsNum, 2)}</strong></td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>`;
            }

            detailsHTML += `
                <details style="margin-top: 10px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; background: #fff;">
                    <summary style="cursor: pointer; font-weight: 700;">${escapeHtml(tag)} (details)</summary>
                    ${inner}
                </details>
            `;
        }

        const sptPlotPlaceholder = (testType === 'SPT') ? '<div id="spt-plot-container" style="margin-bottom:20px; text-align:center; min-height:80px; padding:12px; background:#f8f9fa; border-radius:8px; font-size:13px; color:#666;">Loading SPT analysis plot…</div>' : '';
        tableContainer.innerHTML = sptPlotPlaceholder + summaryHTML + detailsHTML;
        modal.style.display = 'flex';
        if (testType === 'SPT') fetchSptPlotAndShow();
        return;
    }
    
    // 
    const activeTab = document.querySelector('.borehole-tab[style*="background-color: rgb(74, 144, 226)"]') ||
                      document.querySelector('.borehole-tab');
    const currentBH = activeTab ? activeTab.textContent.trim() : 'BH-1';
    
    // 
    const isMultipleMethods = metadata.methods && Array.isArray(metadata.methods) && metadata.methods.length > 1;
    const methodDetails = metadata.method_details || {};
    
    let summaryHTML = '';
    
    if (isMultipleMethods && typeof results === 'object' && !Array.isArray(results)) {
        // ：， OK/NG
        summaryHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="background: #f8fafc; color: #334155;">
                        <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Hole No.</th>
                        <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Method</th>
                        <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Status</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        // 
        metadata.methods.forEach(methodCode => {
            const methodResults = results[methodCode] || [];
            const methodInfo = methodDetails[methodCode] || {};
            
            // Factor of Safety (FS) only; do not use r.fs (sleeve friction)
            const getFS = (r) => parseFsValue(r != null && (r['FS'] !== undefined && r['FS'] !== null) ? r['FS'] : r?.FS);
            const fsVals = methodResults.map(getFS).filter(v => v !== null);
            const minFS = fsVals.length > 0 ? Math.min(...fsVals) : null;
            const status = minFS === null ? '—' : (minFS >= 1.0 ? 'OK' : 'NG');
            const statusColor = minFS === null ? '#64748b' : (minFS >= 1.0 ? '#059669' : '#dc2626');
            
            // 
            const methodDisplayName = methodCode === 'IB2014' ? 'Idriss & Boulanger (2014)' : 
                                     methodCode === 'NCEER2001' ? 'NCEER (Youd et al., 2001)' : 
                                     methodInfo.method_short || methodCode;
            
            summaryHTML += `
                <tr>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center; font-weight: bold;">${currentBH}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${methodDisplayName}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">
                        <strong style="color: ${statusColor}; font-size: 14px;">${status}</strong>
                    </td>
                </tr>
            `;
        });
        
        summaryHTML += `
                </tbody>
            </table>
            
            <div class="liquefaction-params-box">
                <p style="margin: 5px 0;"><strong>Analysis Parameters:</strong></p>
                <p style="margin: 5px 0;">• Methods: ${metadata.methods.join(', ')}</p>
                <p style="margin: 5px 0;">• Earthquake Magnitude (Mw): ${metadata.mw}</p>
                <p style="margin: 5px 0;">• Design PGA: ${metadata.pga} g</p>
                <p style="margin: 5px 0;">• Groundwater Level: ${metadata.gwt} m</p>
            </div>
        `;
    } else {
        const resultsArray = Array.isArray(results) ? results : (results[metadata.methods?.[0]] || []);
        const getFS = (r) => parseFsValue(r != null && (r['FS'] !== undefined && r['FS'] !== null) ? r['FS'] : r?.FS);
        const fsVals = resultsArray.map(getFS).filter(v => v !== null);
        const minFS = fsVals.length > 0 ? Math.min(...fsVals) : null;
        const avgFS = fsVals.length > 0 ?
            (fsVals.reduce((sum, v) => sum + v, 0) / fsVals.length).toFixed(2) : '—';
        
        const methodDisplayName = metadata.method_short || metadata.method || 'Idriss & Boulanger (2014)';
        
        summaryHTML = `
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                <tr style="background: #f8fafc; color: white;">
                    <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Hole No.</th>
                    <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Code</th>
                    <th style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">Design Earthquake<br>(PGA = ${metadata.pga}g)</th>
                    </tr>
                </thead>
                <tbody>
                <tr>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center; font-weight: bold;" rowspan="2">${currentBH}</td>
                        <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${methodDisplayName}</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">
                        <strong style="color: ${minFS != null && minFS < 1.0 ? '#dc2626' : minFS != null && minFS < 1.5 ? '#d97706' : '#059669'};">
                            ${minFS != null ? Number(minFS).toFixed(2) : '—'}
                        </strong>
                        ${minFS != null ? (minFS < 1.0 ? '<span style="color: #dc2626;">~&lt;1.0</span>' : minFS < 1.5 ? '<span style="color: #d97706;">~&lt;1.5</span>' : '<span style="color: #059669;">~&gt;1.5</span>') : ''}
                    </td>
                </tr>
                <tr>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center; background-color: #f8fafc;">Average FS</td>
                    <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center; background-color: #f8fafc;">
                        <strong>${typeof avgFS === 'string' ? avgFS : '—'}</strong>
                    </td>
                </tr>
            </tbody>
        </table>
        
        <div class="liquefaction-params-box">
            <p style="margin: 5px 0;"><strong>Analysis Parameters:</strong></p>
                <p style="margin: 5px 0;">• Method: ${methodDisplayName}</p>
            <p style="margin: 5px 0;">• Earthquake Magnitude (Mw): ${metadata.mw}</p>
            <p style="margin: 5px 0;">• Design PGA: ${metadata.pga} g</p>
            <p style="margin: 5px 0;">• Groundwater Level: ${metadata.gwt} m</p>
                <p style="margin: 5px 0;">• Number of Layers Analyzed: ${resultsArray.length}</p>
        </div>
    `;
    }
    
    //  CPT ， tab （Summary / CPT Details）
    const hasCptDetails = window.cptIntermediate && window.cptIntermediate.rows && window.cptIntermediate.rows.length > 0;
    if (hasCptDetails) {
        const unitSystem = window.cptIntermediate.unitSystem || 'imperial';
        const lengthUnit = unitSystem === 'imperial' ? 'ft' : 'm';
        const stressUnit = unitSystem === 'imperial' ? 'tsf' : 'kPa';

        const rows = window.cptIntermediate.rows;
        const meta = window.cptIntermediateMeta || {};

        const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v)) ? '' : Number(v).toFixed(d);
        const fmt2 = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '' : Number(v).toFixed(2);

        let cptTable = `
            <div style="margin-bottom: 10px; font-size: 12px; color: var(--text-secondary);">
                <div><strong style="color: var(--text-primary);">Sounding:</strong> ${meta.soundingId || 'CPT'}</div>
                <div><strong style="color: var(--text-primary);">Net Area Ratio (a<sub>n</sub>):</strong> ${window.cptIntermediate.assumptions?.net_area_ratio ?? ''}</div>
                <div><strong style="color: var(--text-primary);">Gamma Method:</strong> ${meta.gamma_method || 'N/A'} (currently stress profile uses assumed γ<sub>t</sub> = ${window.cptIntermediate.assumptions?.gamma_assumed_kN_m3 ?? 18} kN/m³)</div>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;">
                <div><strong style="color: var(--text-primary);">Formulas</strong></div>
                <div style="margin-top: 6px; padding: 10px; border: 1px solid rgba(0,217,255,0.25); border-radius: 8px; background: rgba(26,31,58,0.35);">
                    \\[
                    q_t = q_c + (1-a_n)u_2
                    \\]
                    \\[
                    Q_t = \\frac{q_t-\\sigma_{v0}}{\\sigma'_{v0}}
                    \\]
                    \\[
                    F_r = 100\\cdot\\frac{f_s}{q_t-\\sigma_{v0}}
                    \\]
                    \\[
                    I_c = \\sqrt{(3.47-\\log_{10}Q_t)^2 + (1.22+\\log_{10}F_r)^2}
                    \\]
                </div>
            </div>
            <div style="overflow-x: auto; max-height: 380px; overflow-y: auto; border: 1px solid rgba(0,217,255,0.25); border-radius: 8px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                    <thead>
                        <tr style="background: linear-gradient(135deg, rgba(0,217,255,0.18) 0%, rgba(123,104,238,0.18) 100%); color: var(--primary-color);">
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">Depth (${lengthUnit})</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">qc (${stressUnit})</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">fs (${stressUnit})</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">u₂ (${stressUnit})</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">qt (${stressUnit})</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">σv0 (${stressUnit})</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">σ'v0 (${stressUnit})</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">Qt</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">Fr (%)</th>
                            <th style="padding: 8px; border: 1px solid rgba(0,217,255,0.25);">Ic</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        rows.forEach(r => {
            cptTable += `
                <tr>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt2(r.depth)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt2(r.qc)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt2(r.fs)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${r.u2 === null ? '' : fmt2(r.u2)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt2(r.qt)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt2(r.sigma_v0)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt2(r.sigma_v0_eff)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt(r.Qt, 3)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${fmt(r.Fr, 2)}</td>
                    <td style="padding: 6px; border: 1px solid rgba(0,217,255,0.18); text-align: right;">${r.Ic === null ? '' : fmt(r.Ic, 3)}</td>
                </tr>
            `;
        });

        cptTable += `
                    </tbody>
                </table>
            </div>
        `;

        tableContainer.innerHTML = `
            <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                <button id="summary-tab-btn-summary" data-active="1" type="button" onclick="switchSummaryModalTab('summary')"
                    style="padding: 6px 10px; border-radius: 10px; cursor: pointer; font-size: 12px; background: rgba(0, 217, 255, 0.25); border: 1px solid rgba(0, 217, 255, 0.5); color: var(--text-primary);">
                    Summary
                </button>
                <button id="summary-tab-btn-cpt" data-active="0" type="button" onclick="switchSummaryModalTab('cpt')"
                    style="padding: 6px 10px; border-radius: 10px; cursor: pointer; font-size: 12px; background: transparent; border: 1px solid rgba(0, 217, 255, 0.25); color: var(--text-secondary);">
                    CPT Details (qt, Qt, Fr, Ic)
                </button>
            </div>
            <div id="summary-tab-summary" style="display: block;">${summaryHTML}</div>
            <div id="summary-tab-cpt" style="display: none;">${cptTable}</div>
        `;

        //  MathJax  typeset（）
        try {
            if (window.MathJax && window.MathJax.typesetPromise) {
                window.MathJax.typesetPromise();
            }
        } catch (e) {
            console.warn('MathJax typeset failed:', e);
        }
    } else {
        const isSpt = window.liquefactionRequestData && (window.liquefactionRequestData.test_type || '').toUpperCase() === 'SPT';
        const sptPlotPlaceholder = isSpt ? '<div id="spt-plot-container" style="margin-bottom:20px; text-align:center; min-height:80px; padding:12px; background:#f8f9fa; border-radius:8px; font-size:13px; color:#666;">Loading SPT analysis plot…</div>' : '';
        tableContainer.innerHTML = sptPlotPlaceholder + summaryHTML;
        if (isSpt) fetchSptPlotAndShow();
    }
    
    //  modal
    modal.style.display = 'flex';
}

// ==========================================
//  Modal
// ==========================================
function closeAnalysisSummaryModal() {
    const modal = document.getElementById('analysisSummaryModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// ==========================================
//  DIGGS Info Modal (shared across DIGGS maps)
// ==========================================
function openDiggsInfoModal() {
    const modal = document.getElementById('diggsInfoModal');
    if (modal) modal.style.display = 'flex';
}

function closeDiggsInfoModal() {
    const modal = document.getElementById('diggsInfoModal');
    if (modal) modal.style.display = 'none';
}

// ==========================================
// （ Modal ）
// ==========================================
function downloadCalculationReport() {
    if (window.liquefactionRequestData) {
        downloadExcel();
    } else {
        alert('Please run analysis first');
    }
}

//  modal 
document.addEventListener('mousedown', function(event) {
    const modal = document.getElementById('analysisSummaryModal');
    if (modal && event.target === modal) {
        closeAnalysisSummaryModal();
    }

    const diggsInfoModal = document.getElementById('diggsInfoModal');
    if (diggsInfoModal && event.target === diggsInfoModal) {
        closeDiggsInfoModal();
    }
    
    const excavationModal = document.getElementById('excavationAnalysisModal');
    if (excavationModal && event.target === excavationModal) {
        closeExcavationAnalysisModal();
    }
    
    const supportedTagModal = document.getElementById('supportedTagAnalysisModal');
    if (supportedTagModal && event.target === supportedTagModal) {
        closeSupportedTagAnalysisModal();
    }

    const sfSummaryModal = document.getElementById('sf-analysis-summary-modal');
    if (sfSummaryModal && event.target === sfSummaryModal) {
        closeSfAnalysisSummaryModal();
    }

    const cptWorkflowModal = document.getElementById('cpt-workflow-modal');
    if (cptWorkflowModal && event.target === cptWorkflowModal) {
        closeCptWorkflowModal();
    }
});

// ==========================================
//  (Manual/DIGGS)
// ==========================================
function switchDrillingInputMode(mode) {
    const manualSection = document.getElementById('manual-input-section');
    const diggsSection = document.getElementById('diggs-selection-section');
    
    if (mode === 'manual') {
        // 
        if (manualSection) manualSection.style.display = 'block';
        if (diggsSection) diggsSection.style.display = 'none';
    } else if (mode === 'diggs') {
        //  DIGGS 
        if (manualSection) manualSection.style.display = 'none';
        if (diggsSection) diggsSection.style.display = 'block';
        
        //  borehole，
        updateDiggsSelectionDisplay();
        
        // 
        if (diggsSelected === null) {
            alert('Please select a borehole from the DIGGS XML Borehole Map above.');
        }
    }
}

// ==========================================
// Drilling data source tabs (DIGGS / Geosetta)
// ==========================================
function selectDrillingSource(sourceKey) {
    const diggsPanel = document.getElementById('source-panel-diggs');
    const geosettaPanel = document.getElementById('source-panel-geosetta');
    const tabDiggs = document.getElementById('source-tab-diggs');
    const tabGeosetta = document.getElementById('source-tab-geosetta');

    const isGeosetta = String(sourceKey || '').toLowerCase() === 'geosetta';
    if (diggsPanel) diggsPanel.style.display = isGeosetta ? 'none' : 'block';
    if (geosettaPanel) geosettaPanel.style.display = isGeosetta ? 'block' : 'none';

    if (tabDiggs) {
        tabDiggs.classList.toggle('active', !isGeosetta);
        tabDiggs.setAttribute('aria-selected', (!isGeosetta).toString());
    }
    if (tabGeosetta) {
        tabGeosetta.classList.toggle('active', isGeosetta);
        tabGeosetta.setAttribute('aria-selected', (isGeosetta).toString());
    }

    // When showing DIGGS panel, ensure Leaflet map sizes correctly.
    if (!isGeosetta) {
        try {
            if (diggsMap) {
                setTimeout(() => {
                    try { diggsMap.invalidateSize(); } catch (_) {}
                }, 50);
            } else {
                // If map not yet initialized, try to init.
                setTimeout(() => {
                    try { initDiggsMap(true); } catch (_) {}
                }, 100);
            }
        } catch (_) {}
    }

    // When showing Geosetta panel, init/invalidate its map.
    // Delay so the panel has time to become visible (avoids Leaflet init with zero-height container).
    if (isGeosetta) {
        setTimeout(() => {
            try {
                initGeosettaTabMap(true);
                if (geosettaTabMap) {
                    geosettaTabMap.invalidateSize();
                    geosettaTabMap.fire('moveend');  // trigger initial fetch
                }
                scheduleGeosettaViewportFetch(100);
            } catch (e) {
                console.error('[Geosetta] map init failed:', e);
            }
        }, 150);
    }
}

function initGeosettaTabMap(force = false) {
    if (typeof L === 'undefined') return;
    const container = document.getElementById('geosetta-map-container');
    if (!container) return;

    // Make sure it has size
    if (container.style.display === 'none') container.style.display = 'block';
    if (container.offsetHeight === 0) container.style.height = '420px';

    if (geosettaTabMap) {
        if (force) {
            try { geosettaTabMap.invalidateSize(); } catch (_) {}
        }
        return;
    }

    geosettaTabMap = L.map('geosetta-map-container', {
        zoomAnimation: true,
        markerZoomAnimation: false,
        fadeAnimation: true,
        zoomControl: true,
        attributionControl: true,
        preferCanvas: true
    }).setView([39.5, -95.5], 4);  // Continental US: center Kansas, zoom 4

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 20,
        minZoom: 1,
        subdomains: ['a', 'b', 'c', 'd']
    }).addTo(geosettaTabMap);

    geosettaTabMarkers = L.layerGroup().addTo(geosettaTabMap);

    // Auto-fetch points when browsing (like Geosetta). Throttle to avoid spamming.
    geosettaTabMap.on('moveend', () => {
        try { scheduleGeosettaViewportFetch(250); } catch (_) {}
    });
    geosettaTabMap.on('zoomend', () => {
        // Refetch only; do NOT call renderGeosettaTabMarkers here (it would clear DB clusters).
        try { scheduleGeosettaViewportFetch(300); } catch (_) {}
    });

    // Friendly UX: clicking the map updates the center inputs.
    geosettaTabMap.on('click', (e) => {
        try {
            const latEl = document.getElementById('geosetta-lat');
            const lonEl = document.getElementById('geosetta-lon');
            if (latEl) latEl.value = Number(e.latlng.lat).toFixed(6);
            if (lonEl) lonEl.value = Number(e.latlng.lng).toFixed(6);
        } catch (_) {}
    });
}

function _geosettaGridSizeDeg(zoom) {
    const z = Number(zoom);
    if (!isFinite(z)) return 0.05;
    if (z <= 1) return 5.0;   // whole continent: very coarse
    if (z <= 2) return 3.0;
    if (z <= 3) return 2.0;
    if (z <= 4) return 1.5;   // full US view
    if (z <= 5) return 1.0;
    if (z <= 6) return 0.5;
    if (z <= 8) return 0.25;
    if (z <= 9) return 0.20;
    if (z === 10) return 0.10;
    if (z === 11) return 0.05;
    if (z === 12) return 0.02;
    if (z === 13) return 0.01;
    return 0; // show exact markers
}

function renderGeosettaTabMarkers(items, center = null, opts = {}) {
    initGeosettaTabMap(true);
    if (!geosettaTabMap || !geosettaTabMarkers) return;

    try { geosettaTabMarkers.clearLayers(); } catch (_) {}

    // Center marker (query point)
    if (center && isFinite(center.lat) && isFinite(center.lon)) {
        try { if (geosettaTabCenterMarker) geosettaTabCenterMarker.remove(); } catch (_) {}
        geosettaTabCenterMarker = L.circleMarker([center.lat, center.lon], {
            radius: 7,
            color: '#00d9ff',
            weight: 2,
            fillColor: '#00d9ff',
            fillOpacity: 0.20
        }).addTo(geosettaTabMap);
        geosettaTabCenterMarker.bindPopup(`<strong>Query center</strong><br>${center.lat.toFixed(6)}, ${center.lon.toFixed(6)}`);
    }

    const pts = (items || []).filter(it => it && isFinite(it.lat) && isFinite(it.lon));
    const zoom = geosettaTabMap.getZoom();
    const grid = _geosettaGridSizeDeg(zoom);
    // Merge threshold to avoid overlapping bubbles at large scale
    const mergeDeg = _geosettaMergeDegFromZoom(zoom);
    const effectiveGrid = grid > 0 ? Math.max(grid, mergeDeg) : 0;
    // Cluster whenever grid > 0 to mimic Geosetta's "counts when zoomed out" behavior.
    const shouldCluster = effectiveGrid > 0 && pts.length > 0;

    const bounds = [];

    if (!shouldCluster) {
        pts.forEach(it => {
            bounds.push([it.lat, it.lon]);
            const depthTxt = (it.depth_ft !== null && isFinite(it.depth_ft)) ? `${it.depth_ft} ft` : '—';
            const providerTxt = it.provider ? it.provider : 'Unknown provider';
            const importBtnId = `geo-import-spt-${Math.floor(Math.random() * 1e9)}`;

            const m = L.circleMarker([it.lat, it.lon], {
                radius: 6,
                color: 'rgba(255,193,7,0.95)',
                weight: 2,
                fillColor: 'rgba(255,193,7,0.65)',
                fillOpacity: 0.35
            });
            m.bindPopup(`
                <div style="font-size:12px; line-height:1.35;">
                    <div style="font-weight:800; margin-bottom:4px;">${escapeHtml(it.title || 'Borehole')}</div>
                    <div>${escapeHtml(providerTxt)} • Depth: ${escapeHtml(depthTxt)}</div>
                    <div style="opacity:0.85;">${escapeHtml(it.lat.toFixed(6))}, ${escapeHtml(it.lon.toFixed(6))}</div>
                    <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
                        <button id="${importBtnId}" type="button" style="padding:6px 10px; border-radius:10px; border:1px solid rgba(0,217,255,0.35); background: rgba(0,217,255,0.10); cursor:pointer; font-weight:900;">
                            Import (Predicted SPT)
                        </button>
                    </div>
                    <div style="margin-top:8px; color:#888; font-size:11px;">
                        Note: Geosetta historic borehole DIGGS download is not available via API; this imports SPT prediction profile.
                    </div>
                </div>
            `);
            m.on('popupopen', (evt) => {
                try {
                    const el = document.getElementById(importBtnId);
                    if (!el) return;
                    el.addEventListener('click', () => geosettaImportPredictedSpt(it));
                } catch (_) {}
            });
            geosettaTabMarkers.addLayer(m);
        });
    } else {
        // Grid clusters (no external libs); use effectiveGrid to avoid overlapping bubbles
        const buckets = new Map();
        pts.forEach(it => {
            const kLat = Math.floor(it.lat / effectiveGrid);
            const kLon = Math.floor(it.lon / effectiveGrid);
            const key = `${kLat}:${kLon}`;
            const b = buckets.get(key) || { count: 0, latSum: 0, lonSum: 0, samples: [], first: null };
            b.count += 1;
            b.latSum += it.lat;
            b.lonSum += it.lon;
            if (b.samples.length < 5) b.samples.push(it.title || 'Borehole');
            if (!b.first) b.first = it;
            buckets.set(key, b);
        });

        buckets.forEach((b) => {
            const clat = b.latSum / b.count;
            const clon = b.lonSum / b.count;
            bounds.push([clat, clon]);

            if (b.count === 1 && b.first) {
                const it = b.first;
                const depthTxt = (it.depth_ft !== null && isFinite(it.depth_ft)) ? `${it.depth_ft} ft` : '—';
                const providerTxt = it.provider ? it.provider : 'Unknown provider';
                const importBtnId = `geo-import-spt-${Math.floor(Math.random() * 1e9)}`;

                const m1 = L.circleMarker([it.lat, it.lon], {
                    radius: 6,
                    color: 'rgba(255,193,7,0.95)',
                    weight: 2,
                    fillColor: 'rgba(255,193,7,0.65)',
                    fillOpacity: 0.35
                });
                m1.bindPopup(`
                    <div style="font-size:12px; line-height:1.35;">
                        <div style="font-weight:800; margin-bottom:4px;">${escapeHtml(it.title || 'Borehole')}</div>
                        <div>${escapeHtml(providerTxt)} • Depth: ${escapeHtml(depthTxt)}</div>
                        <div style="opacity:0.85;">${escapeHtml(it.lat.toFixed(6))}, ${escapeHtml(it.lon.toFixed(6))}</div>
                        <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
                            <button id="${importBtnId}" type="button" style="padding:6px 10px; border-radius:10px; border:1px solid rgba(0,217,255,0.35); background: rgba(0,217,255,0.10); cursor:pointer; font-weight:900;">
                                Import (Predicted SPT)
                            </button>
                        </div>
                    </div>
                `);
                m1.on('popupopen', () => {
                    try {
                        const el = document.getElementById(importBtnId);
                        if (!el) return;
                        el.addEventListener('click', () => geosettaImportPredictedSpt(it));
                    } catch (_) {}
                });
                geosettaTabMarkers.addLayer(m1);
                return;
            }

            const icon = L.divIcon({
                className: 'geosetta-cluster',
                html: `<div>${b.count}</div>`,
                iconSize: [34, 34],
                iconAnchor: [17, 17]
            });
            const m = L.marker([clat, clon], { icon });
            const sampleList = b.samples.map(s => `<div>• ${escapeHtml(String(s))}</div>`).join('');
            m.bindPopup(`
                <div style="font-size:12px; line-height:1.35;">
                    <div style="font-weight:900; margin-bottom:6px;">${b.count} boreholes</div>
                    <div style="color:#444; margin-bottom:6px;">Zoom in to see exact locations. (Tip: click the cluster to zoom.)</div>
                    ${sampleList}
                </div>
            `);
            // CSP-safe zoom interaction
            m.on('click', () => {
                try {
                    const nextZ = Math.min((geosettaTabMap.getZoom() || 11) + 2, 16);
                    geosettaTabMap.setView([clat, clon], nextZ);
                } catch (_) {}
            });
            geosettaTabMarkers.addLayer(m);
        });
    }

    if (!opts.skipFit) {
        if (bounds.length) {
            try {
                const b = L.latLngBounds(bounds);
                geosettaTabMap.fitBounds(b.pad(0.15));
            } catch (_) {}
        } else if (center && isFinite(center.lat) && isFinite(center.lon)) {
            geosettaTabMap.setView([center.lat, center.lon], 12);
        }
    }
}

function _geosettaBoreholeId(it) {
    const lat = isFinite(it?.lat) ? Number(it.lat).toFixed(6) : 'na';
    const lon = isFinite(it?.lon) ? Number(it.lon).toFixed(6) : 'na';
    return `geosetta_${lat}_${lon}`;
}

async function geosettaImportPredictedSpt(it) {
    try {
        if (!it || !isFinite(it.lat) || !isFinite(it.lon)) {
            alert('Invalid Geosetta point.');
            return;
        }
        const depthFt = (it.depth_ft !== null && isFinite(it.depth_ft)) ? Number(it.depth_ft) : 50;
        const cappedDepth = Math.min(100, Math.max(1, depthFt));
        setGeosettaStatus('Importing predicted SPT profile…', 'info');

        const resp = await fetch('/api/geosetta/predict_spt_table', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude: it.lat, longitude: it.lon, depth_ft: cappedDepth })
        });
        const data = await resp.json();
        if (!resp.ok || !data || data.status !== 'success') {
            const msg = (data && (data.message || data.details)) ? (data.message || JSON.stringify(data.details)) : `HTTP ${resp.status}`;
            setGeosettaStatus(`Import failed: ${msg}`, 'error');
            alert('Import failed: ' + msg);
            return;
        }

        const tests = data?.data?.tests;
        if (!Array.isArray(tests) || tests.length === 0) {
            setGeosettaStatus('Import failed: empty SPT rows.', 'error');
            alert('Import failed: empty SPT rows.');
            return;
        }

        const boreholeId = _geosettaBoreholeId(it);
        const providerTxt = it.provider ? it.provider : 'Geosetta';
        const boreholeName = `${providerTxt} (${Number(it.lat).toFixed(5)}, ${Number(it.lon).toFixed(5)})`;
        importSPTDataBatch(tests, boreholeId, boreholeName, null);
        setGeosettaStatus(`Imported ${tests.length} SPT row(s) (predicted).`, 'success');
    } catch (e) {
        console.error('[Geosetta] import predicted SPT failed:', e);
        setGeosettaStatus(`Import failed: ${e?.message || String(e)}`, 'error');
        alert('Import failed: ' + (e?.message || String(e)));
    }
}

function scheduleGeosettaViewportFetch(delayMs = 250) {
    if (geosettaTabFetchTimer) clearTimeout(geosettaTabFetchTimer);
    geosettaTabFetchTimer = setTimeout(() => {
        try { fetchGeosettaForViewport(); } catch (_) {}
    }, delayMs);
}

async function fetchGeosettaForViewport() {
    if (!geosettaTabMap) return;
    // Only auto-fetch when Geosetta panel is visible
    const panel = document.getElementById('source-panel-geosetta');
    if (!panel || panel.style.display === 'none') return;

    const z = geosettaTabMap.getZoom();

    // Prefer local DB (viewport-based) if it exists.
    const dbStatus = await ensureGeosettaDbStatus(false);
    const useDb = dbStatus.exists && (dbStatus.boreholes > 0);

    // Only block low zoom when using radius API (50km limit); DB supports clusters at any zoom
    if (!useDb && z < 5) {
        setGeosettaStatus('Zoom in to browse boreholes.', 'info');
        return;
    }

    const bounds = geosettaTabMap.getBounds();
    const center = bounds.getCenter();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    const fetchKey = useDb
        ? `db:${sw.lat.toFixed(4)},${sw.lng.toFixed(4)}:${ne.lat.toFixed(4)},${ne.lng.toFixed(4)}:${z}`
        : `${center.lat.toFixed(5)},${center.lng.toFixed(5)}:${Math.round(center.distanceTo(ne))}:${z}`;
    if (fetchKey === geosettaTabLastFetchKey) return;
    if (geosettaTabFetchInFlight) return;
    geosettaTabLastFetchKey = fetchKey;

    // Keep inputs in sync with map center (nice UX)
    const latEl = document.getElementById('geosetta-lat');
    const lonEl = document.getElementById('geosetta-lon');
    const radEl = document.getElementById('geosetta-radius');
    if (latEl) latEl.value = center.lat.toFixed(6);
    if (lonEl) lonEl.value = center.lng.toFixed(6);

    try {
        geosettaTabFetchInFlight = true;
        if (useDb) {
            // At lower zoom, request server-side clusters; at higher zoom, request exact points.
            const gridDeg = _geosettaGridSizeDeg(z);

            if (gridDeg > 0) {
                const resp = await fetch('/api/geosetta/db/clusters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        min_lat: sw.lat,
                        min_lon: sw.lng,
                        max_lat: ne.lat,
                        max_lon: ne.lng,
                        grid_deg: gridDeg,
                        limit: 5000
                    })
                });
                const data = await resp.json();
                if (!resp.ok || !data || data.status !== 'success') {
                    const msg = (data && (data.message || data.details)) ? (data.message || JSON.stringify(data.details)) : `HTTP ${resp.status}`;
                    setGeosettaStatus(`Geosetta DB query failed: ${msg}`, 'error');
                    return;
                }
                const clusters = data?.data?.clusters || [];
                setGeosettaStatus(`Boreholes in view (clustered): ${clusters.length} bubble(s).`, 'success');
                renderGeosettaDbClusters(clusters);
                return;
            } else {
                const resp = await fetch('/api/geosetta/db/points', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        min_lat: sw.lat,
                        min_lon: sw.lng,
                        max_lat: ne.lat,
                        max_lon: ne.lng,
                        limit: 20000
                    })
                });
                const data = await resp.json();
                if (!resp.ok || !data || data.status !== 'success') {
                    const msg = (data && (data.message || data.details)) ? (data.message || JSON.stringify(data.details)) : `HTTP ${resp.status}`;
                    setGeosettaStatus(`Geosetta DB query failed: ${msg}`, 'error');
                    return;
                }
                const points = data?.data?.points || [];
                const items = points.map((p) => {
                    const provider = p.provider || '';
                    const depth_ft = (p.depth_ft !== null && p.depth_ft !== undefined) ? Number(p.depth_ft) : null;
                    const title = provider ? `${provider}` : `Borehole ${p.id}`;
                    return {
                        title,
                        lat: Number(p.lat),
                        lon: Number(p.lon),
                        provider,
                        depth_ft,
                        diggs_url: ''
                    };
                }).filter(it => isFinite(it.lat) && isFinite(it.lon));
                geosettaTabItems = items;
                setGeosettaStatus(`Boreholes in view: ${items.length} point(s).`, 'success');
                renderGeosettaTabMarkers(items, null, { skipFit: true });
                return;
            }
        }

        // Fallback: direct Geosetta radius query (limited to 50km)
        const ne2 = bounds.getNorthEast();
        let radius_m = Math.round(center.distanceTo(ne2));
        radius_m = Math.min(50000, Math.max(500, radius_m));
        if (radEl) radEl.value = String(radius_m);

        const resp = await fetch('/api/geosetta/points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude: center.lat, longitude: center.lng, radius_m })
        });
        const data = await resp.json();
        if (!resp.ok || !data || data.status !== 'success') {
            const msg = (data && (data.message || data.details)) ? (data.message || JSON.stringify(data.details)) : `HTTP ${resp.status}`;
            setGeosettaStatus(`Geosetta query failed: ${msg}`, 'error');
            return;
        }
        const fc = data && data.data && data.data.geojson ? data.data.geojson : null;
        const features = fc && Array.isArray(fc.features) ? fc.features : [];
        const items = features
            .filter(f => f && f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates))
            .map((f, idx) => {
                const coords = f.geometry.coordinates; // [lon, lat]
                const props = f.properties || {};
                const title = String(props.title || `Borehole ${idx + 1}`);
                const content = props.content || '';
                const diggsUrl = extractDiggsUrlFromGeosettaContent(content);
                const meta = extractProviderAndDepthFromContent(content);
                return {
                    title,
                    lon: coords[0],
                    lat: coords[1],
                    provider: meta.provider,
                    depth_ft: meta.depth_ft,
                    diggs_url: diggsUrl,
                };
            });

        geosettaTabItems = items;
        setGeosettaStatus(`Loaded ${items.length} point(s) from Geosetta (radius-limited).`, 'success');
        renderGeosettaTabMarkers(items, { lat: center.lat, lon: center.lng }, { skipFit: true });
    } catch (e) {
        console.error('[Geosetta] viewport query failed:', e);
        setGeosettaStatus(`Geosetta query failed: ${e?.message || String(e)}`, 'error');
    } finally {
        geosettaTabFetchInFlight = false;
    }
}

// (setGeosettaStatus is defined later in the file)

function extractDiggsUrlFromGeosettaContent(contentHtml) {
    const s = String(contentHtml || '');
    // Prefer absolute https links
    const m1 = s.match(/https:\/\/geosetta\.org\/web_map\/DIGGS\/[0-9.\-]+;[0-9.\-]+/i);
    if (m1 && m1[0]) return m1[0];
    // Fallback: relative rslog link (not ideal, but provides something)
    const m2 = s.match(/href="(\/web_map\/rslog\/[^"]+)"/i);
    if (m2 && m2[1]) return `https://geosetta.org${m2[1]}`;
    return '';
}

function extractProviderAndDepthFromContent(contentHtml) {
    const s = String(contentHtml || '');
    const provider = (s.match(/Source:\s*([^<\n]+)/i) || [])[1];
    const depth = (s.match(/Total Depth:\s*([0-9.]+)\s*ft/i) || [])[1];
    return {
        provider: provider ? provider.trim() : '',
        depth_ft: depth ? Number(depth) : null
    };
}

async function geosettaSearchByAddress() {
    const addressInput = document.getElementById('geosetta-address');
    const address = addressInput ? (addressInput.value || '').trim() : '';
    if (!address) {
        setGeosettaStatus('Please enter an address to search.', 'error');
        return;
    }

    const btn = document.getElementById('geosetta-address-search-btn');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = 'Searching…';
    }
    setGeosettaStatus('Geocoding address…', 'info');

    try {
        const resp = await fetch('/api/geocode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address })
        });
        const data = await resp.json();

        if (data.status !== 'success' || !data.data) {
            const msg = (data && data.message) ? data.message : 'Address not found.';
            setGeosettaStatus(msg, 'error');
            return;
        }

        const { latitude, longitude, display_name } = data.data;
        const latEl = document.getElementById('geosetta-lat');
        const lonEl = document.getElementById('geosetta-lon');
        if (latEl) latEl.value = latitude.toFixed(6);
        if (lonEl) lonEl.value = longitude.toFixed(6);

        initGeosettaTabMap(true);
        if (geosettaTabMap) {
            geosettaTabMap.setView([latitude, longitude], 13);
            geosettaTabLastFetchKey = ''; // force refetch
            scheduleGeosettaViewportFetch(100);
        }

        setGeosettaStatus(`Found: ${display_name || address}`, 'success');
    } catch (err) {
        console.error('Geosetta address search error:', err);
        setGeosettaStatus('Address search failed. Please check your connection.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

async function geosettaSearchHistoricInRadius() {
    const latEl = document.getElementById('geosetta-lat');
    const lonEl = document.getElementById('geosetta-lon');
    const radEl = document.getElementById('geosetta-radius');
    const listEl = document.getElementById('geosetta-results-list');
    const resultsWrap = document.getElementById('geosetta-results');
    const mapWrap = document.getElementById('geosetta-map-container');

    const lat = latEl ? parseFloat(latEl.value) : NaN;
    const lon = lonEl ? parseFloat(lonEl.value) : NaN;
    const radius_m = radEl ? parseFloat(radEl.value) : 1000;

    if (!isFinite(lat) || !isFinite(lon)) {
        setGeosettaStatus('Please enter valid latitude and longitude.', 'error');
        return;
    }
    if (!isFinite(radius_m) || radius_m <= 0) {
        setGeosettaStatus('Please enter a valid radius (m).', 'error');
        return;
    }

    setGeosettaStatus('Querying Geosetta…', 'info');
    if (listEl) listEl.innerHTML = '';
    if (resultsWrap) resultsWrap.style.display = 'none';
    if (mapWrap) mapWrap.style.display = 'block';

    try {
        const resp = await fetch('/api/geosetta/points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude: lat, longitude: lon, radius_m })
        });
        const data = await resp.json();
        if (!resp.ok || !data || data.status !== 'success') {
            const msg = (data && (data.message || data.details)) ? (data.message || JSON.stringify(data.details)) : `HTTP ${resp.status}`;
            setGeosettaStatus(`Geosetta query failed: ${msg}`, 'error');
            return;
        }

        // Our backend proxy returns: { status:'success', data: { geojson: FeatureCollection, ... } }
        const fc = data && data.data && data.data.geojson ? data.data.geojson : null;
        const features = fc && Array.isArray(fc.features) ? fc.features : [];
        if (!features.length) {
            setGeosettaStatus('No boreholes found in radius.', 'warning');
            return;
        }

        setGeosettaStatus(`Found ${features.length} point(s).`, 'success');
        if (resultsWrap) resultsWrap.style.display = 'block';

        const items = features
            .filter(f => f && f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates))
            .map((f, idx) => {
                const coords = f.geometry.coordinates; // [lon, lat]
                const props = f.properties || {};
                const title = String(props.title || `Borehole ${idx + 1}`);
                const content = props.content || '';
                const diggsUrl = extractDiggsUrlFromGeosettaContent(content);
                const meta = extractProviderAndDepthFromContent(content);
                return {
                    title,
                    lon: coords[0],
                    lat: coords[1],
                    provider: meta.provider,
                    depth_ft: meta.depth_ft,
                    diggs_url: diggsUrl,
                };
            });

        // Map markers (like DIGGS map)
        renderGeosettaTabMarkers(items, { lat, lon });

        // Render list
        if (listEl) {
            listEl.innerHTML = '';
            items.forEach(it => {
                const div = document.createElement('div');
                div.className = 'geosetta-result-item';
                const depthTxt = (it.depth_ft !== null && isFinite(it.depth_ft)) ? `${it.depth_ft} ft` : '—';
                const providerTxt = it.provider ? it.provider : 'Unknown provider';
                div.innerHTML = `
                    <div class="geosetta-result-meta">
                        <div class="geosetta-result-title">${escapeHtml(it.title)}</div>
                        <div class="geosetta-result-sub">${escapeHtml(providerTxt)} • Depth: ${escapeHtml(depthTxt)} • (${escapeHtml(String(it.lat.toFixed(6)))}, ${escapeHtml(String(it.lon.toFixed(6)))})</div>
                    </div>
                    <div class="geosetta-result-actions">
                        <button type="button" class="geosetta-link-btn" title="Import predicted SPT profile to table">Import (Predicted SPT)</button>
                    </div>
                `;
                const btn = div.querySelector('button');
                if (btn) btn.addEventListener('click', () => geosettaImportPredictedSpt(it));
                listEl.appendChild(div);
            });
        }
    } catch (e) {
        console.error('[Geosetta] query failed:', e);
        setGeosettaStatus(`Geosetta query failed: ${e?.message || String(e)}`, 'error');
    }
}

//  DIGGS 
function updateDiggsSelectionDisplay() {
    const selectedBoreholeEl = document.getElementById('diggs-selected-borehole');
    const testTypeSelect = document.getElementById('diggs-import-test-type');
    const testIdSelect = document.getElementById('diggs-import-test-id');
    
    if (diggsSelected) {
        // diggsSelected  summary ， key
        const summary = diggsSelected;
        const boreholeName = summary.title || summary.id || 'Unknown';
        
        if (selectedBoreholeEl) {
            selectedBoreholeEl.textContent = boreholeName;
            selectedBoreholeEl.style.color = '#333';
            selectedBoreholeEl.style.fontStyle = 'normal';
        }
        
        // 
        if (testTypeSelect) {
            testTypeSelect.innerHTML = '<option value="">Select test type</option>';
            const sptCount = Number(summary.spt_count || 0);
            const cptCount = Number(summary.cpt_count || 0);
            
            if (sptCount > 0) {
                testTypeSelect.innerHTML += '<option value="SPT">SPT</option>';
            }
            if (cptCount > 0) {
                testTypeSelect.innerHTML += '<option value="CPT">CPT</option>';
            }
        }
        
        //  ID （）
        updateDiggsTestIdDropdown();
    } else {
        if (selectedBoreholeEl) {
            selectedBoreholeEl.textContent = 'None selected';
            selectedBoreholeEl.style.color = '#666';
            selectedBoreholeEl.style.fontStyle = 'italic';
        }
        if (testTypeSelect) {
            testTypeSelect.innerHTML = '<option value="">Select test type</option>';
        }
        if (testIdSelect) {
            testIdSelect.innerHTML = '<option value="">Select a test</option>';
        }
    }
}

// ， ID 
function updateDiggsTestIdDropdown() {
    const testTypeSelect = document.getElementById('diggs-import-test-type');
    const testIdSelect = document.getElementById('diggs-import-test-id');
    
    if (!testTypeSelect || !testIdSelect || !diggsSelected) return;
    
    const testType = testTypeSelect.value;
    if (!testType) {
        testIdSelect.innerHTML = '<option value="">Select a test</option>';
        return;
    }
    
    // diggsSelected  summary 
    const summary = diggsSelected;
    const featureId = summary.id;
    if (!featureId) return;
    
    //  summary （）
    const summaryTests = testType === 'SPT' ? (summary.spt_samples || []) : (summary.cpt_tests || []);
    
    if (summaryTests.length > 0) {
        testIdSelect.innerHTML = '<option value="">Select a test</option>';
        summaryTests.forEach((testId) => {
            if (testId) {
                testIdSelect.innerHTML += `<option value="${escapeHtml(String(testId))}">${escapeHtml(String(testId))}</option>`;
            }
        });
    } else {
        //  summary ， detail cache  API 
        const xmlFile = 'DIGGS_Student_Hackathon_large.XML';
        const cacheKey = `${xmlFile}::${featureId}`;
        
        if (diggsDetailCache[cacheKey]) {
            const detail = diggsDetailCache[cacheKey];
            const tests = testType === 'SPT' ? (detail.all_spt_tests || []) : (detail.all_cpt_tests || []);
            
            testIdSelect.innerHTML = '<option value="">Select a test</option>';
            tests.forEach((test, idx) => {
                const testId = test.test_id || test.activity_id || test.id || (typeof test === 'string' ? test : `Test ${idx + 1}`);
                const testName = test.name || testId;
                testIdSelect.innerHTML += `<option value="${escapeHtml(String(testId))}">${escapeHtml(String(testName))}</option>`;
            });
        } else {
            //  cache， detail
            fetchDiggsBoreholeDetail(featureId, xmlFile).then(detail => {
                const tests = testType === 'SPT' ? (detail.all_spt_tests || []) : (detail.all_cpt_tests || []);
                
                testIdSelect.innerHTML = '<option value="">Select a test</option>';
                tests.forEach((test, idx) => {
                    const testId = test.test_id || test.activity_id || test.id || (typeof test === 'string' ? test : `Test ${idx + 1}`);
                    const testName = test.name || testId;
                    testIdSelect.innerHTML += `<option value="${escapeHtml(String(testId))}">${escapeHtml(String(testName))}</option>`;
                });
            }).catch(err => {
                console.error('[DIGGS] Error loading test list:', err);
                testIdSelect.innerHTML = '<option value="">Error loading tests</option>';
            });
        }
    }
}

//  DIGGS 
function importDiggsData() {
    const testTypeSelect = document.getElementById('diggs-import-test-type');
    const testIdSelect = document.getElementById('diggs-import-test-id');
    
    if (!testTypeSelect || !testIdSelect || !diggsSelected) {
        alert('Please select a borehole from the map first.');
        return;
    }
    
    const testType = testTypeSelect.value;
    const testId = testIdSelect.value;
    
    if (!testType || !testId) {
        alert('Please select both test type and test ID.');
        return;
    }
    
    const xmlFile = 'DIGGS_Student_Hackathon_large.XML';
    
    //  API 
    fetch('/api/diggs/test_data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            xml_file: xmlFile,
            test_type: testType.toLowerCase(),
            test_id: testId
        })
    })
    .then(resp => resp.json())
    .then(data => {
        if (data.status !== 'success' || !data.data) {
            throw new Error(data.message || 'Failed to load test data');
        }
        
        const testData = data.data;
        
        // 
        if (testType === 'SPT') {
            importSPTData(testData);
        } else if (testType === 'CPT') {
            importCPTData(testData);
        }
        
        // （）
        // switchDrillingInputMode('manual');
        
        alert('Data imported successfully!');
    })
    .catch(err => {
        console.error('[DIGGS] Error importing data:', err);
        alert('Failed to import data: ' + (err.message || String(err)));
    });
}

//  SPT borehole tab
function findOrCreateBoreholeTab(boreholeId, boreholeName, testType) {
    //  boreholeId， BH-1
    if (!boreholeId) {
        const numHolesSelect = document.getElementById('num-holes-select');
        if (!numHolesSelect || parseInt(numHolesSelect.value) < 1) {
            if (numHolesSelect) numHolesSelect.value = '1';
            generateBoreholeTables();
        }
        // Ensure SPT table exists (e.g. when Liquefaction page was hidden at load)
        if (!document.getElementById('spt-table-body-BH-1')) {
            generateBoreholeTables();
        }
        return 'BH-1';
    }
    
    //  tab ID（ boreholeId）
    const safeId = String(boreholeId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const bhId = `BH-${safeId}`;
    
    //  tab 
    const existingTab = document.getElementById(`tab-${bhId}`);
    if (existingTab) {
        return bhId;
    }
    
    // ， tab
    const numHolesSelect = document.getElementById('num-holes-select');
    const tabsContainer = document.getElementById('borehole-tabs');
    const contentContainer = document.getElementById('dynamic-borehole-container');
    
    if (!numHolesSelect || !tabsContainer || !contentContainer) {
        // ，
        if (numHolesSelect) numHolesSelect.value = '1';
        generateBoreholeTables();
        return 'BH-1';
    }

    // Make sure the "+" add-tab button exists (DIGGS import may skip regeneration).
    try { ensureSptAddTabButtonExists(); } catch (_) {}
    
    //  borehole 
    const currentCount = parseInt(numHolesSelect.value) || 0;
    numHolesSelect.value = currentCount + 1;
    
    //  tab （ × ， CPT ）
    const tab = document.createElement('div');
    tab.className = 'borehole-tab';
    tab.id = `tab-${bhId}`;
    tab.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 20px;
        cursor: pointer;
        border: 1px solid rgba(0, 217, 255, 0.22);
        border-bottom: none;
        background-color: var(--card-bg);
        color: var(--text-secondary);
        border-radius: 5px 5px 0 0;
        font-weight: normal;
        transition: all 0.3s;
    `;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = boreholeName || bhId;
    labelSpan.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', `Remove ${bhId}`);
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
        background: transparent; border: none; color: inherit; cursor: pointer;
        font-size: 16px; line-height: 1; padding: 0 2px; opacity: 0.85;
    `;
    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeBoreholeTab(bhId);
    });
    tab.appendChild(labelSpan);
    tab.appendChild(closeBtn);
    tab.onclick = (ev) => { if (!ev.target.closest('button')) switchBoreholeTab(bhId); };
    // Insert before "+" button if it exists
    const addBtn = tabsContainer.querySelector('#spt-add-tab-btn');
    if (addBtn) tabsContainer.insertBefore(tab, addBtn);
    else tabsContainer.appendChild(tab);
    
    //  tab 
    const tabContent = document.createElement('div');
    tabContent.className = 'borehole-section';
    tabContent.id = `content-${bhId}`;
    tabContent.style.cssText = 'display: none; position: relative;';
    
    // 
    tabContent.innerHTML = `
        <div style="margin-bottom: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <label style="font-weight: bold; font-size: 13px; color: var(--primary-color); text-shadow: 0 0 5px var(--glow-color);">SPT Data Input (${boreholeName || bhId})</label>
                <div style="display: flex; gap: 10px;">
                    <button type="button" class="btn-add-row" onclick="addSPTRow('${bhId}')">
                        <i class="material-icons">add</i> Add Row
                    </button>
                    <button type="button" class="btn-clear-table" onclick="clearSPTTable('${bhId}')">
                        <i class="material-icons">clear</i> Clear
                    </button>
                </div>
            </div>
            
            <div style="border: 1px solid rgba(0, 217, 255, 0.3); border-radius: 6px; overflow: hidden; background-color: var(--card-bg);">
                <div style="max-height: 400px; overflow-y: auto; overflow-x: auto;">
                    <table class="spt-data-table data-table" data-bh-id="${bhId}">
                        <thead>
                            <tr>
                                <th style="min-width: 90px;">Depth (ft)</th>
                                <th style="min-width: 80px;">γt (pcf)</th>
                                <th style="min-width: 70px;">SPT-N</th>
                                <th style="min-width: 70px;">PI (%)</th>
                                <th style="min-width: 110px;" title="Fines Content (percent passing #200 sieve). Not Field Capacity.">Fines Content (FC %)</th>
                                <th style="min-width: 80px;">Soil Class</th>
                                <th style="min-width: 70px;">Gravelly?</th>
                                <th style="min-width: 70px;">Analyze</th>
                            </tr>
                        </thead>
                        <tbody id="spt-table-body-${bhId}">
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
    contentContainer.appendChild(tabContent);
    
    // 
    if (!sptBoreholeData[bhId]) {
        sptBoreholeData[bhId] = { gwt: 3.0, gwtDesign: 3.0 };
    }
    
    //  tab
    switchBoreholeTab(bhId);
    
    return bhId;
}

//  SPT 
function importSPTData(testData, boreholeId = null, boreholeName = null) {
    console.log('Importing SPT data:', testData, 'for borehole:', boreholeId, boreholeName);
    
    //  borehole tab
    let bhId = findOrCreateBoreholeTab(boreholeId, boreholeName, 'SPT');
    let tbody = document.getElementById(`spt-table-body-${bhId}`);
    if (!tbody) {
        generateBoreholeTables();
        bhId = findOrCreateBoreholeTab(boreholeId, boreholeName, 'SPT');
        tbody = document.getElementById(`spt-table-body-${bhId}`);
    }
    if (!tbody) {
        alert('SPT table not found. Please switch to the Liquefaction page first, then try importing again.');
        return;
    }
    
    // （DIGGS XML depths are ft; SPT table always displays ft)
    const depthFromRaw = testData.depth_from || 0;
    const depthToRaw = testData.depth_to || 0;
    const depthFrom = parseFloat(depthFromRaw);
    const depthTo = parseFloat(depthToRaw);
    const nValue = testData.background?.nValue || '';
    const piVal = testData.background?.pi ?? 'NP';
    const fcVal = testData.background?.fc ?? '';
    
    // （，）
    // tbody.innerHTML = '';
    
    // 
    const row = document.createElement('tr');
    const depthStr = (isFinite(depthFrom) && isFinite(depthTo) && (depthFromRaw || depthToRaw))
        ? `${depthFrom.toFixed(2)} - ${depthTo.toFixed(2)}`
        : '';
    row.innerHTML = `
        <td><input type="text" value="${depthStr}"></td>
        <td><input type="number" step="0.1" value=""></td>
        <td><input type="number" step="1" value="${nValue || ''}"></td>
        <td><input type="text" value="${escapeHtml(String(piVal))}"></td>
        <td><input type="number" step="1" value="${fcVal !== '' && fcVal != null ? escapeHtml(String(fcVal)) : ''}"></td>
        <td><input type="text" value=""></td>
        <td>
            <select>
                <option value="N" selected>N</option>
                <option value="Y">Y</option>
            </select>
        </td>
        <td>
            <select>
                <option value="Y" selected>Y</option>
                <option value="N">N</option>
            </select>
        </td>
    `;
    tbody.appendChild(row);
    
    //  SPT （ CPT ），
    switchTestType('SPT', { regenerate: false });
    
    //  borehole tab
    switchBoreholeTab(bhId);
    
    // 
    const tabContent = document.getElementById(`content-${bhId}`);
    if (tabContent) {
        tabContent.style.display = 'block';
    }
    
    // （）
    setTimeout(() => {
        const table = document.getElementById(`spt-table-body-${bhId}`);
        if (table) {
            table.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 150);
    
    console.log('SPT data imported successfully');
}

// Batch import SPT tests for the same borehole (merge/sort/dedupe before rendering)
// lithologyRowsForImport: [{from, to, legend_code, pi, fc, unit_weight}] -  lithology ， Soil ClassPIFCγt
function importSPTDataBatch(testDataList, boreholeId = null, boreholeName = null, lithologyUscs = null, lithologyRowsForImport = null) {
    //  API ： tests/data ； .tests/.data
    let raw = [];
    if (Array.isArray(testDataList)) {
        raw = testDataList;
    } else if (testDataList && typeof testDataList === 'object') {
        if (Array.isArray(testDataList.tests)) raw = testDataList.tests;
        else if (Array.isArray(testDataList.data)) raw = testDataList.data;
        else raw = [testDataList];
    }
    const list = [];
    for (const x of raw) {
        if (Array.isArray(x && x.tests)) list.push(...x.tests);
        else if (Array.isArray(x && x.data)) list.push(...x.data);
        else if (x != null) list.push(x);
    }
    const lithRows = Array.isArray(lithologyRowsForImport) && lithologyRowsForImport.length > 0 ? lithologyRowsForImport : null;
    //  lithology  SPT，
    if (list.length === 0 && !lithRows) {
        console.warn('[DIGGS Import] importSPTDataBatch: No data (list=0, lithRows=0) - nothing to import');
        if (typeof setDiggsStatus === 'function') setDiggsStatus('No SPT or layer data to import.', 'warning');
        return;
    }

    // （tbody ）
    const lp = document.getElementById('liquefaction-page');
    if (lp) lp.style.display = 'block';
    if (typeof window.changeTab === 'function') window.changeTab('Soil Mechanics');
    if (typeof switchTestType === 'function') switchTestType('SPT', { regenerate: false });

    // Create/find the borehole tab once
    let bhId = findOrCreateBoreholeTab(boreholeId, boreholeName, 'SPT');
    let tbody = document.getElementById(`spt-table-body-${bhId}`);
    // If tbody missing (e.g. page not ready or tab was wiped): avoid wiping with generateBoreholeTables when we have a specific boreholeId
    if (!tbody && boreholeId) {
        bhId = findOrCreateBoreholeTab(boreholeId, boreholeName, 'SPT');
        tbody = document.getElementById(`spt-table-body-${bhId}`);
    }
    if (!tbody) {
        generateBoreholeTables();
        bhId = findOrCreateBoreholeTab(boreholeId, boreholeName, 'SPT');
        tbody = document.getElementById(`spt-table-body-${bhId}`);
    }
    if (!tbody) {
        console.error('[DIGGS Import] SPT table not found: spt-table-body-' + bhId);
        alert('SPT table not found. Please switch to the Liquefaction page first, then try importing again.');
        return;
    }
    const rowCount = lithRows ? lithRows.length : list.length;
    console.log(`[DIGGS Import] importSPTDataBatch: tbody=${bhId}, list=${list.length}, lithRows=${lithRows?.length ?? 0}, will append ~${rowCount} row(s)`);

    //  tab 
    const contentDiv = document.getElementById(`content-${bhId}`);
    if (contentDiv) contentDiv.style.display = 'block';

    // DIGGS/XML SPT source depths are commonly in ft. Convert to current UI unit for display.
    const unitSystemRadio = document.querySelector('input[name="unit-system"]:checked');
    const unitSystem = unitSystemRadio ? unitSystemRadio.value : 'imperial';
    const FT_TO_M = 0.3048;
    // Unit weight source from DIGGS lithology is tf/m³.
    const TF_M3_TO_KN_M3 = 9.81;
    const KN_M3_TO_PCF = 6.36588;
    const TYPICAL_GAMMA = {
        CL: 1.9, CH: 1.8, ML: 1.85, MH: 1.75,
        SM: 1.9, SC: 1.95, SP: 1.7, SW: 1.8,
        GP: 1.75, GW: 1.85, GM: 1.9, GC: 1.95,
        SF: 1.85, TOPSOIL: 1.7
    };
    function convertDepthFtToDisplay(depthFt) {
        if (!isFinite(depthFt)) return NaN;
        return unitSystem === 'metric' ? (depthFt * FT_TO_M) : depthFt;
    }
    function convertUnitWeightTfM3ToDisplay(tfM3) {
        if (tfM3 == null || tfM3 === '' || !isFinite(parseFloat(tfM3))) return '';
        const tf = parseFloat(tfM3);
        if (unitSystem === 'metric') {
            return (tf * TF_M3_TO_KN_M3).toFixed(2); // display kN/m³
        }
        const knM3 = tf * TF_M3_TO_KN_M3;
        return (knM3 * KN_M3_TO_PCF).toFixed(2); // display pcf
    }
    function firstFiniteNumber(...vals) {
        for (const v of vals) {
            const n = parseFloat(v);
            if (isFinite(n)) return n;
        }
        return NaN;
    }
    function parseDepthRange(raw) {
        const s = (raw == null ? '' : String(raw)).trim();
        if (!s) return { from: NaN, to: NaN };
        const m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|~|to)\s*(-?\d+(?:\.\d+)?)/i);
        if (!m) return { from: NaN, to: NaN };
        const from = parseFloat(m[1]);
        const to = parseFloat(m[2]);
        return { from: isFinite(from) ? from : NaN, to: isFinite(to) ? to : NaN };
    }
    function getDepthPair(td) {
        let depthFrom = firstFiniteNumber(td?.depth_from, td?.depthFrom, td?.from, td?.z_top, td?.z1, td?.DepthFrom);
        let depthTo = firstFiniteNumber(td?.depth_to, td?.depthTo, td?.to, td?.z_bot, td?.z2, td?.DepthTo);
        if (!isFinite(depthFrom) || !isFinite(depthTo)) {
            const parsed = parseDepthRange(td?.depth_range ?? td?.depthRange ?? td?.depth);
            if (!isFinite(depthFrom)) depthFrom = parsed.from;
            if (!isFinite(depthTo)) depthTo = parsed.to;
        }
        return { depthFrom, depthTo };
    }
    function getNValue(td) {
        return td?.background?.nValue
            ?? td?.background?.n_value
            ?? td?.nValue
            ?? td?.n_value
            ?? td?.spt_n
            ?? td?.n
            ?? '';
    }
    function getPIValue(td) {
        return td?.background?.pi ?? td?.pi ?? td?.PI ?? 'NP';
    }
    function getFCValue(td) {
        return td?.background?.fc ?? td?.fc ?? td?.FC ?? '';
    }

    // Normalize USCS lithology intervals to current display unit.
    const uscsIntervalsRaw = Array.isArray(lithologyUscs) ? lithologyUscs : [];
    const uscsIntervals = uscsIntervalsRaw
        .map(it => {
            const f0 = parseFloat(it?.from);
            const t0 = parseFloat(it?.to);
            const f = isFinite(f0) ? convertDepthFtToDisplay(f0) : NaN;
            const t = isFinite(t0) ? convertDepthFtToDisplay(t0) : NaN;
            const sc = (it?.soil_class ?? '').toString();
            const lc = (it?.legend_code ?? it?.legendCode ?? sc).toString();
            const cn = (it?.classification_name ?? it?.classificationName ?? sc).toString();
            const uwRaw = it?.unit_weight ?? it?.unit_weight_tf_m3 ?? it?.unitWeight ?? it?.rt ?? it?.r_t ?? null;
            const uw = (uwRaw === '' || uwRaw == null) ? null : parseFloat(uwRaw);
            return {
                from: f,
                to: t,
                soil_class: sc || lc,
                legend_code: lc,
                classification_name: cn,
                description: (it?.description ?? '').toString(),
                unit_weight_tf_m3: isFinite(uw) ? uw : null,
            };
        })
        .filter(it => isFinite(it.from) && isFinite(it.to))
        .sort((a, b) => (a.from - b.from) || (a.to - b.to));

    function pickLithologyForRange(depthFrom, depthTo) {
        if (!isFinite(depthFrom) || !isFinite(depthTo) || uscsIntervals.length === 0) return '';
        const mid = (depthFrom + depthTo) / 2.0;
        const midHit = uscsIntervals.find(it => mid >= it.from && mid < it.to);
        if (midHit) return midHit;
        let best = null, bestOv = 0;
        for (const it of uscsIntervals) {
            const ov = Math.max(0, Math.min(depthTo, it.to) - Math.max(depthFrom, it.from));
            if (ov > bestOv) { bestOv = ov; best = it; }
        }
        return best || '';
    }

    function pickUscsForRange(depthFrom, depthTo) {
        const it = pickLithologyForRange(depthFrom, depthTo);
        if (!it || typeof it !== 'object') return '';
        return (it.soil_class || it.legend_code || it.classification_name || '').trim();
    }

    function pickUnitWeightForRange(depthFrom, depthTo) {
        const it = pickLithologyForRange(depthFrom, depthTo);
        if (!it || typeof it !== 'object') return '';
        if (it.unit_weight_tf_m3 != null && isFinite(it.unit_weight_tf_m3)) {
            return convertUnitWeightTfM3ToDisplay(it.unit_weight_tf_m3);
        }
        const uscs = (it.soil_class || it.legend_code || '').trim().toUpperCase();
        const typicalTf = TYPICAL_GAMMA[uscs];
        if (typicalTf == null || !isFinite(typicalTf)) return '';
        return convertUnitWeightTfM3ToDisplay(typicalTf);
    }

    // Parse SPT list to current display unit (source depth is ft).
    const sptList = list.map(td => {
        const pair = getDepthPair(td);
        const df0 = pair.depthFrom;
        const dt0 = pair.depthTo;
        const depthFrom = isFinite(df0) ? convertDepthFtToDisplay(df0) : NaN;
        const depthTo = isFinite(dt0) ? convertDepthFtToDisplay(dt0) : NaN;
        return {
            depthFrom, depthTo,
            mid: (depthFrom + depthTo) / 2,
            nValue: getNValue(td),
            piVal: getPIValue(td),
            fcVal: getFCValue(td)
        };
    });

    let rows = [];
    if (lithRows && lithRows.length > 0) {
        //  lithology ：， Soil ClassPIFCγt， SPT-N
        // SPT  1–3 ： soil class  N ， SPT  N
        const conv = (v) => isFinite(v) ? convertDepthFtToDisplay(v) : NaN;
        // Build: legend_code -> [{depth, nValue}] from SPTs lying in that soil layer
        const soilClassToNValues = new Map();
        for (const s of sptList) {
            if (!isFinite(s.mid) || (s.nValue !== '' && s.nValue != null) === false) continue;
            const lit = lithRows.find(l => {
                const f = conv(parseFloat(l.from));
                const t = conv(parseFloat(l.to));
                return isFinite(f) && isFinite(t) && s.mid >= f && s.mid < t;
            });
            if (!lit) continue;
            const code = (lit.soil_class || lit.legend_code || lit.classification_name || '').trim();
            if (!code) continue;
            const key = code.toUpperCase();
            if (!soilClassToNValues.has(key)) soilClassToNValues.set(key, []);
            soilClassToNValues.get(key).push({ depth: s.mid, nValue: s.nValue });
        }
        function findBestNForLayer(from, to, legendCode) {
            const direct = sptList.find(s => isFinite(s.mid) && s.mid >= from && s.mid < to);
            if (direct && direct.nValue !== '' && direct.nValue != null) return direct.nValue;
            const code = (legendCode || '').trim();
            if (!code) return '';
            const candidates = soilClassToNValues.get(code.toUpperCase()) || [];
            if (candidates.length === 0) return '';
            const mid = (from + to) / 2;
            let best = null, bestDist = Infinity;
            for (const c of candidates) {
                const dist = Math.abs(c.depth - mid);
                if (dist < bestDist) { bestDist = dist; best = c; }
            }
            return best ? best.nValue : '';
        }
        for (const lit of lithRows) {
            const from = conv(parseFloat(lit.from));
            const to = conv(parseFloat(lit.to));
            if (!isFinite(from) || !isFinite(to)) continue;
            const sptInRange = sptList.find(s => isFinite(s.mid) && s.mid >= from && s.mid < to);
            const uscs = (lit.soil_class || lit.legend_code || lit.classification_name || '').trim();
            const nVal = findBestNForLayer(from, to, uscs) || (lit.spt_n != null && lit.spt_n !== '' ? String(lit.spt_n) : '');
            rows.push({
                depthFrom: from,
                depthTo: to,
                depthFromRaw: lit.from,
                depthToRaw: lit.to,
                nValue: nVal,
                piVal: lit.pi ?? (sptInRange ? sptInRange.piVal : 'NP'),
                fcVal: lit.fc ?? (sptInRange ? sptInRange.fcVal : ''),
                uscs,
                unitWeight: convertUnitWeightTfM3ToDisplay(lit.unit_weight ?? lit.unit_weight_tf_m3 ?? lit.rt ?? lit.r_t)
            });
        }
        // SPT  lithology ，
        for (const s of sptList) {
            if (!isFinite(s.depthFrom) || !isFinite(s.depthTo)) continue;
            const alreadyIn = rows.some(r => s.mid >= r.depthFrom && s.mid < r.depthTo);
            if (!alreadyIn && s.nValue) {
                rows.push({
                    depthFrom: s.depthFrom,
                    depthTo: s.depthTo,
                    depthFromRaw: s.depthFrom,
                    depthToRaw: s.depthTo,
                    nValue: s.nValue,
                    piVal: s.piVal,
                    fcVal: s.fcVal,
                    uscs: pickUscsForRange(s.depthFrom, s.depthTo),
                    unitWeight: pickUnitWeightForRange(s.depthFrom, s.depthTo)
                });
            }
        }
        rows.sort((a, b) => (a.depthFrom - b.depthFrom) || (a.depthTo - b.depthTo));
    } else {
        //  lithology ： SPT （depth converted from source ft to display unit）
        for (const td of list) {
            const pair = getDepthPair(td);
            const depthFromRaw = pair.depthFrom;
            const depthToRaw = pair.depthTo;
            const df0 = parseFloat(depthFromRaw);
            const dt0 = parseFloat(depthToRaw);
            const depthFrom = isFinite(df0) ? convertDepthFtToDisplay(df0) : NaN;
            const depthTo = isFinite(dt0) ? convertDepthFtToDisplay(dt0) : NaN;
            rows.push({
                depthFromRaw, depthToRaw, depthFrom, depthTo,
                nValue: getNValue(td),
                piVal: getPIValue(td),
                fcVal: getFCValue(td),
                uscs: pickUscsForRange(depthFrom, depthTo),
                unitWeight: pickUnitWeightForRange(depthFrom, depthTo)
            });
        }
        rows.sort((a, b) => {
            const ax = isFinite(a.depthFrom) ? a.depthFrom : Number.POSITIVE_INFINITY;
            const bx = isFinite(b.depthFrom) ? b.depthFrom : Number.POSITIVE_INFINITY;
            if (ax !== bx) return ax - bx;
            return (isFinite(a.depthTo) ? a.depthTo : 0) - (isFinite(b.depthTo) ? b.depthTo : 0);
        });
        const seen = new Set();
        rows = rows.filter(r => {
            const key = [r.depthFrom?.toFixed(4) ?? '', r.depthTo?.toFixed(4) ?? '', String(r.nValue ?? '')].join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    console.log(`[DIGGS Import] importSPTDataBatch: built ${rows.length} row(s), appending to tbody`);
    if (rows.length === 0) {
        console.warn('[DIGGS Import] importSPTDataBatch: rows array is empty - check lithRows/list format');
        if (typeof setDiggsStatus === 'function') setDiggsStatus('Import produced 0 rows. Data format may be incorrect.', 'warning');
        return;
    }
    for (const r of rows) {
        const depthStr = (isFinite(r.depthFrom) && isFinite(r.depthTo))
            ? `${r.depthFrom.toFixed(2)} - ${r.depthTo.toFixed(2)}`
            : '';
        const piStr = escapeHtml(String(r.piVal ?? 'NP'));
        const fcStr = (r.fcVal !== '' && r.fcVal != null) ? escapeHtml(String(r.fcVal)) : '';
        const gammaStr = (r.unitWeight !== '' && r.unitWeight != null) ? escapeHtml(String(r.unitWeight)) : '';

        const rowEl = document.createElement('tr');
        rowEl.innerHTML = `
            <td><input type="text" value="${depthStr}"></td>
            <td><input type="number" step="0.1" value="${gammaStr}"></td>
            <td><input type="number" step="1" value="${(r.nValue ?? '')}"></td>
            <td><input type="text" value="${piStr}"></td>
            <td><input type="number" step="1" value="${fcStr}"></td>
            <td><input type="text" value="${escapeHtml(r.uscs || '')}"></td>
            <td>
                <select>
                    <option value="N" selected>N</option>
                    <option value="Y">Y</option>
                </select>
            </td>
            <td>
                <select>
                    <option value="Y" selected>Y</option>
                    <option value="N">N</option>
                </select>
            </td>
        `;
        tbody.appendChild(rowEl);
    }

    switchTestType('SPT', { regenerate: false });
    switchBoreholeTab(bhId);
    if (contentDiv) contentDiv.style.display = 'block';

    if (typeof setDiggsStatus === 'function') setDiggsStatus(`Imported ${rows.length} SPT row(s) to ${bhId}.`, 'success');

    setTimeout(() => {
        const table = document.getElementById(`spt-table-body-${bhId}`);
        if (table) table.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}

//  CPT tab
function findOrCreateCPTTab(boreholeId, boreholeName, testType) {
    //  boreholeId， CPT-1
    if (!boreholeId) {
        // Ensure CPT UI exists; do not rely on a dropdown count
        generateCPTTables();
        return 'CPT-1';
    }
    
    //  tab ID（ boreholeId）
    const safeId = String(boreholeId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const cptId = `CPT-${safeId}`;
    
    //  tab 
    const existingTab = document.getElementById(`cpt-tab-${cptId}`);
    if (existingTab) {
        return cptId;
    }
    
    // ， tab
    const tabsContainer = document.getElementById('cpt-borehole-tabs');
    const contentContainer = document.getElementById('dynamic-cpt-container');
    
    if (!tabsContainer || !contentContainer) {
        // ，（non-destructive）
        generateCPTTables();
        return 'CPT-1';
    }

    // Make sure the "+" add-tab button exists (DIGGS import may skip regeneration).
    try { ensureCptAddTabButtonExists(); } catch (_) {}
    
    //  tab 
    const tab = document.createElement('div');
    tab.className = 'cpt-borehole-tab';
    tab.id = `cpt-tab-${cptId}`;
    tab.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 20px;
        cursor: pointer;
        border: 1px solid rgba(0, 217, 255, 0.22);
        border-bottom: none;
        background-color: var(--card-bg);
        color: var(--text-secondary);
        border-radius: 5px 5px 0 0;
        font-weight: normal;
        transition: all 0.3s;
    `;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = boreholeName || cptId;
    labelSpan.style.flex = '1';
    labelSpan.style.overflow = 'hidden';
    labelSpan.style.textOverflow = 'ellipsis';
    labelSpan.style.whiteSpace = 'nowrap';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', `Remove ${cptId}`);
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0 2px;
        opacity: 0.85;
    `;
    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeCPTTab(cptId);
    });

    tab.appendChild(labelSpan);
    tab.appendChild(closeBtn);

    tab.onclick = () => switchCPTTab(cptId);
    // Ensure "+" add button always stays on the far right:
    // insert new tabs BEFORE the add button if it exists.
    const addBtn = tabsContainer.querySelector('#cpt-add-tab-btn');
    if (addBtn) tabsContainer.insertBefore(tab, addBtn);
    else tabsContainer.appendChild(tab);
    
    //  tab （ generateCPTTables ）
    const tabContent = document.createElement('div');
    tabContent.className = 'cpt-section';
    tabContent.id = `cpt-content-${cptId}`;
    tabContent.style.cssText = 'display: none; position: relative;';
    
    // ， tbody  ID
    // ： HTML ，； ID， cptId
    const escapedCptId = cptId.replace(/'/g, "\\'");
    const escapedBoreholeName = (boreholeName || cptId).replace(/'/g, "\\'").replace(/"/g, "&quot;");
    
    tabContent.innerHTML = `
        <div style="margin-bottom: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <label style="font-weight: bold; font-size: 13px; color: var(--primary-color); text-shadow: 0 0 5px var(--glow-color); display: flex; align-items: center; gap: 8px;">
                    CPT Data Input (${escapedBoreholeName})
                </label>
                <div style="display: flex; gap: 10px;">
                    <button type="button" class="btn-add-row" onclick="addCPTRow('${escapedCptId}')">
                        <i class="material-icons">add</i> Add Row
                    </button>
                    <button type="button" class="btn-clear-table" onclick="clearCPTTable('${escapedCptId}')">
                        <i class="material-icons">clear</i> Clear
                    </button>
                </div>
            </div>
            
            <div style="display: flex; gap: 20px; align-items: flex-start;">
                <div style="flex: 0 0 auto; border: 1px solid rgba(0, 217, 255, 0.3); border-radius: 6px; overflow: hidden; background-color: var(--card-bg);">
                    <div style="max-height: 400px; overflow-y: auto; overflow-x: auto;">
                        <table class="cpt-data-table data-table" data-cpt-id="${cptId}">
                            <thead>
                                <tr>
                                    <th style="min-width: 80px;">Depth (m)</th>
                                    <th style="min-width: 90px;">qc (kPa)</th>
                                    <th style="min-width: 90px;">fs (kPa)</th>
                                    <th style="min-width: 90px;">u₂ (m)</th>
                                </tr>
                            </thead>
                            <tbody id="cpt-table-body-${cptId}">
                            </tbody>
                        </table>
                    </div>
                </div>
                
                <div style="flex: 0 0 auto; padding: 15px; background: rgba(0, 217, 255, 0.06); border-radius: 8px; border: 1px solid rgba(0, 217, 255, 0.25); min-width: 280px;">
                    <div style="display: flex; flex-direction: column; gap: 15px;">
                        <div class="form-group">
                            <label style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: block; margin-bottom: 8px;">Net Area Ratio (a<sub>n</sub>):</label>
                            <input type="number" id="cpt-net-area-ratio-${cptId}" value="0.8" step="0.01" min="0.7" max="0.9" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid rgba(0, 217, 255, 0.3); font-size: 13px; background-color: var(--card-bg); color: var(--text-primary);" onchange="updateCurrentCPTParams('${escapedCptId}')">
                            <small style="color: var(--text-secondary); font-size: 11px;">Typical: 0.75-0.85</small>
                            <div id="cpt-net-area-bg-${cptId}" style="display:none; margin-top: 10px; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.12); border: 1px dashed rgba(0, 217, 255, 0.25); color: var(--text-secondary); font-size: 11px; line-height: 1.45;"></div>
                        </div>
                        <div class="form-group">
                            <label style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: block; margin-bottom: 8px;">Gamma Method:</label>
                            <select id="cpt-gamma-method-${cptId}" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid rgba(0, 217, 255, 0.3); font-size: 13px; background-color: var(--card-bg); color: var(--text-primary);" onchange="updateCurrentCPTParams('${escapedCptId}')">
                                <option value="robertson">Robertson (2009)</option>
                                <option value="suzuki">Suzuki (2015)</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    contentContainer.appendChild(tabContent);
    
    //  tbody  ID
    const table = tabContent.querySelector(`table[data-cpt-id="${cptId}"]`);
    if (table) {
        let tbody = table.querySelector('tbody');
        if (!tbody) {
            tbody = document.createElement('tbody');
            tbody.id = `cpt-table-body-${cptId}`;
            table.appendChild(tbody);
        } else {
            //  ID 
            tbody.id = `cpt-table-body-${cptId}`;
        }
        console.log(`[CPT] Created table body with ID: cpt-table-body-${cptId}`);
    } else {
        console.error(`[CPT] Failed to find table with data-cpt-id="${cptId}"`);
    }
    
    //  tab
    switchCPTTab(cptId);
    
    return cptId;
}

//  CPT 
function importCPTData(testData, boreholeId = null, boreholeName = null) {
    console.log('Importing CPT data:', testData, 'for borehole:', boreholeId, boreholeName);
    
    //  CPT tab
    const cptId = findOrCreateCPTTab(boreholeId, boreholeName, 'CPT');
    
    // （）
    const waitForTable = (retries = 10) => {
        let tbody = document.getElementById(`cpt-table-body-${cptId}`);
        if (tbody) {
            continueImportCPTData(testData, cptId);
            return;
        }
        if (retries > 0) {
            setTimeout(() => waitForTable(retries - 1), 100);
            return;
        }
        // ： CPT  tbody
        const tabsContainer = document.getElementById('cpt-borehole-tabs');
        const contentContainer = document.getElementById('dynamic-cpt-container');
        if (!tabsContainer || !contentContainer) {
            generateCPTTables();
        }
        tbody = document.getElementById(`cpt-table-body-${cptId}`);
        if (tbody) {
            continueImportCPTData(testData, cptId);
            return;
        }
        const contentDiv = document.getElementById(`cpt-content-${cptId}`);
        if (contentDiv) {
            const table = contentDiv.querySelector(`table[data-cpt-id="${cptId}"]`);
            if (table) {
                tbody = table.querySelector('tbody');
                if (!tbody) {
                    tbody = document.createElement('tbody');
                    tbody.id = `cpt-table-body-${cptId}`;
                    table.appendChild(tbody);
                }
                continueImportCPTData(testData, cptId);
                return;
            }
        }
        alert('CPT table not found. Please switch to the Soil Mechanics page first, then try importing again.');
    };
    
    waitForTable();
}

function renderCptDiggsBackgroundIntoNetAreaBlock(cptId, background) {
    try {
        const el = document.getElementById(`cpt-net-area-bg-${cptId}`);
        if (!el) return;
        const bg = background || {};
        const parts = [];
        if (bg.serialNumber) parts.push(`<div><strong>Serial Number:</strong> ${escapeHtml(bg.serialNumber)}</div>`);
        if (bg.penetrometerType) parts.push(`<div><strong>Penetrometer Type:</strong> ${escapeHtml(bg.penetrometerType)}</div>`);
        if (bg.tipArea) {
            const u = bg.tipArea_uom ? ` ${escapeHtml(bg.tipArea_uom)}` : '';
            parts.push(`<div><strong>Tip Area:</strong> ${escapeHtml(bg.tipArea)}${u}</div>`);
        }
        if (bg.distanceTipToSleeve) {
            const u = bg.distanceTipToSleeve_uom ? ` ${escapeHtml(bg.distanceTipToSleeve_uom)}` : '';
            parts.push(`<div><strong>Distance Tip–Sleeve:</strong> ${escapeHtml(bg.distanceTipToSleeve)}${u}</div>`);
        }
        if (bg.penetrationRate) {
            const u = bg.penetrationRate_uom ? ` ${escapeHtml(bg.penetrationRate_uom)}` : '';
            parts.push(`<div><strong>Penetration Rate:</strong> ${escapeHtml(bg.penetrationRate)}${u}</div>`);
        }
        if (bg.netAreaRatioCorrection) parts.push(`<div><strong>Net Area Ratio Correction:</strong> ${escapeHtml(bg.netAreaRatioCorrection)}</div>`);

        if (parts.length === 0) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        el.style.display = 'block';
        el.innerHTML = `
            <div style="font-weight: 800; color: var(--text-primary); margin-bottom: 6px;">DIGGS Background</div>
            ${parts.join('')}
        `;
    } catch (_) {}
}

//  CPT （）
function continueImportCPTData(testData, cptId) {
    //  CPT 
    const lp = document.getElementById('liquefaction-page');
    if (lp) lp.style.display = 'block';
    if (typeof window.changeTab === 'function') window.changeTab('Soil Mechanics');
    if (typeof switchTestType === 'function') switchTestType('CPT', { regenerate: false });

    const tbody = document.getElementById(`cpt-table-body-${cptId}`);
    if (!tbody) {
        console.error(`CPT table body still not found for ${cptId}`);
        alert('CPT table not found. Please switch to the Soil Mechanics page first, then try importing again.');
        return;
    }
    
    //  UI 
    // DIGGS XML: depths/u2(head) commonly in ft; qc/fs commonly in kPa (sometimes MPa).
    const unitSystemRadio = document.querySelector('input[name="unit-system"]:checked');
    const unitSystem = unitSystemRadio ? unitSystemRadio.value : 'imperial'; // 'imperial' | 'metric'
    const FT_TO_M = 0.3048;
    const TSF_TO_KPA = 95.7605;

    let depthsRaw = Array.isArray(testData.depths) ? testData.depths : [];
    let qcRaw = (testData.qc || []).map(v => (v === null || v === undefined) ? null : Number(v));
    let fsRaw = (testData.fs || []).map(v => (v === null || v === undefined) ? null : Number(v));
    let u2Raw = Array.isArray(testData.u2) ? testData.u2 : [];
    // Fallback: if depths empty but qc/fs have data, generate depths from index (0.5m spacing, ft)
    const dataLen = Math.max(qcRaw.length, fsRaw.length, u2Raw.length);
    if (depthsRaw.length === 0 && dataLen > 0) {
        depthsRaw = Array.from({ length: dataLen }, (_, i) => (i + 1) * 0.5);
    }

    // Heuristic: if qc looks like MPa (median < 200), convert to kPa
    try {
        const qcNums = qcRaw.filter(v => typeof v === 'number' && isFinite(v));
        const qcSorted = qcNums.slice().sort((a, b) => a - b);
        const qcMed = qcSorted.length ? qcSorted[Math.floor(qcSorted.length / 2)] : null;
        if (qcMed !== null && qcMed > 0 && qcMed < 200) {
            qcRaw = qcRaw.map(v => (typeof v === 'number' && isFinite(v)) ? (v * 1000.0) : v);
            fsRaw = fsRaw.map(v => (typeof v === 'number' && isFinite(v)) ? (v * 1000.0) : v);
        }
    } catch (_) {}

    const depths = depthsRaw.map(d => {
        const v = Number(d);
        if (!isFinite(v)) return '';
        return unitSystem === 'metric' ? (v * FT_TO_M) : v; // ft -> m
    });

    const qcValues = qcRaw.map(v => {
        if (typeof v !== 'number' || !isFinite(v)) return '';
        return unitSystem === 'imperial' ? (v / TSF_TO_KPA) : v; // kPa -> tsf
    });

    const fsValues = fsRaw.map(v => {
        if (typeof v !== 'number' || !isFinite(v)) return '';
        return unitSystem === 'imperial' ? (v / TSF_TO_KPA) : v; // kPa -> tsf
    });

    const u2Values = u2Raw.map(u => {
        const v = Number(u);
        if (!isFinite(v)) return '';
        return unitSystem === 'metric' ? (v * FT_TO_M) : v; // ft -> m (water head)
    });
    
    // （，）
    // tbody.innerHTML = '';
    
    // 
    const maxLen = Math.max(depths.length, qcValues.length, fsValues.length);
    console.log(`[DIGGS Import] continueImportCPTData: cptId=${cptId}, depths=${depths.length}, qc=${qcValues.length}, maxLen=${maxLen}`);
    if (maxLen === 0) {
        console.warn('[DIGGS Import] CPT data has no rows (depths/qc/fs all empty)');
        return;
    }
    for (let i = 0; i < maxLen; i++) {
        const row = document.createElement('tr');
        const depth = depths[i] !== undefined ? depths[i] : '';
        const qc = qcValues[i] !== undefined ? qcValues[i] : '';
        const fs = fsValues[i] !== undefined ? fsValues[i] : '';
        const u2 = u2Values[i] !== undefined ? u2Values[i] : '';
        
        row.innerHTML = `
            <td><input type="number" step="0.01" value="${(depth === '' ? '' : Number(depth).toFixed(2))}"></td>
            <td><input type="number" step="0.1" value="${(qc === '' ? '' : Number(qc).toFixed(2))}"></td>
            <td><input type="number" step="0.1" value="${(fs === '' ? '' : Number(fs).toFixed(2))}"></td>
            <td><input type="number" step="0.01" value="${(u2 === '' ? '' : Number(u2).toFixed(2))}"></td>
        `;
        tbody.appendChild(row);
    }
    
    //  CPT （ SPT ）
    // NOTE: do NOT regenerate CPT tables here; regeneration would wipe the imported rows.
    switchTestType('CPT', { regenerate: false });
    // Ensure table headers reflect the selected unit system
    try { updateUnitSystem(); } catch (_) {}
    
    //  CPT tab
    switchCPTTab(cptId);

    // Show CPT background metadata in the Net Area Ratio block (DIGGS import)
    try {
        renderCptDiggsBackgroundIntoNetAreaBlock(cptId, testData && testData.background ? testData.background : null);
    } catch (_) {}
    
    // 
    const tabContent = document.getElementById(`cpt-content-${cptId}`);
    if (tabContent) {
        tabContent.style.display = 'block';
    }
    
    // 
    setTimeout(() => {
        const table = document.getElementById(`cpt-table-body-${cptId}`);
        if (table) {
            table.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, 100);
    
    console.log(`CPT data imported successfully: ${maxLen} rows`);
}

//  (SPT/CPT)
// ==========================================
function ensureSptAddTabButtonExists() {
    const tabsContainer = document.getElementById('borehole-tabs');
    if (!tabsContainer) return;
    if (tabsContainer.querySelector('#spt-add-tab-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'spt-add-tab-btn';
    btn.type = 'button';
    btn.textContent = '+';
    btn.title = 'Add a new borehole';
    btn.style.cssText = `
        padding: 10px 16px;
        border-radius: 5px 5px 0 0;
        border: 1px solid rgba(0, 217, 255, 0.22);
        border-bottom: none;
        background-color: var(--card-bg);
        color: var(--text-primary);
        cursor: pointer;
        font-weight: 800;
        font-size: 16px;
        line-height: 1;
    `;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const existingNums = Array.from(document.querySelectorAll('#borehole-tabs .borehole-tab'))
            .map(t => t.id.replace('tab-', ''))
            .filter(id => /^BH-\d+$/.test(id))
            .map(id => parseInt(id.split('-')[1], 10))
            .filter(n => isFinite(n));
        const nextN = (existingNums.length ? Math.max(...existingNums) : 0) + 1;
        const nextId = String(nextN);
        findOrCreateBoreholeTab(nextId, `BH-${nextN}`, 'SPT');
    });
    tabsContainer.appendChild(btn);
}

function ensureCptAddTabButtonExists() {
    const tabsContainer = document.getElementById('cpt-borehole-tabs');
    if (!tabsContainer) return;
    if (tabsContainer.querySelector('#cpt-add-tab-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'cpt-add-tab-btn';
    btn.type = 'button';
    btn.textContent = '+';
    btn.title = 'Add a new CPT tag';
    btn.style.cssText = `
        padding: 10px 16px;
        border-radius: 5px 5px 0 0;
        border: 1px solid rgba(0, 217, 255, 0.22);
        border-bottom: none;
        background-color: var(--card-bg);
        color: var(--text-primary);
        cursor: pointer;
        font-weight: 800;
        font-size: 16px;
        line-height: 1;
    `;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const existingNums = Array.from(document.querySelectorAll('#cpt-borehole-tabs .cpt-borehole-tab'))
            .map(t => t.id.replace('cpt-tab-', ''))
            .filter(id => /^CPT-\d+$/.test(id))
            .map(id => parseInt(id.split('-')[1], 10))
            .filter(n => isFinite(n));
        const nextN = (existingNums.length ? Math.max(...existingNums) : 0) + 1;
        // Use findOrCreateCPTTab to avoid wiping existing imported CPT rows.
        findOrCreateCPTTab(String(nextN), `CPT-${nextN}`, 'CPT');
        try { switchTestType('CPT', { regenerate: false }); } catch (_) {}
        try { switchCPTTab(`CPT-${nextN}`); } catch (_) {}
    });
    tabsContainer.appendChild(btn);
}

function switchTestType(testType, opts = {}) {
    const regenerate = opts.regenerate !== false;
    const sptControls = document.getElementById('spt-mode-controls');
    const cptControls = document.getElementById('cpt-mode-controls');
    const sptTabs = document.getElementById('borehole-tabs');
    const sptContainer = document.getElementById('dynamic-borehole-container');
    const cptTabsContainer = document.getElementById('cpt-tabs-container');
    const sptDiggsNoticeBar = document.getElementById('spt-diggs-notice-bar');
    
    if (testType === 'SPT') {
        //  SPT 
        if (sptControls) sptControls.style.display = 'block';
        if (cptControls) cptControls.style.display = 'none';
        if (sptTabs) sptTabs.style.display = 'flex';
        if (sptContainer) sptContainer.style.display = 'block';
        if (cptTabsContainer) cptTabsContainer.style.display = 'none';
        if (sptDiggsNoticeBar) sptDiggsNoticeBar.style.display = 'flex';
        
        //  SPT （：）
        if (regenerate) {
            generateBoreholeTables();
        } else {
            // In DIGGS import mode:  tab，； + 
            const hasTabs = sptTabs && sptTabs.querySelector('.borehole-tab');
            if (!hasTabs) {
                try { generateBoreholeTables(); } catch (_) {}
            } else {
                try { ensureSptAddTabButtonExists(); } catch (_) {}
            }
        }
    } else if (testType === 'CPT') {
        //  CPT 
        if (sptControls) sptControls.style.display = 'none';
        if (cptControls) cptControls.style.display = 'block';
        if (sptTabs) sptTabs.style.display = 'none';
        if (sptContainer) sptContainer.style.display = 'none';
        if (cptTabsContainer) cptTabsContainer.style.display = 'block';
        if (sptDiggsNoticeBar) sptDiggsNoticeBar.style.display = 'none';
        
        //  CPT （：）
        // IMPORTANT: importing CPT data creates/updates specific CPT tabs; regenerating here
        // would clear the DOM and wipe imported rows.
        if (regenerate) {
            generateCPTTables();
        } else {
            // In DIGGS import mode:  tab，； + 
            const cptTabs = document.getElementById('cpt-borehole-tabs');
            const hasCptTabs = cptTabs && cptTabs.querySelector('.cpt-borehole-tab');
            if (!hasCptTabs) {
                try { generateCPTTables(); } catch (_) {}
            } else {
                try { ensureCptAddTabButtonExists(); } catch (_) {}
            }
        }
    }
}

// ==========================================
// CPT （ SPT  Tab ）
// ==========================================
function generateCPTTables() {
    const tabsContainer = document.getElementById('cpt-borehole-tabs');
    const contentContainer = document.getElementById('dynamic-cpt-container');
    if (!tabsContainer || !contentContainer) return;

    // --- helper: ensure + button exists in the CPT tab bar ---
    function ensureCptAddButton() {
        if (tabsContainer.querySelector('#cpt-add-tab-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'cpt-add-tab-btn';
        btn.type = 'button';
        btn.textContent = '+';
        btn.title = 'Add a new CPT tag';
        btn.style.cssText = `
            padding: 10px 16px;
            border-radius: 5px 5px 0 0;
            border: 1px solid rgba(0, 217, 255, 0.22);
            border-bottom: none;
            background-color: var(--card-bg);
            color: var(--text-primary);
            cursor: pointer;
            font-weight: 800;
            font-size: 16px;
            line-height: 1;
        `;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            addNewCptPasteTab();
        });
        tabsContainer.appendChild(btn);
    }

    // --- helper: create one paste-style CPT tab (non-destructive) ---
    function createCptPasteTab(cptId, makeActive = false) {
        // Avoid duplicates
        if (document.getElementById(`cpt-tab-${cptId}`)) {
            if (makeActive) switchCPTTab(cptId);
            return;
        }

        const tab = document.createElement('div');
        tab.className = 'cpt-borehole-tab';
        tab.id = `cpt-tab-${cptId}`;
        tab.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 10px 20px;
            cursor: pointer;
            border: 1px solid rgba(0, 217, 255, 0.22);
            border-bottom: none;
            background-color: ${makeActive ? 'rgba(0, 217, 255, 0.18)' : 'var(--card-bg)'};
            color: ${makeActive ? 'var(--text-primary)' : 'var(--text-secondary)'};
            border-radius: 5px 5px 0 0;
            font-weight: ${makeActive ? 'bold' : 'normal'};
            transition: all 0.3s;
        `;
        const labelSpan = document.createElement('span');
        labelSpan.textContent = cptId;
        labelSpan.style.flex = '1';
        labelSpan.style.overflow = 'hidden';
        labelSpan.style.textOverflow = 'ellipsis';
        labelSpan.style.whiteSpace = 'nowrap';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', `Remove ${cptId}`);
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            background: transparent;
            border: none;
            color: inherit;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            padding: 0 2px;
            opacity: 0.85;
        `;
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeCPTTab(cptId);
        });

        tab.appendChild(labelSpan);
        tab.appendChild(closeBtn);
        tab.onclick = () => switchCPTTab(cptId);

        // Insert before + button if exists, else append
        const addBtn = tabsContainer.querySelector('#cpt-add-tab-btn');
        if (addBtn) {
            tabsContainer.insertBefore(tab, addBtn);
        } else {
            tabsContainer.appendChild(tab);
        }

        const tabContent = document.createElement('div');
        tabContent.className = 'cpt-section';
        tabContent.id = `cpt-content-${cptId}`;
        tabContent.style.cssText = `
            display: ${makeActive ? 'block' : 'none'};
            position: relative;
        `;

        tabContent.innerHTML = `
            <div style="margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <label style="font-weight: bold; font-size: 13px; color: var(--primary-color); text-shadow: 0 0 5px var(--glow-color); display: flex; align-items: center; gap: 8px;">
                        CPT Data Input (Copy & Paste from Excel)
                        <span class="cpt-data-unit-hint" style="margin-left: 8px; font-weight: 500; font-size: 12px; color: var(--text-secondary);">
                            [Depth (m), qc/fs (kPa), u₂ (m)]
                        </span>
                        <button type="button" onclick="openCptWorkflowModal()" title="CPT calculation workflow / formulas"
                                style="margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; border: 1px solid rgba(0,217,255,0.35); background: rgba(255,255,255,0.06); cursor: pointer;">
                            <i class="material-icons" style="font-size: 18px; color: var(--primary-color);">info</i>
                        </button>
                    </label>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" class="btn-add-row" onclick="addCPTRow('${cptId}')">
                            <i class="material-icons">add</i> Add Row
                        </button>
                        <button type="button" class="btn-clear-table" onclick="clearCPTTable('${cptId}')">
                            <i class="material-icons">clear</i> Clear
                        </button>
                    </div>
                </div>
                
                <div style="display: flex; gap: 20px; align-items: flex-start;">
                    <div style="flex: 0 0 auto; border: 1px solid rgba(0, 217, 255, 0.3); border-radius: 6px; overflow: hidden; background-color: var(--card-bg);">
                        <div style="max-height: 400px; overflow-y: auto; overflow-x: auto;">
                            <table class="cpt-data-table data-table" data-cpt-id="${cptId}">
                            <thead>
                                <tr>
                                    <th style="min-width: 80px;">Depth (m)</th>
                                    <th style="min-width: 90px;">qc (kPa)</th>
                                    <th style="min-width: 90px;">fs (kPa)</th>
                                    <th style="min-width: 90px;">u₂ (m)</th>
                                </tr>
                            </thead>
                                <tbody id="cpt-table-body-${cptId}">
                                </tbody>
                            </table>
                        </div>
                    </div>
                    
                    <div style="flex: 0 0 auto; padding: 15px; background: rgba(0, 217, 255, 0.06); border-radius: 8px; border: 1px solid rgba(0, 217, 255, 0.25); min-width: 280px;">
                        <div style="display: flex; flex-direction: column; gap: 15px;">
                            <div class="form-group">
                                <label style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: block; margin-bottom: 8px;">Net Area Ratio (a<sub>n</sub>):</label>
                                <input type="number" id="cpt-net-area-ratio-${cptId}" value="0.8" step="0.01" min="0.7" max="0.9" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid rgba(0, 217, 255, 0.3); font-size: 13px; background-color: var(--card-bg); color: var(--text-primary);" onchange="updateCurrentCPTParams('${cptId}')">
                                <small style="color: var(--text-secondary); font-size: 11px;">Typical: 0.75-0.85</small>
                                <div id="cpt-net-area-bg-${cptId}" style="display:none; margin-top: 10px; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.12); border: 1px dashed rgba(0, 217, 255, 0.25); color: var(--text-secondary); font-size: 11px; line-height: 1.45;"></div>
                            </div>
                            <div class="form-group">
                                <label style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: block; margin-bottom: 8px;">Gamma Method:</label>
                                <select id="cpt-gamma-method-${cptId}" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid rgba(0, 217, 255, 0.3); font-size: 13px; background-color: var(--card-bg); color: var(--text-primary);" onchange="updateCurrentCPTParams('${cptId}')">
                                    <option value="robertson" selected>Robertson (2009)</option>
                                    <option value="Robertson2010">Robertson & Cabal (2010)</option>
                                    <option value="Kulhawy1989">Kulhawy & Mayne (1989)</option>
                                    <option value="Lunne1997">Lunne et al. (1997)</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
                <small style="color: #666; font-size: 11px; display: block; margin-top: 5px;">
                    <i class="material-icons" style="font-size: 12px; vertical-align: middle;">info</i>
                    Tip: Select cells in Excel and paste (Ctrl+V / Cmd+V) directly into the table. The table will automatically add rows as needed.
                </small>
            </div>
        `;

        contentContainer.appendChild(tabContent);

        if (!cptBoreholeData[cptId]) {
            cptBoreholeData[cptId] = { gwt: 3.0, gwtDesign: 3.0, netAreaRatio: 0.8, gammaMethod: 'robertson' };
        }

        // Initialize with one row
        setTimeout(() => {
            const tbody = document.getElementById(`cpt-table-body-${cptId}`);
            if (tbody && tbody.children.length === 0) addCPTRow(cptId);
            setupExcelPasteSupportForTable(`.cpt-data-table[data-cpt-id="${cptId}"]`);
            try { updateUnitSystem(); } catch (_) {}
        }, 50);

        if (makeActive) switchCPTTab(cptId);
    }

    function addNewCptPasteTab() {
        const existing = Array.from(tabsContainer.querySelectorAll('.cpt-borehole-tab'))
            .map(t => t.id.replace('cpt-tab-', ''))
            .filter(id => /^CPT-\d+$/.test(id))
            .map(id => parseInt(id.split('-')[1], 10))
            .filter(n => isFinite(n));
        const nextN = (existing.length ? Math.max(...existing) : 0) + 1;
        const nextId = `CPT-${nextN}`;
        createCptPasteTab(nextId, true);
    }

    // Non-destructive init: ensure at least CPT-1 exists
    const hasAnyTab = tabsContainer.querySelectorAll('.cpt-borehole-tab').length > 0;
    ensureCptAddButton();
    if (!hasAnyTab) {
        createCptPasteTab('CPT-1', true);
    }

    // Make sure CPT headers/labels match the currently selected unit system
    try { updateUnitSystem(); } catch (_) {}
}

// ==========================================
// CPT Tab 
// ==========================================
function removeCPTTab(cptId) {
    const tabEl = document.getElementById(`cpt-tab-${cptId}`);
    const contentEl = document.getElementById(`cpt-content-${cptId}`);
    if (!tabEl && !contentEl) return;

    // Optional confirm to prevent accidental deletion
    const ok = confirm(`Remove CPT tab "${cptId}"? This will delete the table rows for this sounding.`);
    if (!ok) return;

    // Remove DOM
    try { if (tabEl) tabEl.remove(); } catch (_) {}
    try { if (contentEl) contentEl.remove(); } catch (_) {}

    // Remove stored params
    try { if (cptBoreholeData && cptBoreholeData[cptId]) delete cptBoreholeData[cptId]; } catch (_) {}

    const tabsContainer = document.getElementById('cpt-borehole-tabs');
    const remainingTabs = tabsContainer ? Array.from(tabsContainer.querySelectorAll('.cpt-borehole-tab')) : [];

    // Switch to a remaining tab (if any), else regenerate a default CPT-1
    if (remainingTabs.length > 0) {
        const nextId = remainingTabs[0].id.replace('cpt-tab-', '');
        switchCPTTab(nextId);
    } else {
        // Ensure we have at least one table available
        generateCPTTables();
        switchCPTTab('CPT-1');
    }
}

function switchCPTTab(cptId) {
    //  sounding 
    const currentGwtInput = document.getElementById('cpt-gwt');
    const currentGwtDesignInput = document.getElementById('cpt-gwt-design');
    const currentActiveTab = document.querySelector('.cpt-borehole-tab[style*="background-color: rgb(74, 144, 226)"]') || 
                              document.querySelector('.cpt-borehole-tab[style*="#4a90e2"]');
    if (currentActiveTab) {
        const currentCptId = currentActiveTab.id.replace('cpt-tab-', '');
        if (currentCptId && currentCptId !== cptId) {
            //  GWT（）
            const savedGwt = currentGwtInput ? (parseFloat(currentGwtInput.value) || 3.0) : 3.0;
            const savedGwtDesign = currentGwtDesignInput ? (parseFloat(currentGwtDesignInput.value) || savedGwt) : savedGwt;
            
            //  Net Area Ratio  Gamma Method（）
            const currentNetAreaRatioInput = document.getElementById(`cpt-net-area-ratio-${currentCptId}`);
            const currentGammaMethodSelect = document.getElementById(`cpt-gamma-method-${currentCptId}`);
            const savedNetAreaRatio = currentNetAreaRatioInput ? (parseFloat(currentNetAreaRatioInput.value) || 0.8) : 0.8;
            const savedGammaMethod = currentGammaMethodSelect ? (currentGammaMethodSelect.value || 'robertson') : 'robertson';
            
            cptBoreholeData[currentCptId] = {
                gwt: savedGwt,
                gwtDesign: savedGwtDesign,
                netAreaRatio: savedNetAreaRatio,
                gammaMethod: savedGammaMethod
            };
        }
    }
    
    //  tab 
    const allContents = document.querySelectorAll('.cpt-section');
    allContents.forEach(content => {
        content.style.display = 'none';
    });
    
    //  tab 
    const allTabs = document.querySelectorAll('.cpt-borehole-tab');
    allTabs.forEach(tab => {
        tab.style.backgroundColor = '#f0f0f0';
        tab.style.color = '#333';
        tab.style.fontWeight = 'normal';
    });
    
    //  tab 
    const selectedContent = document.getElementById(`cpt-content-${cptId}`);
    if (selectedContent) {
        selectedContent.style.display = 'block';
    }
    
    //  tab
    const selectedTab = document.getElementById(`cpt-tab-${cptId}`);
    if (selectedTab) {
        selectedTab.style.backgroundColor = '#4a90e2';
        selectedTab.style.color = 'white';
        selectedTab.style.fontWeight = 'bold';
    }
    
    // 
    const soundingNoInput = document.getElementById('cpt-sounding-no');
    const gwtInput = document.getElementById('cpt-gwt');
    const gwtDesignInput = document.getElementById('cpt-gwt-design');
    if (soundingNoInput) soundingNoInput.value = cptId;
    if (gwtInput) {
        const savedGwt = cptBoreholeData[cptId]?.gwt || 3.0;
        gwtInput.value = savedGwt;
    }
    if (gwtDesignInput) {
        const savedGwtDesign = cptBoreholeData[cptId]?.gwtDesign ?? cptBoreholeData[cptId]?.gwt ?? 3.0;
        gwtDesignInput.value = savedGwtDesign;
    }
    
    //  tab  Net Area Ratio  Gamma Method（）
    const netAreaRatioInput = document.getElementById(`cpt-net-area-ratio-${cptId}`);
    const gammaMethodSelect = document.getElementById(`cpt-gamma-method-${cptId}`);
    if (netAreaRatioInput) {
        const savedNetAreaRatio = cptBoreholeData[cptId]?.netAreaRatio || 0.8;
        netAreaRatioInput.value = savedNetAreaRatio;
    }
    if (gammaMethodSelect) {
        const savedGammaMethod = cptBoreholeData[cptId]?.gammaMethod || 'robertson';
        gammaMethodSelect.value = savedGammaMethod;
    }
}

// ==========================================
// CPT 
// ==========================================
function addCPTRow(cptId) {
    const tbody = document.getElementById(`cpt-table-body-${cptId}`);
    if (!tbody) return;
    
    const row = document.createElement('tr');
    row.innerHTML = `
        <td><input type="number" step="0.01" class="cpt-input" data-col="depth"></td>
        <td><input type="number" step="0.1" class="cpt-input" data-col="qc"></td>
        <td><input type="number" step="0.1" class="cpt-input" data-col="fs"></td>
        <td><input type="number" step="0.1" class="cpt-input" data-col="u2"></td>
    `;
    tbody.appendChild(row);
}

function clearCPTTable(cptId) {
    const tbody = document.getElementById(`cpt-table-body-${cptId}`);
    if (!tbody) return;
    
    if (confirm('Are you sure you want to clear all CPT data for ' + cptId + '?')) {
        tbody.innerHTML = '';
        addCPTRow(cptId); // 
    }
}

// ==========================================
//  SPT Borehole  GWT
// ==========================================
function updateCurrentSPTGWT() {
    const gwtInput = document.getElementById('spt-gwt');
    const boreholeNoInput = document.getElementById('spt-borehole-no');
    if (gwtInput && boreholeNoInput) {
        const bhId = boreholeNoInput.value;
        const gwtValue = parseFloat(gwtInput.value) || 3.0;
        if (bhId) {
            if (!sptBoreholeData[bhId]) {
                sptBoreholeData[bhId] = {};
            }
            sptBoreholeData[bhId].gwt = gwtValue;
        }
    }
}

//  SPT Borehole  Design GWL
function updateCurrentSPTDesignGWT() {
    const gwtInput = document.getElementById('spt-gwt-design');
    const boreholeNoInput = document.getElementById('spt-borehole-no');
    if (gwtInput && boreholeNoInput) {
        const bhId = boreholeNoInput.value;
        const gwtValue = parseFloat(gwtInput.value) || 3.0;
        if (bhId) {
            if (!sptBoreholeData[bhId]) {
                sptBoreholeData[bhId] = {};
            }
            sptBoreholeData[bhId].gwtDesign = gwtValue;
        }
    }
}

// ==========================================
//  CPT Sounding  GWT
// ==========================================
function updateCurrentCPTGWT() {
    const gwtInput = document.getElementById('cpt-gwt');
    const soundingNoInput = document.getElementById('cpt-sounding-no');
    if (gwtInput && soundingNoInput) {
        const cptId = soundingNoInput.value;
        const gwtValue = parseFloat(gwtInput.value) || 3.0;
        if (cptId) {
            if (!cptBoreholeData[cptId]) {
                cptBoreholeData[cptId] = {};
            }
            cptBoreholeData[cptId].gwt = gwtValue;
        }
    }
}

//  CPT Sounding  Design GWL
function updateCurrentCPTDesignGWT() {
    const gwtInput = document.getElementById('cpt-gwt-design');
    const soundingNoInput = document.getElementById('cpt-sounding-no');
    if (gwtInput && soundingNoInput) {
        const cptId = soundingNoInput.value;
        const gwtValue = parseFloat(gwtInput.value) || 3.0;
        if (cptId) {
            if (!cptBoreholeData[cptId]) {
                cptBoreholeData[cptId] = {};
            }
            cptBoreholeData[cptId].gwtDesign = gwtValue;
        }
    }
}

// ==========================================
//  CPT Sounding （Net Area Ratio  Gamma Method）
// ==========================================
function updateCurrentCPTParams(cptId) {
    if (!cptId) {
        const soundingNoInput = document.getElementById('cpt-sounding-no');
        if (soundingNoInput) {
            cptId = soundingNoInput.value;
        }
    }
    if (cptId) {
        const netAreaRatioInput = document.getElementById(`cpt-net-area-ratio-${cptId}`);
        const gammaMethodSelect = document.getElementById(`cpt-gamma-method-${cptId}`);
        if (!cptBoreholeData[cptId]) {
            cptBoreholeData[cptId] = {};
        }
        if (netAreaRatioInput) {
            cptBoreholeData[cptId].netAreaRatio = parseFloat(netAreaRatioInput.value) || 0.8;
        }
        if (gammaMethodSelect) {
            cptBoreholeData[cptId].gammaMethod = gammaMethodSelect.value || 'robertson';
        }
    }
}

// ==========================================
// Excel 
// ==========================================
// ==========================================
// Excel （， SPT  CPT ）
// ==========================================
function setupExcelPasteSupportForTable(tableSelector) {
    const table = document.querySelector(tableSelector);
    if (!table) {
        console.warn(`Table not found: ${tableSelector}`);
        return;
    }
    
    // （）
    if (table.hasAttribute('data-paste-enabled')) {
        return;
    }
    table.setAttribute('data-paste-enabled', 'true');
    
    // 
    table.addEventListener('paste', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // 
        const pasteData = (e.clipboardData || window.clipboardData).getData('text');
        if (!pasteData || !pasteData.trim()) {
            return;
        }
        
        // （ Tab ）
        const rows = pasteData.split('\n').filter(row => row.trim());
        if (rows.length === 0) {
            return;
        }
        
        // 
        const activeElement = document.activeElement;
        if (!activeElement) {
            return;
        }
        
        // 
        const startRow = activeElement.closest('tr');
        const tbody = table.querySelector('tbody');
        if (!tbody || !startRow) {
            return;
        }
        
        // 
        const startRowIndex = Array.from(tbody.children).indexOf(startRow);
        const startCell = activeElement.closest('td');
        if (!startCell) {
            return;
        }
        const startColIndex = Array.from(startRow.children).indexOf(startCell);
        
        //  SPT  CPT 
        const isSPTTable = table.classList.contains('spt-data-table');
        const isCPTTable = table.classList.contains('cpt-data-table');
        
        // 
        rows.forEach((rowData, rowOffset) => {
            const cells = rowData.split('\t').map(cell => cell.trim());
            
            // 
            let currentRow = tbody.children[startRowIndex + rowOffset];
            if (!currentRow) {
                // 
                if (isSPTTable) {
                    const bhId = table.getAttribute('data-bh-id');
                    if (bhId) {
                        addSPTRow(bhId);
                        currentRow = tbody.children[tbody.children.length - 1];
                    }
                } else if (isCPTTable) {
                    const cptId = table.getAttribute('data-cpt-id');
                    if (cptId) {
                        addCPTRow(cptId);
                        currentRow = tbody.children[tbody.children.length - 1];
                    }
                }
                if (!currentRow) {
                    return; // ，
                }
            }
            
            // 
            cells.forEach((cellValue, colOffset) => {
                const colIndex = startColIndex + colOffset;
                if (colIndex < currentRow.children.length) {
                    const cell = currentRow.children[colIndex];
                    const input = cell.querySelector('input');
                    const select = cell.querySelector('select');
                    
                    if (input) {
                        // 
                        if (input.type === 'number') {
                            const value = parseFloat(cellValue);
                            input.value = isNaN(value) ? '' : value;
                        } else {
                            // 
                            input.value = cellValue;
                        }
                        //  change 
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (select) {
                        // 
                        const option = Array.from(select.options).find(opt => 
                            opt.value.toLowerCase() === cellValue.toLowerCase() || 
                            opt.text.toLowerCase() === cellValue.toLowerCase()
                        );
                        if (option) {
                            select.value = option.value;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                }
            });
        });
        
        // 
        const lastRowIndex = startRowIndex + rows.length - 1;
        const maxCols = Math.max(...rows.map(r => r.split('\t').length));
        const lastColIndex = Math.min(startColIndex + maxCols - 1, 
            tbody.children[lastRowIndex] ? tbody.children[lastRowIndex].children.length - 1 : 0);
        
        if (tbody.children[lastRowIndex] && tbody.children[lastRowIndex].children[lastColIndex]) {
            const lastCell = tbody.children[lastRowIndex].children[lastColIndex];
            const lastInput = lastCell.querySelector('input');
            const lastSelect = lastCell.querySelector('select');
            if (lastInput) {
                setTimeout(() => lastInput.focus(), 10);
            } else if (lastSelect) {
                setTimeout(() => lastSelect.focus(), 10);
            }
        }
    });
    
    // （contenteditable  input ）
    // 
    table.setAttribute('tabindex', '0');
    
    // ，，
    table.addEventListener('click', function(e) {
        // （），
        if (e.target === table || e.target.tagName === 'TD') {
            const firstInput = table.querySelector('tbody input, tbody select');
            if (firstInput) {
                firstInput.focus();
            }
        }
    });
    
    // 
    const inputs = table.querySelectorAll('input, select');
    inputs.forEach(input => {
        input.setAttribute('tabindex', '0');
    });
}

function setupExcelPasteSupport() {
    // ，
    const table = document.getElementById('cpt-data-table');
    if (!table) return;
    setupExcelPasteSupportForTable('#cpt-data-table');
}

// ==========================================
// CPT 
// ==========================================
let cptFileData = null;
let cptFileColumns = [];

function handleCPTFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const fileNameSpan = document.getElementById('cpt-file-name');
    if (fileNameSpan) {
        fileNameSpan.textContent = file.name;
        fileNameSpan.style.color = '#388e3c';
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const text = e.target.result;
            const lines = text.split('\n').filter(line => line.trim());
            
            //  10 
            const previewLines = lines.slice(0, Math.min(10, lines.length));
            
            // （）
            let delimiter = ',';
            if (text.includes('\t')) delimiter = '\t';
            else if (text.includes(';')) delimiter = ';';
            
            // 
            const headerLine = previewLines[0];
            const headers = headerLine.split(delimiter).map(h => h.trim());
            
            cptFileColumns = headers;
            cptFileData = {
                file: file,
                content: text,
                delimiter: delimiter,
                headers: headers,
                preview: previewLines.slice(1, 6), //  5 
                allLines: lines
            };
            
            // 
            showCPTColumnMapping(headers, previewLines.slice(1, 6), delimiter);
            
        } catch (error) {
            console.error('Error reading CPT file:', error);
            alert('Error reading file: ' + error.message);
        }
    };
    
    reader.readAsText(file);
}

// ==========================================
//  CPT 
// ==========================================
function showCPTColumnMapping(headers, previewRows, delimiter) {
    const mappingContainer = document.getElementById('cpt-mapping-container');
    const mappingDiv = document.getElementById('cpt-column-mapping');
    
    if (!mappingContainer || !mappingDiv) return;
    
    // 
    const requiredFields = [
        { key: 'depth', label: 'Depth (m)', required: true },
        { key: 'qc', label: 'Cone Resistance (qc)', required: true, unit: true },
        { key: 'fs', label: 'Sleeve Friction (fs)', required: true, unit: true },
        { key: 'u2', label: 'Pore Pressure u₂ (optional)', required: false, unit: true }
    ];
    
    let mappingHTML = '<div style="grid-column: 1 / -1; margin-bottom: 10px;"><strong>Preview (first 5 rows):</strong></div>';
    
    // 
    mappingHTML += '<div style="grid-column: 1 / -1; overflow-x: auto; margin-bottom: 15px;">';
    mappingHTML += '<table style="width: 100%; border-collapse: collapse; font-size: 11px; background-color: white;">';
    mappingHTML += '<thead><tr>';
    headers.forEach((h, i) => {
        mappingHTML += `<th style="padding: 5px; border: 1px solid #e2e8f0; background-color: #f0f0f0;">Column ${String.fromCharCode(65 + i)}<br>${h}</th>`;
    });
    mappingHTML += '</tr></thead><tbody>';
    
    previewRows.forEach(row => {
        const values = row.split(delimiter);
        mappingHTML += '<tr>';
        values.forEach(val => {
            mappingHTML += `<td style="padding: 5px; border: 1px solid #e2e8f0;">${val.trim()}</td>`;
        });
        mappingHTML += '</tr>';
    });
    mappingHTML += '</tbody></table></div>';
    
    // 
    requiredFields.forEach(field => {
        mappingHTML += `
            <div style="padding: 10px; background-color: white; border-radius: 6px; border: 1px solid #e2e8f0;">
                <label style="font-weight: bold; display: block; margin-bottom: 5px;">
                    ${field.label} ${field.required ? '<span style="color: red;">*</span>' : ''}
                </label>
                <select id="map-${field.key}" style="width: 100%; padding: 5px; border-radius: 4px; border: 1px solid #e2e8f0;" required="${field.required}">
                    <option value="">-- Select Column --</option>
                    ${headers.map((h, i) => `<option value="${i}">Column ${String.fromCharCode(65 + i)}: ${h}</option>`).join('')}
                </select>
                ${field.unit ? `
                    <select id="unit-${field.key}" style="width: 100%; margin-top: 5px; padding: 5px; border-radius: 4px; border: 1px solid #e2e8f0;">
                        <option value="kPa">kPa</option>
                        <option value="MPa">MPa</option>
                        <option value="psi">psi</option>
                        <option value="tsf">tsf</option>
                    </select>
                ` : ''}
            </div>
        `;
    });
    
    mappingDiv.innerHTML = mappingHTML;
    mappingContainer.style.display = 'block';
}

// ==========================================
//  CPT 
// ==========================================
function processCPTMapping() {
    if (!cptFileData) {
        alert('Please upload a CPT file first');
        return;
    }
    
    // 
    const mapping = {
        depth: { column: document.getElementById('map-depth')?.value, unit: 'm' },
        qc: { column: document.getElementById('map-qc')?.value, unit: document.getElementById('unit-qc')?.value || 'kPa' },
        fs: { column: document.getElementById('map-fs')?.value, unit: document.getElementById('unit-fs')?.value || 'kPa' },
        u2: { column: document.getElementById('map-u2')?.value, unit: document.getElementById('unit-u2')?.value || 'kPa' }
    };
    
    // 
    if (!mapping.depth.column || !mapping.qc.column || !mapping.fs.column) {
        alert('Please map all required fields (Depth, qc, fs)');
        return;
    }
    
    // 
    const lines = cptFileData.allLines;
    const delimiter = cptFileData.delimiter;
    const processedData = [];
    
    // ，
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(delimiter).map(v => v.trim());
        
        if (values.length < Math.max(mapping.depth.column, mapping.qc.column, mapping.fs.column)) {
            continue; // 
        }
        
        const depth = parseFloat(values[mapping.depth.column]);
        const qc_raw = parseFloat(values[mapping.qc.column]);
        const fs_raw = parseFloat(values[mapping.fs.column]);
        const u2_raw = mapping.u2.column ? parseFloat(values[mapping.u2.column]) : null;
        
        if (isNaN(depth) || isNaN(qc_raw) || isNaN(fs_raw)) {
            continue; // 
        }
        
        // （ kPa  m）
        const qc = convertToKPa(qc_raw, mapping.qc.unit);
        const fs = convertToKPa(fs_raw, mapping.fs.unit);
        const u2 = u2_raw ? convertToKPa(u2_raw, mapping.u2.unit) : null;
        
        processedData.push({
            depth: depth,
            qc: qc,
            fs: fs,
            u2: u2
        });
    }
    
    // 
    cptFileData.processedData = processedData;
    cptFileData.mapping = mapping;
    
    // 
    alert(`Successfully processed ${processedData.length} data points from CPT file.`);
    
    // 
    displayCPTDataPreview(processedData);
}

// ==========================================
// 
// ==========================================
function convertToKPa(value, unit) {
    const conversions = {
        'kPa': 1,
        'MPa': 1000,
        'psi': 6.89476,
        'tsf': 95.76
    };
    return value * (conversions[unit] || 1);
}

// ==========================================
//  CPT 
// ==========================================
function displayCPTDataPreview(data) {
    // 
    // 
    const depths = data.map(d => d.depth);
    const qcValues = data.map(d => d.qc);
    const fsValues = data.map(d => d.fs);
    
    console.log('CPT Data Summary:');
    console.log(`Depth range: ${Math.min(...depths).toFixed(2)} - ${Math.max(...depths).toFixed(2)} m`);
    console.log(`qc range: ${Math.min(...qcValues).toFixed(0)} - ${Math.max(...qcValues).toFixed(0)} kPa`);
    console.log(`fs range: ${Math.min(...fsValues).toFixed(0)} - ${Math.max(...fsValues).toFixed(0)} kPa`);
}

// ==========================================
// 4.  ( - Tab )
// ==========================================
function generateBoreholeTables() {
    // 1. 
    const selectElement = document.getElementById('num-holes-select');
    if (!selectElement) return;

    const numHoles = parseInt(selectElement.value);

    // 2. 
    const tabsContainer = document.getElementById('borehole-tabs');
    const contentContainer = document.getElementById('dynamic-borehole-container');
    if (!tabsContainer || !contentContainer) return;

    // 3. 
    tabsContainer.innerHTML = '';
    contentContainer.innerHTML = '';

    // 4.  "" (SPT depth in ft)
    const M_TO_FT_DEFAULT = 3.28084;
    const defaultStartDepthsM = [1.05, 2.55, 4.05, 5.55, 7.05, 8.55, 10.05, 11.55, 13.05, 14.55, 16.05, 17.55, 19.05];
    const defaultEndDepthsM = [1.50, 3.00, 4.50, 6.00, 7.50, 9.00, 10.50, 12.00, 13.50, 15.00, 16.50, 18.00, 19.50];
    const defaultStartDepths = defaultStartDepthsM.map(m => m * M_TO_FT_DEFAULT);
    const defaultEndDepths = defaultEndDepthsM.map(m => m * M_TO_FT_DEFAULT);
    // γt (pcf) - convert from tf/m³: 1 tf/m³ ≈ 62.428 pcf
    const TF_M3_TO_PCF_DEFAULT = 62.428;
    const defaultGamma_tf = [1.79, 1.90, 1.98, 2.02, 1.93, 1.86, 1.78, 1.86, 1.95, 1.73, 2.04, 1.86, 1.94];
    // SPT-N - 
    const defaultSPT_N = [29, 14, 6, 19, 13, 11, 7, 12, 17, 15, 13, 13, 10];
    // PI (%) - NP 
    const defaultPI = ['NP', 'NP', 'NP', 'NP', 'NP', 'NP', 'NP', 'NP', 'NP', 'NP', 'NP', 'NP', '5'];
    // FC (%) - 
    const defaultFC = [19, 72, 35, 18, 23, 80, 93, 90, 96, 55, 78, 69, 86];
    //  - 
    const defaultSoilClass = ['SM', 'ML', 'SM', 'SM', 'SM', 'ML', 'ML', 'ML', 'ML', 'ML', 'ML', 'ML', 'ML'];
    
    // 5.  Tab 
    for (let k = 1; k <= numHoles; k++) {
        const bhId = `BH-${k}`;
        
        //  Tab （ × ， CPT ）
        const tab = document.createElement('div');
        tab.className = 'borehole-tab';
        tab.id = `tab-${bhId}`;
        tab.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 10px 20px;
            cursor: pointer;
            border: 1px solid rgba(0, 217, 255, 0.22);
            border-bottom: none;
            background-color: ${k === 1 ? 'rgba(0, 217, 255, 0.18)' : 'var(--card-bg)'};
            color: ${k === 1 ? 'var(--text-primary)' : 'var(--text-secondary)'};
            border-radius: 5px 5px 0 0;
            font-weight: ${k === 1 ? 'bold' : 'normal'};
            transition: all 0.3s;
        `;
        const labelSpan = document.createElement('span');
        labelSpan.textContent = bhId;
        labelSpan.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', `Remove ${bhId}`);
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            background: transparent; border: none; color: inherit; cursor: pointer;
            font-size: 16px; line-height: 1; padding: 0 2px; opacity: 0.85;
        `;
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeBoreholeTab(bhId);
        });
        tab.appendChild(labelSpan);
        tab.appendChild(closeBtn);
        tab.onclick = (ev) => { if (!ev.target.closest('button')) switchBoreholeTab(bhId); };
        tabsContainer.appendChild(tab);
        
        //  HTML
    let tableRowsHTML = '';
    const numRows = defaultEndDepths.length; // （13）
    for (let i = 0; i < numRows; i++) {
            const startDepth = defaultStartDepths[i].toFixed(2);
            const endDepth = defaultEndDepths[i].toFixed(2);
            const gamma_pcf = (defaultGamma_tf[i] * TF_M3_TO_PCF_DEFAULT).toFixed(2); // SPT table unit weight is pcf
            const spt_n = defaultSPT_N[i];
            const fc = defaultFC[i];
            const soilClass = defaultSoilClass[i];
            const pi_value = defaultPI[i]; //  PI 

        tableRowsHTML += `
            <tr>
                <td><input type="text" value="${startDepth} - ${endDepth}"></td>
                <td><input type="number" step="0.1" value="${gamma_pcf}"></td>
                <td><input type="number" step="1" value="${spt_n}"></td>
                <td><input type="text" value="${pi_value}"></td>
                <td><input type="number" step="1" value="${fc}"></td>
                <td><input type="text" value="${soilClass}"></td>
                    <td>
                    <select>
                        <option value="N" selected>N</option>
                        <option value="Y">Y</option>
                    </select>
                </td>
                <td>
                    <select>
                        <option value="Y" selected>Y</option>
                        <option value="N">N</option>
                    </select>
                </td>
            </tr>
        `;
    }

    // Add a "+ tab" button (browser-style) to create a new borehole tab on demand.
    // This uses findOrCreateBoreholeTab so it won't wipe existing data.
    (function ensureSptAddButton() {
        if (tabsContainer.querySelector('#spt-add-tab-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'spt-add-tab-btn';
        btn.type = 'button';
        btn.textContent = '+';
        btn.title = 'Add a new borehole';
        btn.style.cssText = `
            padding: 10px 16px;
            border-radius: 5px 5px 0 0;
            border: 1px solid rgba(0, 217, 255, 0.22);
            border-bottom: none;
            background-color: var(--card-bg);
            color: var(--text-primary);
            cursor: pointer;
            font-weight: 800;
            font-size: 16px;
            line-height: 1;
        `;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Find next available BH-<n>
            const existingNums = Array.from(document.querySelectorAll('#borehole-tabs .borehole-tab'))
                .map(t => t.id.replace('tab-', ''))
                .filter(id => /^BH-\d+$/.test(id))
                .map(id => parseInt(id.split('-')[1], 10))
                .filter(n => isFinite(n));
            const nextN = (existingNums.length ? Math.max(...existingNums) : 0) + 1;
            const nextId = String(nextN);
            findOrCreateBoreholeTab(nextId, `BH-${nextN}`, 'SPT');
        });
        tabsContainer.appendChild(btn);
    })();

        //  Tab 
        const tabContent = document.createElement('div');
        tabContent.className = 'borehole-section';
        tabContent.id = `content-${bhId}`;
        tabContent.style.cssText = `
            display: ${k === 1 ? 'block' : 'none'};
            position: relative;
        `;
        
        tabContent.innerHTML = `
            <div style="margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <label style="font-weight: bold; font-size: 13px; color: var(--primary-color); text-shadow: 0 0 5px var(--glow-color);">SPT Data Input (Copy & Paste from Excel)</label>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" class="btn-add-row" onclick="addSPTRow('${bhId}')">
                            <i class="material-icons">add</i> Add Row
                        </button>
                        <button type="button" class="btn-clear-table" onclick="clearSPTTable('${bhId}')">
                            <i class="material-icons">clear</i> Clear
                        </button>
                    </div>
                </div>
                
                <!-- SPT Data Table with Scroll -->
                <div style="border: 1px solid rgba(0, 217, 255, 0.3); border-radius: 6px; overflow: hidden; background-color: var(--card-bg);">
                    <div style="max-height: 400px; overflow-y: auto; overflow-x: auto;">
                        <table class="spt-data-table data-table" data-bh-id="${bhId}">
                    <thead>
                        <tr>
                                    <th style="min-width: 90px;">Depth (ft)</th>
                                    <th style="min-width: 80px;">γt (pcf)</th>
                                    <th style="min-width: 70px;">SPT-N</th>
                                    <th style="min-width: 70px;">PI (%)</th>
                                    <th style="min-width: 70px;">FC (%)</th>
                                    <th style="min-width: 80px;">Soil Class</th>
                                    <th style="min-width: 70px;">Gravelly?</th>
                                    <th style="min-width: 70px;">Analyze</th>
                        </tr>
                    </thead>
                            <tbody id="spt-table-body-${bhId}">
                        ${tableRowsHTML}
                    </tbody>
                </table>
                </div>
                    </div>
                <small style="color: #666; font-size: 11px; display: block; margin-top: 5px;">
                    <i class="material-icons" style="font-size: 12px; vertical-align: middle;">info</i>
                    Tip: Select cells in Excel and paste (Ctrl+V / Cmd+V) directly into the table. The table will automatically add rows as needed.
                </small>
                        </div>
            
        `;
        
        contentContainer.appendChild(tabContent);
        
        //  borehole 
        if (!sptBoreholeData[bhId]) {
            sptBoreholeData[bhId] = { gwt: 3.0, gwtDesign: 3.0 };
        }
    }
    
    // （ borehole）
    const boreholeNoInput = document.getElementById('spt-borehole-no');
    const gwtInput = document.getElementById('spt-gwt');
    const gwtDesignInput = document.getElementById('spt-gwt-design');
    if (boreholeNoInput && numHoles > 0) {
        boreholeNoInput.value = 'BH-1';
    }
    if (gwtInput && numHoles > 0) {
        gwtInput.value = sptBoreholeData['BH-1']?.gwt || 3.0;
    }
    if (gwtDesignInput && numHoles > 0) {
        gwtDesignInput.value = sptBoreholeData['BH-1']?.gwtDesign ?? sptBoreholeData['BH-1']?.gwt ?? 3.0;
    }
    
    //  SPT  Excel 
    setTimeout(() => {
        const sptTables = document.querySelectorAll('.spt-data-table');
        sptTables.forEach(table => {
            const bhId = table.getAttribute('data-bh-id');
            if (bhId) {
                setupExcelPasteSupportForTable(`.spt-data-table[data-bh-id="${bhId}"]`);
            }
        });
    }, 100);
}

// ==========================================
// SPT 
// ==========================================
function addSPTRow(bhId) {
    const tbody = document.getElementById(`spt-table-body-${bhId}`);
    if (!tbody) return;
    
    const row = document.createElement('tr');
    row.innerHTML = `
        <td><input type="text" placeholder="0.00 - 1.00"></td>
        <td><input type="number" step="0.1"></td>
        <td><input type="number" step="1"></td>
        <td><input type="text" placeholder="NP"></td>
        <td><input type="number" step="1"></td>
        <td><input type="text" placeholder="SM"></td>
        <td>
            <select>
                <option value="N" selected>N</option>
                <option value="Y">Y</option>
            </select>
        </td>
        <td>
            <select>
                <option value="Y" selected>Y</option>
                <option value="N">N</option>
            </select>
        </td>
    `;
    tbody.appendChild(row);
}

function clearSPTTable(bhId) {
    const tbody = document.getElementById(`spt-table-body-${bhId}`);
    if (!tbody) return;
    
    if (confirm('Are you sure you want to clear all SPT data for ' + bhId + '?')) {
        tbody.innerHTML = '';
        addSPTRow(bhId); // 
    }
}

// ==========================================
// Tab 
// ==========================================
//  borehole  GWT 
const sptBoreholeData = {};
const cptBoreholeData = {};

function removeBoreholeTab(bhId) {
    const tabEl = document.getElementById(`tab-${bhId}`);
    const contentEl = document.getElementById(`content-${bhId}`);
    if (!tabEl && !contentEl) return;

    const ok = confirm(`Remove SPT tab "${bhId}"? This will delete the table rows for this borehole.`);
    if (!ok) return;

    try { if (tabEl) tabEl.remove(); } catch (_) {}
    try { if (contentEl) contentEl.remove(); } catch (_) {}
    try { if (sptBoreholeData && sptBoreholeData[bhId]) delete sptBoreholeData[bhId]; } catch (_) {}

    const tabsContainer = document.getElementById('borehole-tabs');
    const remainingTabs = tabsContainer ? Array.from(tabsContainer.querySelectorAll('.borehole-tab')).filter(t => t.id && t.id.startsWith('tab-BH-')) : [];

    if (remainingTabs.length > 0) {
        const nextId = remainingTabs[0].id.replace('tab-', '');
        switchBoreholeTab(nextId);
    } else {
        generateBoreholeTables();
        switchBoreholeTab('BH-1');
    }
}

function switchBoreholeTab(bhId) {
    //  borehole  GWT （）
    const currentGwtInput = document.getElementById('spt-gwt');
    const currentGwtDesignInput = document.getElementById('spt-gwt-design');
    if (currentGwtInput) {
        const currentActiveTab = document.querySelector('.borehole-tab[style*="background-color: rgb(74, 144, 226)"]') || 
                                  document.querySelector('.borehole-tab[style*="#4a90e2"]');
        if (currentActiveTab) {
            const currentBhId = currentActiveTab.id.replace('tab-', '');
            if (currentBhId && currentBhId !== bhId) {
                sptBoreholeData[currentBhId] = {
                    gwt: parseFloat(currentGwtInput.value) || 3.0,
                    gwtDesign: currentGwtDesignInput ? (parseFloat(currentGwtDesignInput.value) || (parseFloat(currentGwtInput.value) || 3.0)) : (parseFloat(currentGwtInput.value) || 3.0)
                };
            }
        }
    }
    
    //  tab 
    const allContents = document.querySelectorAll('.borehole-section');
    allContents.forEach(content => {
        content.style.display = 'none';
    });
    
    //  tab 
    const allTabs = document.querySelectorAll('.borehole-tab');
    allTabs.forEach(tab => {
        tab.style.backgroundColor = '#f0f0f0';
        tab.style.color = '#333';
        tab.style.fontWeight = 'normal';
    });
    
    //  tab 
    const selectedContent = document.getElementById(`content-${bhId}`);
    if (selectedContent) {
        selectedContent.style.display = 'block';
    }
    
    //  tab
    const selectedTab = document.getElementById(`tab-${bhId}`);
    if (selectedTab) {
        selectedTab.style.backgroundColor = '#4a90e2';
        selectedTab.style.color = 'white';
        selectedTab.style.fontWeight = 'bold';
    }
    
    //  Borehole No.  GWT
    const boreholeNoInput = document.getElementById('spt-borehole-no');
    const gwtInput = document.getElementById('spt-gwt');
    const gwtDesignInput = document.getElementById('spt-gwt-design');
    if (boreholeNoInput) boreholeNoInput.value = bhId;
    if (gwtInput) {
        //  borehole  GWT， 3.0
        const savedGwt = sptBoreholeData[bhId]?.gwt || 3.0;
        gwtInput.value = savedGwt;
    }
    if (gwtDesignInput) {
        const savedGwtDesign = sptBoreholeData[bhId]?.gwtDesign ?? sptBoreholeData[bhId]?.gwt ?? 3.0;
        gwtDesignInput.value = savedGwtDesign;
    }
}

// 
function positionPanel() {
    const panel = document.getElementById('infoPanel');
    const btn = document.querySelector('.info-btn');
    
    if (!panel || !btn) return;
    
    const btnRect = btn.getBoundingClientRect();
    const panelWidth = 450; // 
    const spacing = 10; // 
    
    // ：
    let left = btnRect.right + spacing;
    let top = btnRect.top;
    
    // ，
    if (left + panelWidth > window.innerWidth) {
        left = btnRect.left - panelWidth - spacing;
    }
    
    // ，
    if (left < 0) {
        left = (window.innerWidth - panelWidth) / 2;
    }
    
    // 
    if (top < 10) {
        top = 10;
    }
    
    // 
    const panelHeight = panel.offsetHeight || 400; // 
    if (top + panelHeight > window.innerHeight - 10) {
        top = window.innerHeight - panelHeight - 10;
    }
    
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.transform = 'none'; // 
}

// （Calculation Points）
function togglePanel() {
    const panel = document.getElementById('infoPanel');
    
    if (panel.style.display === "block") {
        panel.style.display = "none";
    } else {
        // ，
        positionPanel();
        panel.style.display = "block";
    }
}

//  Site Class 
function toggleSiteClassPanel(clickedBtn) {
    const panel = document.getElementById('siteClassPanel');
    
    if (!panel) {
        console.error(' siteClassPanel ');
        return;
    }
    
    // ， Site Class 
    let btn = clickedBtn;
    if (!btn) {
        const siteClassBtns = document.querySelectorAll('.site-class-info-btn');
        btn = siteClassBtns.length > 0 ? siteClassBtns[0] : null;
    }
    
    if (panel.style.display === "block") {
        panel.style.display = "none";
    } else {
        // ，
        if (btn) {
            positionSiteClassPanel(btn);
        } else {
            // ，
            panel.style.left = '50%';
            panel.style.top = '50%';
            panel.style.transform = 'translate(-50%, -50%)';
        }
        panel.style.display = "block";
    }
}

//  Site Class 
function positionSiteClassPanel(btn) {
    const panel = document.getElementById('siteClassPanel');
    
    if (!panel || !btn) return;
    
    const btnRect = btn.getBoundingClientRect();
    const margin = 12;
    const spacing = 10;
    const wasHidden = window.getComputedStyle(panel).display === 'none';
    const prevVisibility = panel.style.visibility;
    const prevDisplay = panel.style.display;

    // Measure real size even when panel is hidden.
    if (wasHidden) {
        panel.style.visibility = 'hidden';
        panel.style.display = 'block';
    }

    const measuredRect = panel.getBoundingClientRect();
    const panelWidth = Math.min(measuredRect.width || 420, window.innerWidth - margin * 2);
    const panelHeight = Math.min(measuredRect.height || 420, window.innerHeight - margin * 2);
    
    // ：
    let left = btnRect.right + spacing;
    let top = btnRect.top;
    
    // ，
    if (left + panelWidth > window.innerWidth - margin) {
        left = btnRect.left - panelWidth - spacing;
    }
    
    // Clamp to viewport.
    if (left < margin) left = margin;
    
    if (top + panelHeight > window.innerHeight - margin) {
        top = window.innerHeight - panelHeight - margin;
    }
    if (top < margin) top = margin;
    
    // Restore hidden state for toggle logic.
    if (wasHidden) {
        panel.style.display = prevDisplay || 'none';
        panel.style.visibility = prevVisibility || '';
    }
    
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.transform = 'none';
}
// ： ()
document.addEventListener('mousedown', function(event) {
    // Calculation Points 
    const panel = document.getElementById('infoPanel');
    const btn = document.querySelector('.info-btn');
    if (panel && panel.style.display === 'block') {
        // ，（），
        if (!panel.contains(event.target) && !event.target.closest('.info-btn')) {
            panel.style.display = 'none';
        }
    }
    
    // Site Class 
    const siteClassPanel = document.getElementById('siteClassPanel');
    const siteClassBtns = document.querySelectorAll('.site-class-info-btn');
    if (siteClassPanel && siteClassPanel.style.display === 'block') {
        //  Site Class  info-btn
        let clickedBtn = false;
        for (let btn of siteClassBtns) {
            if (event.target === btn || btn.contains(event.target)) {
                clickedBtn = true;
                break;
            }
        }
        // ， Site Class  info-btn，
        if (!siteClassPanel.contains(event.target) && !clickedBtn) {
            siteClassPanel.style.display = 'none';
        }
    }
});

// ，（）
window.addEventListener('resize', function() {
    const panel = document.getElementById('infoPanel');
    if (panel && panel.style.display === 'block') {
        positionPanel(); // ，
    }
    const siteClassPanel = document.getElementById('siteClassPanel');
    if (siteClassPanel && siteClassPanel.style.display === 'block') {
        const siteClassBtns = document.querySelectorAll('.site-class-info-btn');
        const btn = siteClassBtns.length > 0 ? siteClassBtns[0] : null;
        if (btn) positionSiteClassPanel(btn);
    }
    // ，
    if (map) {
        setTimeout(() => {
            map.invalidateSize();
        }, 100);
    }
});

// ==========================================
// 
// ==========================================

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function setGeosettaStatus(message, type = 'info') {
    const el = document.getElementById('geosetta-status');
    if (!el) return;
    if (!message) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = 'block';
    el.textContent = message;
    // Yellow for cluster/bubble status; green for other success; cyan for info
    const isClusterMsg = typeof message === 'string' && message.includes('bubble');
    el.style.borderRadius = '8px';
    el.style.borderStyle = 'solid';
    el.style.borderWidth = '1px';
    el.style.borderColor = type === 'error' ? 'rgba(244,67,54,0.45)' : isClusterMsg ? 'rgba(255, 193, 7, 0.5)' : type === 'success' ? 'rgba(255, 193, 7, 0.35)' : 'rgba(0,217,255,0.25)';
    el.style.background = type === 'error' ? 'rgba(244,67,54,0.10)' : isClusterMsg ? 'rgba(255, 193, 7, 0.18)' : type === 'success' ? 'rgba(255, 193, 7, 0.10)' : 'rgba(0,217,255,0.06)';
    el.style.color = isClusterMsg ? '#b38600' : 'var(--text-secondary)';
}

function updateDiggsStatistics(summary) {
    const bar = document.getElementById('diggs-stats-filter-bar');
    if (!bar) return;
    
    const total = summary.map_points || 0;
    
    // Count boreholes with CPT/SPT and build lists
    let withCpt = 0;
    let withSpt = 0;
    diggsBoreholeList = { cpt: [], spt: [] };
    
    diggsAllFeatures.forEach(f => {
        const p = f.properties || {};
        const id = p.id || f.id || '';
        const name = p.name || p.title || id || 'Unknown';
        const cptCount = Number(p.cpt_count || 0);
        const sptCount = Number(p.spt_count || 0);
        
        if (cptCount > 0) {
            withCpt++;
            diggsBoreholeList.cpt.push({
                id: id,
                name: name,
                feature_type: p.feature_type || '',
                cpt_count: cptCount,
                feature: f
            });
        }
        if (sptCount > 0) {
            withSpt++;
            diggsBoreholeList.spt.push({
                id: id,
                name: name,
                feature_type: p.feature_type || '',
                spt_count: sptCount,
                feature: f
            });
        }
    });
    
    document.getElementById('diggs-stat-total').textContent = total;
    document.getElementById('diggs-stat-cpt').textContent = withCpt;
    document.getElementById('diggs-stat-spt').textContent = withSpt;
    
    bar.style.display = 'block';
    
    // Show test selection bar
    const testBar = document.getElementById('diggs-test-selection-bar');
    if (testBar) {
        testBar.style.display = 'block';
    }
    
    // Update borehole dropdown when test type changes
    updateDiggsBoreholeDropdown();
}

function updateDiggsBoreholeDropdown() {
    const testTypeSelect = document.getElementById('diggs-test-type-select');
    const boreholeSelect = document.getElementById('diggs-borehole-select');
    
    if (!testTypeSelect || !boreholeSelect) return;
    
    const testType = testTypeSelect.value;
    boreholeSelect.innerHTML = '<option value="" style="color: #666;">-- Select Borehole --</option>';
    
    if (!testType || !diggsBoreholeList[testType]) {
        return;
    }
    
    const boreholes = diggsBoreholeList[testType];
    boreholes.forEach(bh => {
        const option = document.createElement('option');
        option.value = bh.id;
        option.textContent = `${bh.name} (${bh.feature_type || 'Unknown'}) - ${testType.toUpperCase()}: ${testType === 'cpt' ? bh.cpt_count : bh.spt_count}`;
        option.style.color = '#333';
        boreholeSelect.appendChild(option);
    });
}

//  bar
function updateDiggsMapSelectionBar(summary) {
    const bar = document.getElementById('diggs-test-selection-bar');
    const selectedBoreholeEl = document.getElementById('diggs-map-selected-borehole');
    
    if (!bar || !summary) return;
    
    //  bar
    bar.style.display = 'block';
    
    //  borehole 
    if (selectedBoreholeEl) {
        selectedBoreholeEl.textContent = `${summary.title} (${summary.feature_type})`;
    }
    
    // 
    const testTypeSelect = document.getElementById('diggs-test-type-select');
    if (testTypeSelect) {
        testTypeSelect.innerHTML = '<option value="" style="color: #666;">-- Select Test Type --</option>';
        if (summary.spt_count > 0) {
            testTypeSelect.innerHTML += '<option value="spt" style="color: #333;">SPT</option>';
        }
        if (summary.cpt_count > 0) {
            testTypeSelect.innerHTML += '<option value="cpt" style="color: #333;">CPT</option>';
        }
    }
    
    //  borehole （ borehole）
    const boreholeSelect = document.getElementById('diggs-borehole-select');
    if (boreholeSelect) {
        boreholeSelect.innerHTML = '<option value="" style="color: #666;">-- Select Borehole --</option>';
        const option = document.createElement('option');
        option.value = summary.id;
        option.textContent = `${summary.title} (${summary.feature_type})`;
        option.style.color = '#333';
        option.selected = true;
        boreholeSelect.appendChild(option);
    }
    
    // ，
    if (testTypeSelect) {
        testTypeSelect.onchange = function() {
            updateDiggsTestListForMapBar(summary);
        };
        // 
        updateDiggsTestListForMapBar(summary);
    }
}

//  bar 
function updateDiggsTestListForMapBar(summary) {
    const testTypeSelect = document.getElementById('diggs-test-type-select');
    const testListContainer = document.getElementById('diggs-selected-tests-list');
    const container = document.getElementById('diggs-selected-tests-container');
    
    if (!testTypeSelect || !testListContainer || !summary) return;
    
    const testType = testTypeSelect.value;
    if (!testType) {
        container.style.display = 'none';
        return;
    }
    
    // 
    const xmlFile = 'DIGGS_Student_Hackathon_large.XML';
    const featureId = summary.id;
    const cacheKey = `${xmlFile}::${featureId}`;
    
    //  cache  API 
    const loadTests = (detail) => {
        const tests = testType === 'spt' ? (detail.all_spt_tests || []) : (detail.all_cpt_tests || []);
        
        if (tests.length === 0) {
            container.style.display = 'none';
            return;
        }
        
        container.style.display = 'block';
        testListContainer.innerHTML = '';
        
        tests.forEach((test, idx) => {
            const testId = test.test_id || test.activity_id || test.id || (typeof test === 'string' ? test : `Test ${idx + 1}`);
            const testName = test.name || testId;
            const testKey = `${summary.id}::${testType}::${testId}`;
            const isSelected = diggsSelectedTests.some(t => t.key === testKey);
            
            const testDiv = document.createElement('div');
            testDiv.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(255,255,255,0.5); border-radius: 4px; border: 1px solid rgba(255,193,7,0.3);';
            testDiv.innerHTML = `
                <input type="checkbox" id="test-${testKey}" ${isSelected ? 'checked' : ''} onchange="toggleDiggsTest('${escapeHtml(testKey)}', '${escapeHtml(String(summary.id))}', '${escapeHtml(summary.title)}', '${escapeHtml(testType)}', '${escapeHtml(String(testId))}', '${escapeHtml(String(testName))}')" style="cursor: pointer;">
                <label for="test-${testKey}" style="flex: 1; cursor: pointer; font-size: 12px; color: #333; margin: 0;">${escapeHtml(String(testName))}</label>
            `;
            testListContainer.appendChild(testDiv);
        });
    };
    
    if (diggsDetailCache[cacheKey]) {
        loadTests(diggsDetailCache[cacheKey]);
    } else {
        fetchDiggsBoreholeDetail(featureId, xmlFile).then(loadTests).catch(err => {
            console.error('[DIGGS] Error loading tests:', err);
            container.style.display = 'none';
        });
    }
}

// 
function toggleDiggsTest(testKey, boreholeId, boreholeName, testType, testId, testName) {
    const checkbox = document.getElementById(`test-${testKey}`);
    if (!checkbox) return;
    
    const index = diggsSelectedTests.findIndex(t => t.key === testKey);
    
    if (checkbox.checked) {
        if (index === -1) {
            diggsSelectedTests.push({
                key: testKey,
                boreholeId: boreholeId,
                boreholeName: boreholeName,
                testType: testType,
                testId: testId,
                testName: testName
            });
        }
    } else {
        if (index !== -1) {
            diggsSelectedTests.splice(index, 1);
        }
    }
    
    updateDiggsSelectedTestsDisplay();
}

// 
function updateDiggsSelectedTestsDisplay() {
    // 
    console.log('Selected tests:', diggsSelectedTests);
}

// 
function importAllSelectedDiggsTests() {
    if (diggsSelectedTests.length === 0) {
        alert('Please select at least one test to import.');
        return;
    }
    
    const xmlFile = 'DIGGS_Student_Hackathon_large.XML';
    let importedCount = 0;
    let failedCount = 0;
    
    //  borehole  testType 
    const grouped = {};
    diggsSelectedTests.forEach(test => {
        const key = `${test.boreholeId}::${test.testType}`;
        if (!grouped[key]) {
            grouped[key] = {
                boreholeId: test.boreholeId,
                boreholeName: test.boreholeName,
                testType: test.testType,
                tests: []
            };
        }
        grouped[key].tests.push(test);
    });
    
    // 
    const importPromises = diggsSelectedTests.map(test => {
        return fetch('/api/diggs/test_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                xml_file: xmlFile,
                test_type: test.testType.toLowerCase(),
                test_id: test.testId
            })
        })
        .then(resp => resp.json())
        .then(data => {
            if (data.status === 'success' && data.data) {
                if (test.testType === 'spt') {
                    importSPTData(data.data, test.boreholeId, test.boreholeName);
                } else {
                    importCPTData(data.data, test.boreholeId, test.boreholeName);
                }
                importedCount++;
            } else {
                failedCount++;
            }
        })
        .catch(err => {
            console.error(`[DIGGS] Error importing ${test.testName}:`, err);
            failedCount++;
        });
    });
    
    Promise.all(importPromises).then(() => {
        alert(`Import completed: ${importedCount} successful, ${failedCount} failed.`);
        // 
        diggsSelectedTests = [];
        updateDiggsTestListForMapBar(diggsSelected);
    });
}

function selectDiggsBoreholeFromDropdown() {
    const testTypeSelect = document.getElementById('diggs-test-type-select');
    const boreholeSelect = document.getElementById('diggs-borehole-select');
    
    if (!testTypeSelect || !boreholeSelect) return;
    
    const testType = testTypeSelect.value;
    const boreholeId = boreholeSelect.value;
    
    if (!testType || !boreholeId) {
        // Clear selection, show all
        if (diggsMap && diggsLayer) {
            diggsMap.fitBounds(diggsLayer.getBounds().pad(0.12));
        }
        return;
    }
    
    // Find the feature and zoom to it
    const boreholes = diggsBoreholeList[testType] || [];
    const selectedBorehole = boreholes.find(bh => bh.id === boreholeId);
    
    if (selectedBorehole && selectedBorehole.feature) {
        const coords = selectedBorehole.feature.geometry.coordinates;
        if (coords && coords.length >= 2) {
            diggsMap.setView([coords[1], coords[0]], 15);
            
            // Open popup for this borehole
            setTimeout(() => {
                const layer = diggsLayer.getLayers().find(l => {
                    const f = l.feature;
                    return f && (f.properties?.id === boreholeId || f.id === boreholeId);
                });
                if (layer) {
                    layer.openPopup();
                }
            }, 300);
        }
    }
}

function applyDiggsFilter(features) {
    if (diggsCurrentFilter === 'all') {
        return features;
    } else if (diggsCurrentFilter === 'cpt') {
        return features.filter(f => {
            const p = f.properties || {};
            return Number(p.cpt_count || 0) > 0;
        });
    } else if (diggsCurrentFilter === 'spt') {
        return features.filter(f => {
            const p = f.properties || {};
            return Number(p.spt_count || 0) > 0;
        });
    }
    return features;
}

function applyDiggsFilterToMap() {
    if (!diggsLayer || diggsAllFeatures.length === 0) return;
    
    const filteredFeatures = applyDiggsFilter(diggsAllFeatures);
    // Only remove the rendered layer from the map. Do NOT clear diggsAllFeatures,
    // otherwise subsequent filter toggles (All / With CPT / With SPT) will lose the source data.
    try {
        if (diggsMap && diggsLayer) {
            diggsMap.removeLayer(diggsLayer);
        }
    } catch (_) {}
    diggsLayer = null;
    
    diggsFeatureByKey = {};
    let featureCount = 0;
    
    const filteredGeoJSON = { type: "FeatureCollection", features: filteredFeatures };
    
    diggsLayer = L.geoJSON(filteredGeoJSON, {
        pointToLayer: function(feature, latlng) {
            const p = (feature && feature.properties) ? feature.properties : {};
            const ft = String(p.feature_type || '').toLowerCase();
            const isSounding = ft === 'sounding';
            return L.circleMarker(latlng, {
                radius: isSounding ? 4 : 5,
                color: isSounding ? 'rgba(255, 152, 0, 0.95)' : 'rgba(255, 193, 7, 0.95)',
                weight: 2,
                fillColor: isSounding ? 'rgba(255, 152, 0, 0.65)' : 'rgba(255, 193, 7, 0.65)',
                fillOpacity: 0.85
            });
        },
        onEachFeature: function(feature, layer) {
            const key = getDiggsFeatureKey(feature, featureCount);
            diggsFeatureByKey[key] = feature;
            featureCount++;

            const p = feature.properties || {};
            const title = escapeHtml(p.name || p.title || p.id || 'DIGGS Point');
            const typeText = escapeHtml(p.feature_type || '-');
            const sptCount = Number(p.spt_count || 0);
            const cptCount = Number(p.cpt_count || 0);
            const vsCount = Number(p.vs_count || 0);
            const depthText = p.total_depth ? `${escapeHtml(String(p.total_depth))} ${escapeHtml(String(p.total_depth_uom || ''))}` : '-';
            const projectRef = escapeHtml(String(p.project_ref || '-'));
            const featureId = String(p.id || '');
            const detailDomId = _diggsDetailDomId(key);

            const popupHtml = `
                <div style="min-width: 320px; max-width: 450px;">
                    <div style="font-weight: 800; margin-bottom: 8px; font-size: 14px;">${title}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Type: ${typeText}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Depth: ${depthText}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">SPT count: ${sptCount}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">CPT count: ${cptCount}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 8px;">VS count: ${vsCount}</div>
                    <hr style="margin: 8px 0; border: none; border-top: 1px solid rgba(0,0,0,0.1);">
                    <div id="${detailDomId}" style="font-size: 11px; color:#444; margin-bottom: 10px;">Loading background…</div>
                    <button type="button" class="diggs-select-point-btn" data-diggs-key="${escapeHtml(key)}" style="padding:8px 12px; font-size: 12px; cursor:pointer; width: 100%; margin-top: 8px; background: rgba(255, 193, 7, 0.2); border: 1px solid rgba(255, 193, 7, 0.5); border-radius: 4px;">Select this point</button>
                </div>
            `;
            layer.bindPopup(popupHtml);

            layer.on('popupopen', async function() {
                try {
                    const select = document.getElementById('diggs-xml-select');
                    const xmlFile = select ? select.value : 'DIGGS_Student_Hackathon_large.XML';
                    const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
                    const el = document.getElementById(detailDomId);
                    if (!el) return;
                    
                    // Display project background information
                    const projectInfo = detail.project_info || {};
                    const parts = [];
                    
                    // Project information
                    if (projectInfo.name || projectInfo.description) {
                        parts.push('<div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 193, 7, 0.1); border-radius: 4px; border-left: 3px solid rgba(255, 193, 7, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">Project Information:</div>');
                        if (projectInfo.name) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Name:</strong> ${escapeHtml(projectInfo.name)}</div>`);
                        }
                        if (projectInfo.description) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Description:</strong> ${escapeHtml(projectInfo.description)}</div>`);
                        }
                        if (projectInfo.locality) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Location:</strong> ${escapeHtml(projectInfo.locality)}</div>`);
                        }
                        if (projectInfo.client) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Client:</strong> ${escapeHtml(projectInfo.client)}</div>`);
                        }
                        if (projectInfo.project_engineer) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Engineer:</strong> ${escapeHtml(projectInfo.project_engineer)}</div>`);
                        }
                        if (projectInfo.remark) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Note:</strong> ${escapeHtml(_truncateText(projectInfo.remark, 200))}</div>`);
                        }
                        parts.push('</div>');
                    }
                    
                    // Borehole-specific information
                    const desc = _truncateText(detail.description || detail.location_description || '', 200);
                    const purpose = _truncateText(detail.purpose || '', 150);
                    if (desc) parts.push(`<div style="margin-bottom:4px; font-size: 11px; padding: 4px; background: rgba(0,0,0,0.03); border-radius: 3px;"><strong>Info:</strong> ${escapeHtml(desc)}</div>`);
                    if (purpose) parts.push(`<div style="margin-bottom:4px; font-size: 11px; padding: 4px; background: rgba(0,0,0,0.03); border-radius: 3px;"><strong>Purpose:</strong> ${escapeHtml(purpose)}</div>`);
                    // Display SPT tests with background data
                    const allSptTests = detail.all_spt_tests || [];
                    if (allSptTests.length > 0) {
                        parts.push('<div style="margin-top: 12px; margin-bottom: 8px; padding: 8px; background: rgba(33, 150, 243, 0.1); border-radius: 4px; border-left: 3px solid rgba(33, 150, 243, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">SPT Tests Background Data:</div>');
                        allSptTests.forEach((sptTest, idx) => {
                            const bg = sptTest.background || {};
                            const testName = sptTest.name || sptTest.activity_id || `SPT Test ${idx + 1}`;
                            const depthFrom = sptTest.depth_from !== undefined ? sptTest.depth_from : '';
                            const depthTo = sptTest.depth_to !== undefined ? sptTest.depth_to : '';
                            const depthText = (depthFrom !== '' && depthTo !== '') ? `${depthFrom} - ${depthTo} ft` : '';
                            
                            parts.push(`<div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.6); border-radius: 3px;">`);
                            parts.push(`<div style="font-weight: 600; font-size: 10px; color:#1976d2; margin-bottom: 4px;">${escapeHtml(testName)}${depthText ? ` (${depthText})` : ''}</div>`);
                            
                            if (bg.hammerType) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Hammer Type:</strong> ${escapeHtml(bg.hammerType)}</div>`);
                            }
                            if (bg.hammerEfficiency) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Hammer Efficiency:</strong> ${escapeHtml(bg.hammerEfficiency)}%</div>`);
                            }
                            if (bg.totalPenetration) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Total Penetration:</strong> ${escapeHtml(bg.totalPenetration)} ft</div>`);
                            }
                            if (bg.nValue) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>N-Value:</strong> ${escapeHtml(bg.nValue)}</div>`);
                            }
                            if (bg.driveSets && bg.driveSets.length > 0) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Drive Sets:</strong></div>`);
                                parts.push(`<div style="margin-left: 12px; font-size: 9px; color:#666;">`);
                                bg.driveSets.forEach((ds, dsIdx) => {
                                    const index = ds.index || (dsIdx + 1);
                                    const blowCount = ds.blowCount || '-';
                                    const penetration = ds.penetration || '-';
                                    parts.push(`<div style="margin-bottom: 1px;">Set ${index}: ${blowCount} blows, ${penetration} ft penetration</div>`);
                                });
                                parts.push(`</div>`);
                            }
                            parts.push(`</div>`);
                        });
                        parts.push('</div>');
                        // Import SPT button - direct import from popup (no need to "Select this point" first)
                        parts.push(`<button type="button" class="diggs-import-spt-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsSptFromPopup==='function'){window.importDiggsSptFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(255, 193, 7, 0.25); border: 1px solid rgba(255, 193, 7, 0.6); border-radius: 4px; color: #F57F17; font-weight: 600;">Import SPT</button>`);
                    }
                    
                    // Display CPT tests with background data
                    const allCptTests = detail.all_cpt_tests || [];
                    if (allCptTests.length > 0) {
                        parts.push('<div style="margin-top: 12px; margin-bottom: 8px; padding: 8px; background: rgba(255, 193, 7, 0.1); border-radius: 4px; border-left: 3px solid rgba(255, 193, 7, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">CPT Tests Background Data:</div>');
                        allCptTests.forEach((cptTest, idx) => {
                            const bg = cptTest.background || {};
                            const testName = cptTest.test_id || cptTest.id || `CPT Test ${idx + 1}`;
                            
                            parts.push(`<div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.6); border-radius: 3px;">`);
                            parts.push(`<div style="font-weight: 600; font-size: 10px; color:#388e3c; margin-bottom: 4px;">${escapeHtml(testName)}</div>`);
                            
                            if (bg.penetrometerType) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Penetrometer Type:</strong> ${escapeHtml(bg.penetrometerType)}</div>`);
                            }
                            if (bg.distanceTipToSleeve) {
                                const uom = bg.distanceTipToSleeve_uom || 'cm';
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Distance Tip to Sleeve:</strong> ${escapeHtml(bg.distanceTipToSleeve)} ${escapeHtml(uom)}</div>`);
                            }
                            if (bg.netAreaRatioCorrection) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Net Area Ratio Correction:</strong> ${escapeHtml(bg.netAreaRatioCorrection)}</div>`);
                            }
                            if (bg.penetrationRate) {
                                const uom = bg.penetrationRate_uom || 'cm/s';
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Penetration Rate:</strong> ${escapeHtml(bg.penetrationRate)} ${escapeHtml(uom)}</div>`);
                            }
                            if (bg.tipArea) {
                                const uom = bg.tipArea_uom || 'cm²';
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Tip Area:</strong> ${escapeHtml(bg.tipArea)} ${escapeHtml(uom)}</div>`);
                            }
                            if (bg.serialNumber) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Serial Number:</strong> ${escapeHtml(bg.serialNumber)}</div>`);
                            }
                            parts.push(`</div>`);
                        });
                        parts.push('</div>');
                        // Import CPT button - direct import from popup
                        parts.push(`<button type="button" class="diggs-import-cpt-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsCptFromPopup==='function'){window.importDiggsCptFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(255, 193, 7, 0.25); border: 1px solid rgba(255, 193, 7, 0.6); border-radius: 4px; color: #F57F17; font-weight: 600;">Import CPT</button>`);
                    }
                    // Import Stratigraphy (depth, soil type, unit weight) - for Deep Excavation
                    const lithRowsPopup = detail.lithology_rows_for_import || detail.lithology_uscs || [];
                    if (lithRowsPopup.length > 0) {
                        parts.push('<div style="margin-top: 12px; padding: 8px; background: rgba(123, 104, 238, 0.1); border-radius: 4px; border-left: 3px solid rgba(123, 104, 238, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">Layers (depth, soil type, γt)</div>');
                        parts.push(`<button type="button" class="diggs-import-stratigraphy-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsStratigraphyFromPopup==='function'){window.importDiggsStratigraphyFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 6px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(123, 104, 238, 0.2); border: 1px solid rgba(123, 104, 238, 0.5); border-radius: 4px; color: #4a148c; font-weight: 600;">Import to Deep Excavation (Stratigraphy)</button>`);
                        parts.push('</div>');
                    }
                    
                    if (!parts.length) parts.push('<div style="color:#777; font-size: 11px;">No background text found in XML for this point.</div>');
                    el.innerHTML = parts.join('');
                } catch (e) {
                    console.error('[DIGGS] Error loading detail:', e);
                    const el = document.getElementById(detailDomId);
                    if (el) el.innerHTML = `<div style="color:#b00020; font-size: 11px;">Failed to load detail: ${escapeHtml(e.message || String(e))}</div>`;
                }
            });
        }
    });

    diggsLayer.addTo(diggsMap);
    
    // Auto-zoom to filtered results
    try {
        const b = diggsLayer.getBounds();
        if (b && b.isValid && b.isValid()) {
            diggsMap.fitBounds(b.pad(0.12));
        }
    } catch (_) {}
}

function setDiggsStatus(message, type = 'info') {
    const el = document.getElementById('diggs-status');
    if (!el) return;
    // UX: hide noisy success/info banners for DIGGS import workflow (requested).
    // Keep warnings/errors visible.
    if (type === 'success') return;
    if (typeof message === 'string') {
        if (message.startsWith('Successfully imported')) return;
        // Allow "Importing…" progress messages (requested).
        if (message.startsWith('Loading DIGGS boreholes')) return;
    }
    if (!message) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = 'block';
    el.textContent = message;
    if (type === 'error') el.style.color = '#ff6b6b';
    else if (type === 'success') el.style.color = '#4caf50';
    else el.style.color = 'var(--text-secondary)';
}

function clearGeosettaLayer(silent = false) {
    try {
        if (map && geosettaLayer) {
            map.removeLayer(geosettaLayer);
        }
    } catch (_) {}
    geosettaLayer = null;
    geosettaFeatureByKey = {};
    geosettaSelected = null;
    window.geosettaSelected = null;

    const label = document.getElementById('geosetta-selected-label');
    if (label) label.textContent = 'None';
    const hidden = document.getElementById('geosetta-selected-json');
    if (hidden) hidden.value = '';

    if (!silent) setGeosettaStatus('Cleared Geosetta borehole layer.');
}

function clearDiggsLayer(silent = false) {
    try {
        if (diggsMap && diggsLayer) {
            diggsMap.removeLayer(diggsLayer);
        }
    } catch (_) {}
    diggsLayer = null;
    diggsFeatureByKey = {};
    diggsAllFeatures = [];
    diggsSelected = null;
    window.diggsSelected = null;
    diggsDetailCache = {};
    diggsDetailIndex = {};

    const label = document.getElementById('diggs-selected-label');
    if (label) label.textContent = 'None';
    const hidden = document.getElementById('diggs-selected-json');
    if (hidden) hidden.value = '';

    if (!silent) setDiggsStatus('Cleared DIGGS layer.');
}

function _truncateText(s, maxLen = 220) {
    if (!s) return '';
    const t = String(s).trim();
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen - 1) + '…';
}

function _diggsDetailDomId(key) {
    return `diggs-detail-${encodeURIComponent(String(key || ''))}`;
}

async function loadCptTestData(testId, xmlFile, containerDomId) {
    try {
        const resp = await fetch('/api/diggs/test_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ xml_file: xmlFile, test_type: 'cpt', test_id: testId })
        });
        if (!resp.ok) throw new Error('Failed to load CPT data');
        const data = await resp.json();
        if (data.status !== 'success') throw new Error(data.message || 'Failed');
        
        const testData = data.data;
        const resultDiv = document.getElementById(`${containerDomId}_cpt_result`);
        if (!resultDiv) {
            // Create result div if it doesn't exist
            const cptSelect = document.getElementById(`${containerDomId}_cpt_select`);
            if (cptSelect && cptSelect.parentElement) {
                const div = document.createElement('div');
                div.id = `${containerDomId}_cpt_result`;
                div.style.cssText = 'margin-top: 8px; padding: 8px; background: rgba(255, 152, 0, 0.1); border-radius: 4px; max-height: 200px; overflow-y: auto;';
                cptSelect.parentElement.appendChild(div);
            } else {
                return;
            }
        }
        
        const resultEl = document.getElementById(`${containerDomId}_cpt_result`);
        if (resultEl) {
            const depths = testData.depths || [];
            const qc = testData.qc || [];
            const fs = testData.fs || [];
            const u2 = testData.u2 || [];
            const units = testData.units || {};
            
            let html = `<div style="font-size: 11px; font-weight: 600; margin-bottom: 6px;">CPT Test: ${escapeHtml(testId)}</div>`;
            html += `<div style="font-size: 10px; color:#666; margin-bottom: 6px;">Data points: ${depths.length}</div>`;
            if (depths.length > 0) {
                html += `<div style="max-height: 150px; overflow-y: auto;"><table style="width: 100%; font-size: 10px; border-collapse: collapse;">`;
                html += `<tr style="background: rgba(0,0,0,0.05);"><th style="padding: 4px; text-align: left; border: 1px solid #e2e8f0;">Depth (ft)</th><th style="padding: 4px; text-align: left; border: 1px solid #e2e8f0;">qc</th><th style="padding: 4px; text-align: left; border: 1px solid #e2e8f0;">fs</th><th style="padding: 4px; text-align: left; border: 1px solid #e2e8f0;">u2</th></tr>`;
                const maxRows = Math.min(20, depths.length);
                for (let i = 0; i < maxRows; i++) {
                    html += `<tr><td style="padding: 2px 4px; border: 1px solid #e2e8f0;">${depths[i]?.toFixed(2) || '-'}</td><td style="padding: 2px 4px; border: 1px solid #e2e8f0;">${qc[i]?.toFixed(2) || '-'}</td><td style="padding: 2px 4px; border: 1px solid #e2e8f0;">${fs[i]?.toFixed(2) || '-'}</td><td style="padding: 2px 4px; border: 1px solid #e2e8f0;">${u2[i]?.toFixed(2) || '-'}</td></tr>`;
                }
                if (depths.length > maxRows) {
                    html += `<tr><td colspan="4" style="padding: 4px; text-align: center; color:#666; font-style: italic;">... and ${depths.length - maxRows} more rows</td></tr>`;
                }
                html += `</table></div>`;
            }
            resultEl.innerHTML = html;
        }
    } catch (e) {
        console.error('Failed to load CPT data:', e);
        const resultEl = document.getElementById(`${containerDomId}_cpt_result`);
        if (resultEl) {
            resultEl.innerHTML = `<div style="color:#b00020; font-size: 11px;">Failed to load CPT data.</div>`;
        }
    }
}

async function loadSptTestData(testId, xmlFile, containerDomId) {
    try {
        const resp = await fetch('/api/diggs/test_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ xml_file: xmlFile, test_type: 'spt', test_id: testId })
        });
        if (!resp.ok) throw new Error('Failed to load SPT data');
        const data = await resp.json();
        if (data.status !== 'success') throw new Error(data.message || 'Failed');
        
        const testData = data.data;
        const resultDiv = document.getElementById(`${containerDomId}_spt_result`);
        if (!resultDiv) {
            const sptSelect = document.getElementById(`${containerDomId}_spt_select`);
            if (sptSelect && sptSelect.parentElement) {
                const div = document.createElement('div');
                div.id = `${containerDomId}_spt_result`;
                div.style.cssText = 'margin-top: 8px; padding: 8px; background: rgba(33, 150, 243, 0.1); border-radius: 4px;';
                sptSelect.parentElement.appendChild(div);
            } else {
                return;
            }
        }
        
        const resultEl = document.getElementById(`${containerDomId}_spt_result`);
        if (resultEl) {
            let html = `<div style="font-size: 11px; font-weight: 600; margin-bottom: 6px;">SPT Test: ${escapeHtml(testId)}</div>`;
            if (testData.name) {
                html += `<div style="font-size: 11px; color:#444; margin-bottom: 4px;"><strong>Name:</strong> ${escapeHtml(testData.name)}</div>`;
            }
            if (testData.depth_from !== null && testData.depth_to !== null) {
                html += `<div style="font-size: 11px; color:#444; margin-bottom: 4px;"><strong>Depth Range:</strong> ${testData.depth_from.toFixed(2)} - ${testData.depth_to.toFixed(2)} ft</div>`;
            }
            resultEl.innerHTML = html;
        }
    } catch (e) {
        console.error('Failed to load SPT data:', e);
        const resultEl = document.getElementById(`${containerDomId}_spt_result`);
        if (resultEl) {
            resultEl.innerHTML = `<div style="color:#b00020; font-size: 11px;">Failed to load SPT data.</div>`;
        }
    }
}

// Fetch borehole dataset from SQLite (fast, no XML parsing)
async function fetchBoreholeFromDataset(boreholeId, xmlFile) {
    if (!boreholeId) throw new Error('Missing boreholeId');
    let url = `/api/diggs/borehole-from-dataset/${encodeURIComponent(boreholeId)}`;
    if (xmlFile) url += `?xml_file=${encodeURIComponent(xmlFile)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `Dataset not found: ${boreholeId}`);
    }
    const json = await resp.json();
    if (!json || json.status !== 'success' || !json.data) {
        throw new Error('Invalid borehole dataset response');
    }
    return json.data;
}

async function fetchDiggsBoreholeDetail(featureId, xmlFile) {
    if (!featureId) throw new Error('Missing featureId');
    const key = `${xmlFile || ''}::${featureId}`;
    if (diggsDetailCache[key]) return diggsDetailCache[key];
    // Use detail_index from boreholes load for instant display (no API call, no rebuild wait)
    const locKey = featureId.startsWith('Location_') ? featureId : 'Location_' + featureId;
    const idx = diggsDetailIndex[featureId] || diggsDetailIndex[locKey];
    const lithCount = (idx && (idx.lithology_uscs || []).length) || 0;
    // Only use cached detail_index when it has lithology; otherwise call API (may trigger lithology rebuild)
    if (idx && lithCount > 0) {
        const detail = {
            ...idx,
            lithology_uscs: idx.lithology_uscs || [],
            lithology_rows_for_import: idx.lithology_uscs || []
        };
        diggsDetailCache[key] = detail;
        return detail;
    }

    const controller = new AbortController();
    const timeoutMs = 300000; // 5 min (lithology rebuild for uploaded XML can take 2-5 min)
    const timeoutId = setTimeout(function() {
        controller.abort(new DOMException(`Request timed out after ${timeoutMs / 1000} seconds. Try a smaller XML or wait for preprocess to complete.`, 'AbortError'));
    }, timeoutMs);
    let resp;
    try {
        resp = await fetch('/api/diggs/borehole_detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ xml_file: xmlFile, feature_id: featureId }),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
    if (!resp.ok) {
        let details = '';
        try {
            const errJson = await resp.json();
            details = errJson.message || errJson.details || JSON.stringify(errJson);
        } catch (_) {
            try { details = await resp.text(); } catch (_) {}
        }
        throw new Error(`DIGGS detail failed (HTTP ${resp.status})${details ? `: ${details}` : ''}`);
    }
    const data = await resp.json();
    if (!data || data.status !== 'success' || !data.data || !data.data.detail) {
        throw new Error(data?.message || 'DIGGS detail response missing detail');
    }
    diggsDetailCache[key] = data.data.detail;
    return data.data.detail;
}

function getGeosettaFeatureKey(feature, idx) {
    const p = (feature && feature.properties) ? feature.properties : {};
    const raw =
        (feature && (feature.id || feature.gml_id || feature.gmlId)) ||
        p.gml_id || p.gmlId || p.id || p.borehole_id || p.boreholeId || p.uuid ||
        null;
    if (raw) return `id:${String(raw)}`;
    // fallback: coordinate-based key
    try {
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
            return `xy:${coords[0]}:${coords[1]}:${idx}`;
        }
    } catch (_) {}
    return `idx:${idx}`;
}

function getGeosettaFeatureTitle(feature) {
    const p = (feature && feature.properties) ? feature.properties : {};
    return (
        p.name || p.title || p.label || p.borehole_name || p.boreholeName ||
        p.project || p.agency || p.source ||
        feature.id || p.id || p.gml_id || p.uuid ||
        'Borehole'
    );
}

function summarizeGeosettaFeature(feature) {
    let lat = null, lon = null;
    try {
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
            lon = coords[0];
            lat = coords[1];
        }
    } catch (_) {}

    const p = (feature && feature.properties) ? feature.properties : {};
    return {
        title: getGeosettaFeatureTitle(feature),
        id: (feature && feature.id) || p.id || p.gml_id || p.uuid || null,
        latitude: lat,
        longitude: lon,
        properties: p
    };
}

function selectGeosettaFeature(key) {
    const feature = geosettaFeatureByKey[key];
    if (!feature) return;
    const summary = summarizeGeosettaFeature(feature);
    geosettaSelected = summary;
    window.geosettaSelected = summary;

    const label = document.getElementById('geosetta-selected-label');
    if (label) {
        const idPart = summary.id ? ` (${summary.id})` : '';
        label.textContent = `${summary.title}${idPart}`;
    }
    const hidden = document.getElementById('geosetta-selected-json');
    if (hidden) {
        try {
            hidden.value = JSON.stringify(summary);
        } catch (_) {
            hidden.value = '';
        }
    }

    setGeosettaStatus('Selected a Geosetta borehole point. You can now run analysis and export (selection will be recorded).', 'success');
}

function renderGeosettaGeoJSON(geojson, opts = {}) {
    if (!map || typeof L === 'undefined') return;
    clearGeosettaLayer(true);

    geosettaFeatureByKey = {};
    let featureCount = 0;

    geosettaLayer = L.geoJSON(geojson, {
        pointToLayer: function(feature, latlng) {
            return L.circleMarker(latlng, {
                radius: 5,
                color: 'rgba(123, 104, 238, 0.95)',
                weight: 2,
                fillColor: 'rgba(123, 104, 238, 0.65)',
                fillOpacity: 0.85
            });
        },
        onEachFeature: function(feature, layer) {
            const key = getGeosettaFeatureKey(feature, featureCount);
            geosettaFeatureByKey[key] = feature;
            featureCount++;

            const title = escapeHtml(getGeosettaFeatureTitle(feature));
            const p = (feature && feature.properties) ? feature.properties : {};
            const idLike = escapeHtml(feature.id || p.id || p.gml_id || p.uuid || '');
            const snippet =
                escapeHtml(p.content || p.description || p.summary || p.source || '');

            const popupHtml = `
                <div style="min-width: 220px;">
                    <div style="font-weight: 800; margin-bottom: 6px;">${title}</div>
                    ${idLike ? `<div style="font-size: 11px; color:#666; margin-bottom: 6px;">ID: ${idLike}</div>` : ''}
                    ${snippet ? `<div style="font-size: 11px; color:#444; margin-bottom: 8px; max-height: 90px; overflow:auto;">${snippet}</div>` : ''}
                    <button type="button" style="padding:6px 10px; font-size: 12px; cursor:pointer;" onclick="selectGeosettaFeature('${escapeHtml(key)}')">Select this borehole</button>
                </div>
            `;
            layer.bindPopup(popupHtml);
        }
    });

    geosettaLayer.addTo(map);

    if (opts.zoomToResults) {
        try {
            const b = geosettaLayer.getBounds();
            if (b && b.isValid && b.isValid()) {
                map.fitBounds(b.pad(0.15));
            }
        } catch (_) {}
    }

    return featureCount;
}

function getDiggsFeatureKey(feature, idx) {
    const p = (feature && feature.properties) ? feature.properties : {};
    const raw = (feature && feature.id) || p.id || p.gml_id || p.name || null;
    if (raw) return `diggs:${String(raw)}`;
    try {
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
            return `diggs_xy:${coords[0]}:${coords[1]}:${idx}`;
        }
    } catch (_) {}
    return `diggs_idx:${idx}`;
}

function selectDiggsFeature(key) {
    const feature = diggsFeatureByKey[key];
    if (!feature) return;
    const p = feature.properties || {};
    const coords = (feature.geometry && Array.isArray(feature.geometry.coordinates)) ? feature.geometry.coordinates : [null, null];
    const summary = {
        id: p.id || feature.id || null,
        title: p.name || p.title || p.id || 'DIGGS Point',
        feature_type: p.feature_type || '',
        latitude: coords[1],
        longitude: coords[0],
        spt_count: p.spt_count || 0,
        cpt_count: p.cpt_count || 0,
        vs_count: p.vs_count || 0,
        total_depth: p.total_depth || '',
        total_depth_uom: p.total_depth_uom || '',
        project_ref: p.project_ref || '',
        spt_samples: p.spt_samples || [],
        cpt_tests: p.cpt_tests || [],
        vs_tests: p.vs_tests || [],
        _key: key  //  key 
    };

    // （）
    const existingIndex = diggsSelectedBoreholes.findIndex(bh => bh.id === summary.id && bh._key === key);
    if (existingIndex >= 0) {
        // ，
        diggsSelectedBoreholes.splice(existingIndex, 1);
        setDiggsStatus('Deselected borehole: ' + summary.title, 'info');
    } else {
        // 
        diggsSelectedBoreholes.push(summary);
        setDiggsStatus('Selected borehole: ' + summary.title, 'success');
    }

    // （）
    diggsSelected = summary;
    window.diggsSelected = summary;

    //  borehole 
    updateSelectedBoreholesDisplay();
    
    // Drilling input mode UI has been removed; keep manual tables visible and allow DIGGS import in parallel.
}

//  borehole 
function updateSelectedBoreholesDisplay() {
    const block = document.getElementById('diggs-selected-boreholes-block');
    const list = document.getElementById('diggs-selected-boreholes-list');
    const importBtn = document.getElementById('diggs-import-data-btn');
    
    if (!block || !list) return;
    
    if (diggsSelectedBoreholes.length === 0) {
        block.style.display = 'none';
        if (importBtn) importBtn.style.display = 'none';
        return;
    }
    
    block.style.display = 'block';
    if (importBtn) importBtn.style.display = 'block';
    
    // 
    list.innerHTML = '';
    
    //  borehole
    diggsSelectedBoreholes.forEach((bh, index) => {
        const badge = document.createElement('span');
        badge.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: rgba(255, 193, 7, 0.2); border: 1px solid rgba(255, 193, 7, 0.5); border-radius: 16px; font-size: 12px; color: var(--text-primary); font-weight: 500;';
        badge.innerHTML = `
            <span>${escapeHtml(bh.title || bh.id || 'Unknown')}</span>
            <button type="button" onclick="removeSelectedBorehole('${escapeHtml(bh._key)}')" style="background: rgba(255, 0, 0, 0.3); border: none; border-radius: 50%; width: 18px; height: 18px; cursor: pointer; color: white; font-size: 12px; line-height: 1; padding: 0; display: flex; align-items: center; justify-content: center;">×</button>
        `;
        list.appendChild(badge);
    });

    try {
        if (diggsMap && diggsLayer) {
            diggsLayer.addTo(diggsMap);
        }
    } catch (_) {}
}

//  borehole
function removeSelectedBorehole(key) {
    const index = diggsSelectedBoreholes.findIndex(bh => bh._key === key);
    if (index >= 0) {
        diggsSelectedBoreholes.splice(index, 1);
        updateSelectedBoreholesDisplay();
        setDiggsStatus('Removed borehole from selection', 'info');
    }
}

//  popup  SPT（Select this point）
async function importDiggsSptFromPopup(featureId, boreholeName) {
    if (!featureId) {
        setDiggsStatus('No borehole ID.', 'warning');
        return;
    }
    const xmlSelect = document.getElementById('diggs-xml-select');
    const xmlFile = xmlSelect ? (xmlSelect.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    
    //  SPT 
    if (typeof window.changeTab === 'function') {
        window.changeTab('Soil Mechanics');
    }
    switchTestType('SPT', { regenerate: false });
    //  DOM （ borehole-tabs ）
    await new Promise(function(resolve) {
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    setTimeout(resolve, 150);
                });
            });
        } else {
            setTimeout(resolve, 200);
        }
    });
    //  SPT tab，
    const tabsContainer = document.getElementById('borehole-tabs');
    if (tabsContainer && !tabsContainer.querySelector('.borehole-tab')) {
        try { generateBoreholeTables(); } catch (_) {}
    }
    //  SPT tab
    const bhId = findOrCreateBoreholeTab(featureId, boreholeName, 'SPT');
    switchBoreholeTab(bhId);
    const drillingSection = document.getElementById('borehole-tabs') || document.getElementById('dynamic-borehole-container');
    if (drillingSection) drillingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    setDiggsStatus('Importing SPT…', 'info');
    try {
        const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
        if (!detail) {
            setDiggsStatus('Could not load borehole detail.', 'warning');
            return;
        }
        const tests = detail.all_spt_tests || [];
        if (tests.length === 0) {
            setDiggsStatus('This borehole has no SPT tests.', 'warning');
            return;
        }
        let sptPayloads = Array.isArray(detail.preprocessed_spt_data) && detail.preprocessed_spt_data.length
            ? detail.preprocessed_spt_data
            : [];
        if (sptPayloads.length === 0) {
            for (const test of tests) {
                const testId = test.test_id || test.activity_id || test.id || '';
                if (!testId) continue;
                const response = await fetch('/api/diggs/test_data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ xml_file: xmlFile, test_type: 'spt', test_id: testId })
                });
                if (!response.ok) continue;
                const testData = await response.json();
                if (testData && testData.status !== 'error') {
                    sptPayloads.push(testData.data || testData);
                }
            }
        }
        if (sptPayloads.length === 0) {
            setDiggsStatus('Could not load SPT data for this borehole.', 'warning');
            return;
        }
        // Pass lithology_uscs for soil class enrichment, but NOT lithology_rows_for_import:
        // Use one row per SPT (all N values) instead of one row per lithology layer.
        importSPTDataBatch(sptPayloads, featureId, boreholeName, detail.lithology_uscs || [], null);
        setDiggsStatus(`Imported ${sptPayloads.length} SPT row(s).`, 'info');
        const drillingSection = document.getElementById('borehole-tabs') || document.getElementById('dynamic-borehole-container');
        if (drillingSection) drillingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        console.error('[DIGGS] importDiggsSptFromPopup failed:', err);
        setDiggsStatus('Import failed: ' + (err?.message || String(err)), 'error');
    }
}
window.importDiggsSptFromPopup = importDiggsSptFromPopup;

//  popup  CPT（Select this point）
async function importDiggsCptFromPopup(featureId, boreholeName) {
    if (!featureId) {
        setDiggsStatus('No borehole ID.', 'warning');
        return;
    }
    const xmlSelect = document.getElementById('diggs-xml-select');
    const xmlFile = xmlSelect ? (xmlSelect.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    
    //  CPT （ SPT ）
    if (typeof window.changeTab === 'function') {
        window.changeTab('Soil Mechanics');
    }
    switchTestType('CPT', { regenerate: false });
    //  DOM 
    await new Promise(function(resolve) {
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    setTimeout(resolve, 150);
                });
            });
        } else {
            setTimeout(resolve, 200);
        }
    });
    //  CPT tab，
    const cptTabs = document.getElementById('cpt-borehole-tabs');
    if (cptTabs && !cptTabs.querySelector('.cpt-borehole-tab')) {
        try { generateCPTTables(); } catch (_) {}
    }
    //  CPT tab
    const cptId = findOrCreateCPTTab(featureId, boreholeName, 'CPT');
    switchCPTTab(cptId);
    const cptSection = document.getElementById('cpt-tabs-container');
    if (cptSection) cptSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    setDiggsStatus('Importing CPT…', 'info');
    try {
        const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
        if (!detail) {
            setDiggsStatus('Could not load borehole detail.', 'warning');
            return;
        }
        const tests = detail.all_cpt_tests || [];
        if (tests.length === 0) {
            setDiggsStatus('This borehole has no CPT tests.', 'warning');
            return;
        }
        let pre = Array.isArray(detail.preprocessed_cpt_data) && detail.preprocessed_cpt_data.length
            ? detail.preprocessed_cpt_data
            : [];
        if (pre.length === 0) {
            for (const test of tests) {
                const testId = (typeof test === 'string') ? test : (test.test_id || test.id || '');
                if (!testId) continue;
                const response = await fetch('/api/diggs/test_data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ xml_file: xmlFile, test_type: 'cpt', test_id: testId })
                });
                if (!response.ok) continue;
                const testData = await response.json();
                if (testData && testData.status !== 'error') {
                    pre.push(testData.data || testData);
                }
            }
        }
        if (pre.length === 0) {
            setDiggsStatus('Could not load CPT data for this borehole.', 'warning');
            return;
        }
        for (const payload of pre) {
            importCPTData(payload, featureId, boreholeName);
        }
        setDiggsStatus(`Imported ${pre.length} CPT test(s).`, 'info');
    } catch (err) {
        console.error('[DIGGS] importDiggsCptFromPopup failed:', err);
        setDiggsStatus('Import failed: ' + (err?.message || String(err)), 'error');
    }
}
window.importDiggsCptFromPopup = importDiggsCptFromPopup;

//  popup  Deep Excavation Stratigraphic table（depth, soil type, unit weight）
async function importDiggsStratigraphyFromPopup(featureId, boreholeName) {
    if (!featureId) {
        setDiggsStatus('No borehole ID.', 'warning');
        return;
    }
    // Use excavation XML select when on Deep Excavation, else Liquefaction
    const xmlSelectExc = document.getElementById('diggs-xml-select-excavation');
    const xmlSelectLiq = document.getElementById('diggs-xml-select');
    const xmlSelect = xmlSelectExc || xmlSelectLiq;
    const xmlFile = xmlSelect ? (xmlSelect.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    
    if (typeof window.changeTab === 'function') {
        window.changeTab('Deep Excavation');
    }
    await new Promise(function(resolve) {
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    setTimeout(resolve, 250);
                });
            });
        } else {
            setTimeout(resolve, 300);
        }
    });
    // Ensure Uplift/Sand Boil tab is active (stratigraphic table lives there)
    if (typeof switchExcavationTab === 'function') {
        switchExcavationTab('uplift-sand-boil');
        await new Promise(r => setTimeout(r, 150));
    }
    
    setDiggsStatus('Importing stratigraphy…', 'info');
    try {
        const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
        if (!detail) {
            setDiggsStatus('Could not load borehole detail.', 'warning');
            return;
        }
        const lithRows = detail.lithology_rows_for_import || detail.lithology_uscs || [];
        if (!lithRows.length) {
            setDiggsStatus('This borehole has no lithology data.', 'warning');
            return;
        }
        // Cohesive (U): CL, CH, ML, MH, OL, OH, SC; Granular (D): others
        const COHESIVE = new Set(['CL','CH','ML','MH','OL','OH','SC']);
        const FT_TO_M = 0.3048;
        const TF_M3_TO_KN_M3 = 9.80665;
        const KN_M3_TO_PCF = 6.36588;
        const TYPICAL_GAMMA = { CL: 1.9, CH: 1.8, ML: 1.85, MH: 1.75, SM: 1.9, SC: 1.95, SP: 1.7, SW: 1.8, GP: 1.75, GW: 1.85, GM: 1.9, GC: 1.95, SF: 1.85, TOPSOIL: 1.7 };
        const unitRadio = document.querySelector('input[name="excavation-unit-system"]:checked');
        const unitSystem = unitRadio ? unitRadio.value : 'metric';
        const layers = lithRows.map(lit => {
            const to = parseFloat(lit.to ?? lit.depth_to ?? 0);
            const from = parseFloat(lit.from ?? lit.depth_from ?? 0);
            const code = (lit.soil_class || lit.legend_code || lit.legendCode || lit.classification_name || lit.classificationName || '').toString().trim().toUpperCase().split(/[\s-]/)[0] || 'SM';
            const codeBase = code.replace(/[^A-Z]/g, '');
            const gammaTfM3 = lit.unit_weight != null ? parseFloat(lit.unit_weight) : (TYPICAL_GAMMA[codeBase] || TYPICAL_GAMMA[code] || 1.9);
            const type = COHESIVE.has(codeBase) || COHESIVE.has(code) ? 'U' : 'D';
            const depth = unitSystem === 'imperial' ? to : (to * FT_TO_M);
            const gamma = unitSystem === 'imperial'
                ? (gammaTfM3 * TF_M3_TO_KN_M3 * KN_M3_TO_PCF)
                : (gammaTfM3 * TF_M3_TO_KN_M3);
            return {
                code: codeBase || code || 'SM',
                type,
                depth,
                gamma: isFinite(gamma) ? gamma : (unitSystem === 'imperial' ? 120 : 18.5)
            };
        }).filter(l => l.depth > 0);
        if (layers.length === 0) {
            setDiggsStatus('No valid lithology intervals to import.', 'warning');
            return;
        }
        const filled = fillStratigraphicTableFromLayers(layers);
        if (filled) {
            setDiggsStatus(`Imported ${layers.length} layer(s) to Deep Excavation from ${boreholeName || featureId}.`, 'success');
            const stratCard = document.querySelector('#uplift-sand-boil-tab') || document.getElementById('stratigraphic-table');
            if (stratCard) stratCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            setDiggsStatus('Stratigraphic table not found. Ensure you are on the Uplift/Sand Boil tab.', 'warning');
        }
    } catch (err) {
        console.error('[DIGGS] importDiggsStratigraphyFromPopup failed:', err);
        setDiggsStatus('Import failed: ' + (err?.message || String(err)), 'error');
    }
}
window.importDiggsStratigraphyFromPopup = importDiggsStratigraphyFromPopup;

//  popup  Supported Diaphragm Stratigraphic table（depth, soil type, unit weight）
async function importDiggsStratigraphyToDiaphragmFromPopup(featureId, boreholeName) {
    if (!featureId) {
        const statusEl = document.getElementById('diggs-status-diaphragm');
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = 'No borehole ID.';
            statusEl.style.background = 'rgba(255, 152, 0, 0.1)';
            statusEl.style.border = '1px solid rgba(255, 152, 0, 0.3)';
        }
        return;
    }
    const xmlSelect = document.getElementById('diggs-xml-select-diaphragm') || document.getElementById('diggs-xml-select-excavation');
    const xmlFile = xmlSelect ? (xmlSelect.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';

    if (typeof window.changeTab === 'function') {
        window.changeTab('Deep Excavation');
    }
    await new Promise(function(resolve) {
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    setTimeout(resolve, 250);
                });
            });
        } else {
            setTimeout(resolve, 300);
        }
    });
    if (typeof switchExcavationTab === 'function') {
        switchExcavationTab('supported-diaphragm-wall');
        await new Promise(r => setTimeout(r, 150));
    }

    const statusEl = document.getElementById('diggs-status-diaphragm');
    const setStatus = function(msg, type) {
        if (!statusEl) return;
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
        if (type === 'success') {
            statusEl.style.background = 'rgba(255, 193, 7, 0.1)';
            statusEl.style.border = '1px solid rgba(255, 193, 7, 0.3)';
        } else if (type === 'error') {
            statusEl.style.background = 'rgba(200, 0, 0, 0.08)';
            statusEl.style.border = '1px solid rgba(200, 0, 0, 0.3)';
        } else {
            statusEl.style.background = 'rgba(0, 217, 255, 0.08)';
            statusEl.style.border = '1px solid rgba(0, 217, 255, 0.25)';
        }
    };

    setStatus('Importing stratigraphy…', 'info');
    try {
        const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
        if (!detail) {
            setStatus('Could not load borehole detail.', 'error');
            return;
        }
        const lithRows = detail.lithology_rows_for_import || detail.lithology_uscs || [];
        if (!lithRows.length) {
            setStatus('This borehole has no lithology data.', 'error');
            return;
        }
        const COHESIVE = new Set(['CL', 'CH', 'ML', 'MH', 'OL', 'OH', 'SC']);
        const FT_TO_M = 0.3048;
        const TF_M3_TO_KN_M3 = 9.80665;
        const KN_M3_TO_PCF = 6.36588;
        const TYPICAL_GAMMA = { CL: 1.9, CH: 1.8, ML: 1.85, MH: 1.75, SM: 1.9, SC: 1.95, SP: 1.7, SW: 1.8, GP: 1.75, GW: 1.85, GM: 1.9, GC: 1.95, SF: 1.85, TOPSOIL: 1.7 };
        const unitRadio = document.querySelector('input[name="diaphragm-unit-system"]:checked');
        const unitSystem = unitRadio ? unitRadio.value : 'metric';
        const pickNum = function(...vals) {
            for (const v of vals) {
                const n = parseFloat(v);
                if (Number.isFinite(n)) return n;
            }
            return null;
        };

        const layers = lithRows.map(lit => {
            const to = parseFloat(lit.to ?? lit.depth_to ?? 0);
            const code = (lit.soil_class || lit.legend_code || lit.legendCode || lit.classification_name || lit.classificationName || '').toString().trim().toUpperCase().split(/[\s-]/)[0] || 'SM';
            const codeBase = code.replace(/[^A-Z]/g, '');
            const gammaTfM3 = lit.unit_weight != null ? parseFloat(lit.unit_weight) : (TYPICAL_GAMMA[codeBase] || TYPICAL_GAMMA[code] || 1.9);
            const type = COHESIVE.has(codeBase) || COHESIVE.has(code) ? 'U' : 'D';
            const depth = unitSystem === 'imperial' ? to : (to * FT_TO_M);
            const gamma = unitSystem === 'imperial'
                ? (gammaTfM3 * TF_M3_TO_KN_M3 * KN_M3_TO_PCF)
                : (gammaTfM3 * TF_M3_TO_KN_M3);
            const cVal = pickNum(lit.cohesion, lit.c, lit.c_prime, lit.cPrime, lit.effective_cohesion);
            const phiVal = pickNum(lit.friction_angle, lit.frictionAngle, lit.phi, lit.phi_prime, lit.phiPrime);
            const suVal = pickNum(lit.undrained_shear_strength, lit.undrainedShearStrength, lit.su, lit.s_u);
            return {
                code: codeBase || code || 'SM',
                type,
                depth,
                gamma: isFinite(gamma) ? gamma : (unitSystem === 'imperial' ? 120 : 18.5),
                c: cVal != null ? cVal : '',
                phi: phiVal != null ? phiVal : '',
                su: suVal != null ? suVal : ''
            };
        }).filter(l => l.depth > 0);

        if (layers.length === 0) {
            setStatus('No valid lithology intervals to import.', 'error');
            return;
        }
        const filled = fillDiaphragmStratigraphicTableFromLayers(layers);
        if (filled) {
            setStatus(`Imported ${layers.length} layer(s) to Supported Diaphragm from ${boreholeName || featureId}.`, 'success');
            const table = document.getElementById('diaphragm-stratigraphic-table');
            if (table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            setStatus('Diaphragm stratigraphic table not found.', 'error');
        }
    } catch (err) {
        console.error('[DIGGS] importDiggsStratigraphyToDiaphragmFromPopup failed:', err);
        setStatus('Import failed: ' + (err?.message || String(err)), 'error');
    }
}
window.importDiggsStratigraphyToDiaphragmFromPopup = importDiggsStratigraphyToDiaphragmFromPopup;

function fillShallowFoundationLayersFromImported(layers) {
    const tbody = document.getElementById('sf-layers-body');
    if (!tbody) return false;
    const list = Array.isArray(layers) ? layers.filter(l => l && Number.isFinite(Number(l.z_bot)) && Number.isFinite(Number(l.z_top)) && Number(l.z_bot) > Number(l.z_top)) : [];
    if (!list.length) return false;

    tbody.innerHTML = '';
    list.forEach((layer) => {
        const drainageType = String(layer.drainage_type || 'D').toUpperCase() === 'U' ? 'U' : 'D';
        const suVal = Number.isFinite(Number(layer.Su)) ? Number(layer.Su) : 0;
        const cVal = Number.isFinite(Number(layer.c_prime)) ? Number(layer.c_prime) : 0;
        const phiVal = Number.isFinite(Number(layer.phi_prime)) ? Number(layer.phi_prime) : 0;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><input type="number" class="sf-z-top" value="${Number(layer.z_top).toFixed(3)}" step="0.1"></td><td><input type="number" class="sf-z-bot" value="${Number(layer.z_bot).toFixed(3)}" step="0.1"></td><td><input type="number" class="sf-gamma-t" value="${Number(layer.gamma_t).toFixed(3)}" step="0.01"></td><td><input type="text" class="sf-soil" value="${escapeHtml(String(layer.soil || 'SM'))}" placeholder="SM"></td><td><select class="sf-drainage-type" onchange="updateSfDrainageRow(this.closest('tr'))"><option value="D" ${drainageType === 'D' ? 'selected' : ''}>D</option><option value="U" ${drainageType === 'U' ? 'selected' : ''}>U</option></select></td><td><input type="number" class="sf-su" value="${suVal}" step="0.1"></td><td><input type="number" class="sf-c-prime" value="${cVal}" step="0.1"></td><td><input type="number" class="sf-phi-prime" value="${phiVal}" step="1"></td><td><button type="button" onclick="removeSfLayer(this)">×</button></td>`;
        tbody.appendChild(tr);
        updateSfDrainageRow(tr);
    });
    return true;
}

async function importDiggsStratigraphyToShallowFromPopup(featureId, boreholeName) {
    if (!featureId) return;
    const xmlSelect = document.getElementById('diggs-xml-select-shallow') || document.getElementById('diggs-xml-select');
    const xmlFile = xmlSelect ? (xmlSelect.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    const statusEl = document.getElementById('diggs-status-shallow');
    const setStatus = function(msg, type) {
        if (!statusEl) return;
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
        if (type === 'success') {
            statusEl.style.background = 'rgba(255, 193, 7, 0.1)';
            statusEl.style.border = '1px solid rgba(255, 193, 7, 0.3)';
        } else if (type === 'error') {
            statusEl.style.background = 'rgba(200, 0, 0, 0.08)';
            statusEl.style.border = '1px solid rgba(200, 0, 0, 0.3)';
        } else {
            statusEl.style.background = 'rgba(0, 217, 255, 0.08)';
            statusEl.style.border = '1px solid rgba(0, 217, 255, 0.25)';
        }
    };

    if (typeof window.changeTab === 'function') {
        window.changeTab('Shallow Foundation');
    }
    await new Promise(function(resolve) {
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    setTimeout(resolve, 250);
                });
            });
        } else {
            setTimeout(resolve, 300);
        }
    });

    setStatus('Importing stratigraphy…', 'info');
    try {
        const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
        if (!detail) {
            setStatus('Could not load borehole detail.', 'error');
            return;
        }
        const lithRows = detail.lithology_rows_for_import || detail.lithology_uscs || [];
        if (!lithRows.length) {
            setStatus('This borehole has no lithology data.', 'error');
            return;
        }

        const COHESIVE = new Set(['CL', 'CH', 'ML', 'MH', 'OL', 'OH', 'SC']);
        const FT_TO_M = 0.3048;
        const TF_TO_KN = 9.80665;
        const TFM3_TO_PCF = 1.0 / 0.01601846337396014;
        const TFM2_TO_KSF = 1.0 / 4.88242763638305;
        const unitSystem = ((document.querySelector('input[name="sf-unit-system"]:checked') || {}).value || 'metric').toLowerCase();
        const isMetric = unitSystem === 'metric';
        const pickNum = function(...vals) {
            for (const v of vals) {
                const n = parseFloat(v);
                if (Number.isFinite(n)) return n;
            }
            return null;
        };
        const phiDefaultBySoil = { CL: 0, CH: 0, ML: 28, MH: 28, SM: 32, SC: 30, SP: 33, SW: 35, GP: 34, GW: 36, GM: 30, GC: 30, SF: 30 };
        const typicalGamma = { CL: 1.9, CH: 1.8, ML: 1.85, MH: 1.75, SM: 1.9, SC: 1.95, SP: 1.7, SW: 1.8, GP: 1.75, GW: 1.85, GM: 1.9, GC: 1.95, SF: 1.85, TOPSOIL: 1.7 };

        const layers = lithRows.map((lit) => {
            const fromFt = parseFloat(lit.from ?? lit.depth_from ?? 0);
            const toFt = parseFloat(lit.to ?? lit.depth_to ?? 0);
            const codeRaw = (lit.soil_class || lit.legend_code || lit.legendCode || lit.classification_name || lit.classificationName || '').toString().trim().toUpperCase();
            const code = (codeRaw.split(/[\s/-]/)[0] || 'SM').replace(/[^A-Z]/g, '') || 'SM';
            const isCohesive = COHESIVE.has(code);
            const drainageType = isCohesive ? 'U' : 'D';
            const gammaMetric = pickNum(lit.unit_weight, lit.gamma_t, lit.gamma, lit.total_unit_weight) ?? (typicalGamma[code] || 1.9);
            const suMetric = pickNum(lit.undrained_shear_strength, lit.undrainedShearStrength, lit.su, lit.s_u);
            const cMetric = pickNum(lit.cohesion, lit.c, lit.c_prime, lit.cPrime, lit.effective_cohesion);
            const phi = pickNum(lit.friction_angle, lit.frictionAngle, lit.phi, lit.phi_prime, lit.phiPrime);

            const zTop = isMetric ? (fromFt * FT_TO_M) : fromFt;
            const zBot = isMetric ? (toFt * FT_TO_M) : toFt;
            const gammaOut = isMetric ? (gammaMetric * TF_TO_KN) : (gammaMetric * TFM3_TO_PCF);
            const suOut = suMetric == null ? 0 : (isMetric ? suMetric * TF_TO_KN : suMetric * TFM2_TO_KSF);
            const cOut = cMetric == null ? 0 : (isMetric ? cMetric * TF_TO_KN : cMetric * TFM2_TO_KSF);

            return {
                z_top: zTop,
                z_bot: zBot,
                gamma_t: gammaOut,
                soil: code,
                drainage_type: drainageType,
                Su: drainageType === 'U' ? suOut : 0,
                c_prime: drainageType === 'D' ? cOut : 0,
                phi_prime: drainageType === 'D' ? (phi != null ? phi : (phiDefaultBySoil[code] || 30)) : 0
            };
        }).filter(l => Number.isFinite(l.z_top) && Number.isFinite(l.z_bot) && l.z_bot > l.z_top);

        if (!layers.length) {
            setStatus('No valid lithology intervals to import.', 'error');
            return;
        }

        const ok = fillShallowFoundationLayersFromImported(layers);
        if (!ok) {
            setStatus('Shallow Foundation soil layers table not found.', 'error');
            return;
        }

        setStatus(`Imported ${layers.length} layer(s) to Shallow Foundation from ${boreholeName || featureId}.`, 'success');
        const table = document.getElementById('sf-layers-table');
        if (table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        console.error('[DIGGS] importDiggsStratigraphyToShallowFromPopup failed:', err);
        setStatus('Import failed: ' + (err?.message || String(err)), 'error');
    }
}
window.importDiggsStratigraphyToShallowFromPopup = importDiggsStratigraphyToShallowFromPopup;

//  borehole 
async function importSelectedBoreholesData() {
    if (diggsSelectedBoreholes.length === 0) {
        setDiggsStatus('No boreholes selected. Please select at least one borehole from the map.', 'warning');
        return;
    }
    
    // No popups: infer test type from the DIGGS test type dropdown (preferred),
    // fallback to currently visible UI mode (SPT/CPT).
    const select = document.getElementById('diggs-test-type-select');
    const selVal = select ? String(select.value || '').toLowerCase() : '';
    const inferred = (selVal === 'spt' || selVal === 'cpt') ? selVal : '';
    let testType = inferred ? inferred.toUpperCase() : '';
    if (!testType) {
        // Prefer the liquefaction test-type radio group (authoritative UI state)
        const checked = document.querySelector('input[name="test-type"]:checked');
        const v = checked ? String(checked.value || '').toUpperCase() : '';
        if (v === 'SPT' || v === 'CPT') {
            testType = v;
        }
    }
    if (!testType) {
        // Fallback to control visibility
        const sptControls = document.getElementById('spt-mode-controls');
        const cptControls = document.getElementById('cpt-mode-controls');
        const sptVisible = sptControls && sptControls.style.display !== 'none';
        const cptVisible = cptControls && cptControls.style.display !== 'none';
        if (sptVisible && !cptVisible) testType = 'SPT';
        else if (cptVisible && !sptVisible) testType = 'CPT';
    }
    if (!testType) {
        // Last resort: default to SPT (safer for your current workflow)
        testType = 'SPT';
    }

    // Switch to Liquefaction page so borehole/CPT tabs and tables are in the visible DOM
    if (typeof window.changeTab === 'function') {
        window.changeTab('Soil Mechanics');
    }
    await new Promise(function(resolve) {
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(function() { setTimeout(function() { setTimeout(resolve, 80); }, 0); });
        } else {
            setTimeout(resolve, 120);
        }
    });
    if (testType === 'CPT') {
        switchTestType('CPT', { regenerate: false });
        //  CPT  tab
        const cptTabs = document.getElementById('cpt-borehole-tabs');
        if (cptTabs && !cptTabs.querySelector('.cpt-borehole-tab')) {
            try { generateCPTTables(); } catch (_) {}
        }
    } else {
        switchTestType('SPT', { regenerate: false });
        //  SPT  tab， findOrCreateBoreholeTab  tbody
        const sptTabs = document.getElementById('borehole-tabs');
        if (sptTabs && !sptTabs.querySelector('.borehole-tab')) {
            try { generateBoreholeTables(); } catch (_) {}
        }
    }
    
    // Use currently selected XML file (fallback to default)
    const xmlSelect = document.getElementById('diggs-xml-select');
    const xmlFile = xmlSelect ? (xmlSelect.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    let importedCount = 0;
    let errorCount = 0;
    
    setDiggsStatus(`Importing ${testType} data…`, 'info');
    console.log(`[DIGGS Import] Starting: ${diggsSelectedBoreholes.length} borehole(s), testType=${testType}, xmlFile=${xmlFile}`);
    
    //  borehole 
    for (const bh of diggsSelectedBoreholes) {
        console.log(`[DIGGS Import] Processing borehole: id=${bh.id}, title=${bh.title}`);
        try {
            //  tab （ fetch）
            if (testType === 'CPT') {
                const cptId = findOrCreateCPTTab(bh.id, bh.title, 'CPT');
                switchCPTTab(cptId);
                const cptSection = document.getElementById('cpt-tabs-container');
                if (cptSection) cptSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else if (testType === 'SPT') {
                const bhId = findOrCreateBoreholeTab(bh.id, bh.title, 'SPT');
                switchBoreholeTab(bhId);
                const drillingSection = document.getElementById('borehole-tabs') || document.getElementById('dynamic-borehole-container');
                if (drillingSection) drillingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            // Load directly from SQLite dataset API; fallback to borehole_detail API only for resilience
            let data = null;
            try {
                console.log(`[DIGGS Import] Loading borehole from dataset for ${bh.id}...`);
                setDiggsStatus(`Importing ${bh.title || bh.id}…`, 'info');
                data = await fetchBoreholeFromDataset(bh.id, xmlFile);
                console.log(`[DIGGS Import] Borehole data loaded for ${bh.id}`);
            } catch (e) {
                console.warn('[DIGGS Import] SQLite dataset API failed, falling back to borehole_detail:', bh.id);
                try {
                    const xmlSelect = document.getElementById('diggs-xml-select');
                    const xmlFile = xmlSelect ? (xmlSelect.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
                    const detail = await fetchDiggsBoreholeDetail(bh.id, xmlFile);
                    if (testType === 'CPT') {
                        let cptData = detail.preprocessed_cpt_data || [];
                        if (cptData.length === 0) {
                            const tests = detail.all_cpt_tests || [];
                            for (const test of tests) {
                                const testId = (typeof test === 'string') ? test : (test.test_id || test.id || '');
                                if (!testId) continue;
                                const resp = await fetch('/api/diggs/test_data', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ xml_file: xmlFile, test_type: 'cpt', test_id: testId })
                                });
                                if (!resp.ok) continue;
                                const j = await resp.json();
                                if (j && j.status !== 'error') cptData.push(j.data || j);
                            }
                        }
                        if (cptData.length > 0) {
                            data = { cpt: cptData[0] };
                        }
                    } else {
                        const sptData = detail.preprocessed_spt_data || [];
                        if (sptData.length === 0) {
                            const tests = detail.all_spt_tests || [];
                            for (const test of tests) {
                                const testId = test.test_id || test.activity_id || test.id || '';
                                if (!testId) continue;
                                const resp = await fetch('/api/diggs/test_data', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ xml_file: xmlFile, test_type: 'spt', test_id: testId })
                                });
                                if (!resp.ok) continue;
                                const j = await resp.json();
                                if (j && j.status !== 'error') sptData.push(j.data || j);
                            }
                        }
                        if (sptData.length > 0 || (detail.lithology_rows_for_import || []).length > 0) {
                            data = {
                                layers: (detail.lithology_rows_for_import || []).map(r => ({
                                    depth_from: r.from,
                                    depth_to: r.to,
                                    soil_class: r.soil_class || r.legend_code || r.classification_name || '',
                                    pi: r.pi ?? 'NP',
                                    fc: r.fc ?? null,
                                    unit_weight_tf_m3: r.unit_weight ?? r.unit_weight_tf_m3 ?? r.rt ?? r.r_t ?? null
                                })),
                                spt_raw: sptData.map(s => ({
                                    depth_from: s.depth_from,
                                    depth_to: s.depth_to,
                                    spt_n: s.background?.nValue ?? s.nValue ?? '',
                                    pi: s.background?.pi ?? s.pi ?? 'NP',
                                    fc: s.background?.fc ?? s.fc ?? ''
                                }))
                            };
                        }
                    }
                } catch (fallbackErr) {
                    console.error('[DIGGS Import] Fallback failed:', fallbackErr);
                }
                if (!data) {
                    setDiggsStatus(
                        `Import failed: ${bh.title || bh.id} – ${e.message || 'Could not load dataset'}. Ensure SQLite preprocess is ready.`,
                        'warning'
                    );
                    errorCount++;
                    continue;
                }
            }
            if (!data) {
                console.warn(`[DIGGS Import] No data for borehole: ${bh.title}`);
                errorCount++;
                continue;
            }

            if (testType === 'SPT') {
                const layers = data.layers || [];
                const spt_raw = data.spt_raw || [];
                const lithRows = layers.map(l => ({
                    from: l.depth_from,
                    to: l.depth_to,
                    legend_code: l.soil_class || '',
                    uscs: l.soil_class || '',
                    pi: l.pi ?? 'NP',
                    fc: l.fc ?? null,
                    unit_weight: l.unit_weight_tf_m3 ?? l.unit_weight ?? l.rt ?? l.r_t ?? '',
                    spt_n: l.spt_n ?? null
                }));
                const sptPayloads = spt_raw.map(s => ({
                    depth_from: s.depth_from,
                    depth_to: s.depth_to,
                    nValue: s.spt_n ?? '',
                    pi: s.pi ?? 'NP',
                    fc: s.fc ?? ''
                }));
                const hasData = lithRows.length > 0 || sptPayloads.length > 0;
                if (!hasData) {
                    setDiggsStatus(`Borehole ${bh.title} has no SPT or layer data.`, 'warning');
                    continue;
                }
                // Use one row per SPT (all N values), not one row per lithology layer
                const lithUscs = (layers || []).map(l => ({
                    from: l.depth_from,
                    to: l.depth_to,
                    legend_code: l.soil_class || '',
                    classification_name: l.soil_class || '',
                    unit_weight_tf_m3: l.unit_weight_tf_m3 ?? l.unit_weight ?? l.rt ?? l.r_t ?? null
                }));
                console.log(`[DIGGS Import] Importing ${sptPayloads.length} SPT row(s) for ${bh.title}`);
                importSPTDataBatch(sptPayloads, bh.id, bh.title, lithUscs, null);
                importedCount += Math.max(sptPayloads.length, lithRows.length, 1);
            } else {
                // CPT: load from SQLite dataset payload cpt
                const cpt = data.cpt;
                if (!cpt || !(cpt.depths || cpt.qc)) {
                    setDiggsStatus(`Borehole ${bh.title} has no CPT data.`, 'warning');
                    continue;
                }
                try {
                    importCPTData(cpt, bh.id, bh.title);
                    importedCount++;
                } catch (err) {
                    console.error(`Error importing CPT for borehole ${bh.title}:`, err);
                    errorCount++;
                }
            }
        } catch (err) {
            console.error(`Error processing borehole ${bh.title}:`, err);
            errorCount++;
        }
    }
    
    // （ alert， status ）
    if (importedCount > 0) {
        setDiggsStatus(`Imported ${importedCount} ${testType} test(s).${errorCount > 0 ? ` (${errorCount} failed)` : ''}`, 'info');
        const scrollTarget = testType === 'CPT'
            ? document.getElementById('cpt-tabs-container')
            : (document.getElementById('borehole-tabs') || document.getElementById('dynamic-borehole-container'));
        if (scrollTarget) scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        setDiggsStatus(`No ${testType} data imported. Try selecting a borehole with ${testType} data.${errorCount > 0 ? ` (${errorCount} error(s))` : ''}`, 'warning');
    }
}

function renderDiggsGeoJSON(geojson, opts = {}) {
    if (!diggsMap || typeof L === 'undefined') return 0;
    clearDiggsLayer(true);

    diggsFeatureByKey = {};
    diggsAllFeatures = geojson.features || [];  // Store all features
    let featureCount = 0;

    // Apply filter
    const filteredFeatures = applyDiggsFilter(diggsAllFeatures);
    const filteredGeoJSON = { ...geojson, features: filteredFeatures };

    diggsLayer = L.geoJSON(filteredGeoJSON, {
        pointToLayer: function(feature, latlng) {
            const p = (feature && feature.properties) ? feature.properties : {};
            const ft = String(p.feature_type || '').toLowerCase();
            const isSounding = ft === 'sounding';
            return L.circleMarker(latlng, {
                radius: isSounding ? 4 : 5,
                color: isSounding ? 'rgba(255, 152, 0, 0.95)' : 'rgba(255, 193, 7, 0.95)',
                weight: 2,
                fillColor: isSounding ? 'rgba(255, 152, 0, 0.65)' : 'rgba(255, 193, 7, 0.65)',
                fillOpacity: 0.85
            });
        },
        onEachFeature: function(feature, layer) {
            const key = getDiggsFeatureKey(feature, featureCount);
            diggsFeatureByKey[key] = feature;
            featureCount++;

            const p = feature.properties || {};
            const title = escapeHtml(p.name || p.title || p.id || 'DIGGS Point');
            const typeText = escapeHtml(p.feature_type || '-');
            const sptCount = Number(p.spt_count || 0);
            const cptCount = Number(p.cpt_count || 0);
            const vsCount = Number(p.vs_count || 0);
            const depthText = p.total_depth ? `${escapeHtml(String(p.total_depth))} ${escapeHtml(String(p.total_depth_uom || ''))}` : '-';
            const projectRef = escapeHtml(String(p.project_ref || '-'));
            const featureId = String(p.id || '');
            const detailDomId = _diggsDetailDomId(key);

            const popupHtml = `
                <div style="min-width: 320px; max-width: 450px;">
                    <div style="font-weight: 800; margin-bottom: 8px; font-size: 14px;">${title}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Type: ${typeText}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Depth: ${depthText}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">SPT count: ${sptCount}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 3px;">CPT count: ${cptCount}</div>
                    <div style="font-size: 11px; color:#666; margin-bottom: 8px;">VS count: ${vsCount}</div>
                    <hr style="margin: 8px 0; border: none; border-top: 1px solid rgba(0,0,0,0.1);">
                    <div id="${detailDomId}" style="font-size: 11px; color:#444; margin-bottom: 10px;">Loading background…</div>
                    <button type="button" class="diggs-select-point-btn" data-diggs-key="${escapeHtml(key)}" style="padding:8px 12px; font-size: 12px; cursor:pointer; width: 100%; margin-top: 8px; background: rgba(255, 193, 7, 0.2); border: 1px solid rgba(255, 193, 7, 0.5); border-radius: 4px;">Select this point</button>
                </div>
            `;
            layer.bindPopup(popupHtml);

            layer.on('popupopen', async function() {
                try {
                    const select = document.getElementById('diggs-xml-select');
                    const xmlFile = select ? select.value : 'DIGGS_Student_Hackathon_large.XML';
                    const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
                    const el = document.getElementById(detailDomId);
                    if (!el) return;
                    
                    // Display project background information
                    const projectInfo = detail.project_info || {};
                    const parts = [];
                    
                    // Project information
                    if (projectInfo.name || projectInfo.description) {
                        parts.push('<div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 193, 7, 0.1); border-radius: 4px; border-left: 3px solid rgba(255, 193, 7, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">Project Information:</div>');
                        if (projectInfo.name) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Name:</strong> ${escapeHtml(projectInfo.name)}</div>`);
                        }
                        if (projectInfo.description) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Description:</strong> ${escapeHtml(projectInfo.description)}</div>`);
                        }
                        if (projectInfo.locality) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Location:</strong> ${escapeHtml(projectInfo.locality)}</div>`);
                        }
                        if (projectInfo.client) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Client:</strong> ${escapeHtml(projectInfo.client)}</div>`);
                        }
                        if (projectInfo.project_engineer) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Engineer:</strong> ${escapeHtml(projectInfo.project_engineer)}</div>`);
                        }
                        if (projectInfo.remark) {
                            parts.push(`<div style="font-size: 11px; color:#444; margin-bottom: 3px;"><strong>Note:</strong> ${escapeHtml(_truncateText(projectInfo.remark, 200))}</div>`);
                        }
                        parts.push('</div>');
                    }
                    
                    // Borehole-specific information
                    const desc = _truncateText(detail.description || detail.location_description || '', 200);
                    const purpose = _truncateText(detail.purpose || '', 150);
                    if (desc) parts.push(`<div style="margin-bottom:4px; font-size: 11px; padding: 4px; background: rgba(0,0,0,0.03); border-radius: 3px;"><strong>Info:</strong> ${escapeHtml(desc)}</div>`);
                    if (purpose) parts.push(`<div style="margin-bottom:4px; font-size: 11px; padding: 4px; background: rgba(0,0,0,0.03); border-radius: 3px;"><strong>Purpose:</strong> ${escapeHtml(purpose)}</div>`);
                    // Display SPT tests with background data
                    const allSptTests = detail.all_spt_tests || [];
                    if (allSptTests.length > 0) {
                        parts.push('<div style="margin-top: 12px; margin-bottom: 8px; padding: 8px; background: rgba(33, 150, 243, 0.1); border-radius: 4px; border-left: 3px solid rgba(33, 150, 243, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">SPT Tests Background Data:</div>');
                        allSptTests.forEach((sptTest, idx) => {
                            const bg = sptTest.background || {};
                            const testName = sptTest.name || sptTest.activity_id || `SPT Test ${idx + 1}`;
                            const depthFrom = sptTest.depth_from !== undefined ? sptTest.depth_from : '';
                            const depthTo = sptTest.depth_to !== undefined ? sptTest.depth_to : '';
                            const depthText = (depthFrom !== '' && depthTo !== '') ? `${depthFrom} - ${depthTo} ft` : '';
                            
                            parts.push(`<div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.6); border-radius: 3px;">`);
                            parts.push(`<div style="font-weight: 600; font-size: 10px; color:#1976d2; margin-bottom: 4px;">${escapeHtml(testName)}${depthText ? ` (${depthText})` : ''}</div>`);
                            
                            if (bg.hammerType) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Hammer Type:</strong> ${escapeHtml(bg.hammerType)}</div>`);
                            }
                            if (bg.hammerEfficiency) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Hammer Efficiency:</strong> ${escapeHtml(bg.hammerEfficiency)}%</div>`);
                            }
                            if (bg.totalPenetration) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Total Penetration:</strong> ${escapeHtml(bg.totalPenetration)} ft</div>`);
                            }
                            if (bg.nValue) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>N-Value:</strong> ${escapeHtml(bg.nValue)}</div>`);
                            }
                            if (bg.driveSets && bg.driveSets.length > 0) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Drive Sets:</strong></div>`);
                                parts.push(`<div style="margin-left: 12px; font-size: 9px; color:#666;">`);
                                bg.driveSets.forEach((ds, dsIdx) => {
                                    const index = ds.index || (dsIdx + 1);
                                    const blowCount = ds.blowCount || '-';
                                    const penetration = ds.penetration || '-';
                                    parts.push(`<div style="margin-bottom: 1px;">Set ${index}: ${blowCount} blows, ${penetration} ft penetration</div>`);
                                });
                                parts.push(`</div>`);
                            }
                            parts.push(`</div>`);
                        });
                        parts.push('</div>');
                        // Import SPT button - direct import from popup (no need to "Select this point" first)
                        parts.push(`<button type="button" class="diggs-import-spt-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsSptFromPopup==='function'){window.importDiggsSptFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(255, 193, 7, 0.25); border: 1px solid rgba(255, 193, 7, 0.6); border-radius: 4px; color: #F57F17; font-weight: 600;">Import SPT</button>`);
                    }
                    
                    // Display CPT tests with background data
                    const allCptTests = detail.all_cpt_tests || [];
                    if (allCptTests.length > 0) {
                        parts.push('<div style="margin-top: 12px; margin-bottom: 8px; padding: 8px; background: rgba(255, 193, 7, 0.1); border-radius: 4px; border-left: 3px solid rgba(255, 193, 7, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">CPT Tests Background Data:</div>');
                        allCptTests.forEach((cptTest, idx) => {
                            const bg = cptTest.background || {};
                            const testName = cptTest.test_id || cptTest.id || `CPT Test ${idx + 1}`;
                            
                            parts.push(`<div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.6); border-radius: 3px;">`);
                            parts.push(`<div style="font-weight: 600; font-size: 10px; color:#388e3c; margin-bottom: 4px;">${escapeHtml(testName)}</div>`);
                            
                            if (bg.penetrometerType) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Penetrometer Type:</strong> ${escapeHtml(bg.penetrometerType)}</div>`);
                            }
                            if (bg.distanceTipToSleeve) {
                                const uom = bg.distanceTipToSleeve_uom || 'cm';
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Distance Tip to Sleeve:</strong> ${escapeHtml(bg.distanceTipToSleeve)} ${escapeHtml(uom)}</div>`);
                            }
                            if (bg.netAreaRatioCorrection) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Net Area Ratio Correction:</strong> ${escapeHtml(bg.netAreaRatioCorrection)}</div>`);
                            }
                            if (bg.penetrationRate) {
                                const uom = bg.penetrationRate_uom || 'cm/s';
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Penetration Rate:</strong> ${escapeHtml(bg.penetrationRate)} ${escapeHtml(uom)}</div>`);
                            }
                            if (bg.tipArea) {
                                const uom = bg.tipArea_uom || 'cm²';
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Tip Area:</strong> ${escapeHtml(bg.tipArea)} ${escapeHtml(uom)}</div>`);
                            }
                            if (bg.serialNumber) {
                                parts.push(`<div style="font-size: 10px; color:#555; margin-bottom: 2px;"><strong>Serial Number:</strong> ${escapeHtml(bg.serialNumber)}</div>`);
                            }
                            parts.push(`</div>`);
                        });
                        parts.push('</div>');
                        // Import CPT button - direct import from popup
                        parts.push(`<button type="button" class="diggs-import-cpt-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsCptFromPopup==='function'){window.importDiggsCptFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(255, 193, 7, 0.25); border: 1px solid rgba(255, 193, 7, 0.6); border-radius: 4px; color: #F57F17; font-weight: 600;">Import CPT</button>`);
                    }
                    // Import Stratigraphy (depth, soil type, unit weight) - for Deep Excavation
                    const lithRowsPopup2 = detail.lithology_rows_for_import || detail.lithology_uscs || [];
                    if (lithRowsPopup2.length > 0) {
                        parts.push('<div style="margin-top: 12px; padding: 8px; background: rgba(123, 104, 238, 0.1); border-radius: 4px; border-left: 3px solid rgba(123, 104, 238, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">Layers (depth, soil type, γt)</div>');
                        parts.push(`<button type="button" class="diggs-import-stratigraphy-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsStratigraphyFromPopup==='function'){window.importDiggsStratigraphyFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 6px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(123, 104, 238, 0.2); border: 1px solid rgba(123, 104, 238, 0.5); border-radius: 4px; color: #4a148c; font-weight: 600;">Import to Deep Excavation (Stratigraphy)</button>`);
                        parts.push('</div>');
                    }
                    
                    if (!parts.length) parts.push('<div style="color:#777; font-size: 11px;">No background text found in XML for this point.</div>');
                    el.innerHTML = parts.join('');
                } catch (e) {
                    console.error('[DIGGS] Error loading detail:', e);
                    const el = document.getElementById(detailDomId);
                    if (el) el.innerHTML = `<div style="color:#b00020; font-size: 11px;">Failed to load detail: ${escapeHtml(e.message || String(e))}</div>`;
                }
            });
        }
    });

    diggsLayer.addTo(diggsMap);

    if (opts.zoomToResults) {
        try {
            const b = diggsLayer.getBounds();
            if (b && b.isValid && b.isValid()) {
                diggsMap.fitBounds(b.pad(0.12));
            }
        } catch (_) {}
    }

    return featureCount;
}

function populateDiggsXmlDropdowns() {
    fetch('/api/diggs/list-xml')
        .then(r => r.json())
        .then(function(d) {
            if (!d || d.status !== 'success' || !d.data || !d.data.files) return;
            const files = (d.data.files || []).filter(function(f) {
                const n = String((f && f.name) || '').trim();
                if (!n) return false;
                if (!/\.xml$/i.test(n)) return false;
                if (n.startsWith('.') || n.startsWith('._')) return false;
                if (n.indexOf('/._') !== -1 || n.indexOf('\\._') !== -1) return false;
                return true;
            });
            if (!files.length) return;
            const selLiq = document.getElementById('diggs-xml-select');
            const selExc = document.getElementById('diggs-xml-select-excavation');
            const selDia = document.getElementById('diggs-xml-select-diaphragm');
            const selShallow = document.getElementById('diggs-xml-select-shallow');
            const currentLiq = selLiq ? selLiq.value : '';
            const currentExc = selExc ? selExc.value : '';
            const currentDia = selDia ? selDia.value : '';
            const currentShallow = selShallow ? selShallow.value : '';
            function fill(sel) {
                if (!sel) return;
                const cur = sel === selLiq
                    ? currentLiq
                    : (sel === selExc
                        ? currentExc
                        : (sel === selDia ? currentDia : currentShallow));
                sel.innerHTML = '';
                files.forEach(function(f) {
                    const opt = document.createElement('option');
                    opt.value = f.name;
                    const label = (f.display_name || f.name) + (f.source === 'upload' ? ' (uploaded)' : '');
                    opt.textContent = label;
                    sel.appendChild(opt);
                });
                if (cur && files.some(function(x) { return x.name === cur; })) {
                    sel.value = cur;
                } else if (files.length > 0) {
                    var v1 = files.find(function(x) { return x.name && x.name.indexOf('V1') !== -1; });
                    sel.value = (v1 && v1.name) ? v1.name : files[0].name;
                }
            }
            fill(selLiq);
            fill(selExc);
            fill(selDia);
            fill(selShallow);
        })
        .catch(function() {});
}

async function handleDiggsXmlUpload(file, target) {
    if (file && file.name) {
        const n = String(file.name).trim();
        if (n.startsWith('.') || n.startsWith('._')) {
            const statusEl0 = target === 'liquefaction'
                ? document.getElementById('diggs-status')
                : (target === 'diaphragm'
                    ? document.getElementById('diggs-status-diaphragm')
                    : (target === 'shallow' ? document.getElementById('diggs-status-shallow') : document.getElementById('diggs-status-excavation')));
            if (statusEl0) {
                statusEl0.style.display = 'block';
                statusEl0.textContent = 'Hidden/system XML files (e.g., ._*.xml) are not supported.';
                statusEl0.style.background = 'rgba(244,67,54,0.1)';
                statusEl0.style.border = '1px solid rgba(244,67,54,0.4)';
            }
            return;
        }
    }
    const statusEl = target === 'liquefaction'
        ? document.getElementById('diggs-status')
        : (target === 'diaphragm'
            ? document.getElementById('diggs-status-diaphragm')
            : (target === 'shallow' ? document.getElementById('diggs-status-shallow') : document.getElementById('diggs-status-excavation')));
    const setStatus = function(msg, type) {
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = msg;
            statusEl.style.background = type === 'error' ? 'rgba(244,67,54,0.1)' : type === 'success' ? 'rgba(255, 193, 7, 0.1)' : 'rgba(0,217,255,0.06)';
            statusEl.style.border = type === 'error' ? '1px solid rgba(244,67,54,0.4)' : '1px solid rgba(0,217,255,0.25)';
        }
    };
    const overlay = document.getElementById('xml-processing-overlay');
    if (overlay) overlay.style.display = 'block';
    setStatus('Uploading and processing XML…', 'info');
    const fd = new FormData();
    fd.append('file', file);
    const uploadTimeoutMs = 300000; // 5 min for large XML preprocess
    const controller = new AbortController();
    let timeoutId = setTimeout(function() {
        controller.abort(new DOMException('Request timed out. Large XML may need several minutes. Please try again or use a smaller file.', 'AbortError'));
    }, uploadTimeoutMs);
    try {
        const resp = await fetch('/api/diggs/upload-xml', { method: 'POST', body: fd, signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await resp.json();
        if (!resp.ok) {
            throw new Error(data.message || 'Upload failed');
        }
        if (data.status !== 'success' || !data.data || !data.data.filename) {
            throw new Error(data.message || 'Upload failed');
        }
        setStatus(data.data.message || 'XML imported successfully.', 'success');
        populateDiggsXmlDropdowns();
        const sel = target === 'liquefaction'
            ? document.getElementById('diggs-xml-select')
            : (target === 'diaphragm'
                ? document.getElementById('diggs-xml-select-diaphragm')
                : (target === 'shallow' ? document.getElementById('diggs-xml-select-shallow') : document.getElementById('diggs-xml-select-excavation')));
        if (sel) {
            sel.value = data.data.filename;
            if (target === 'liquefaction') {
                fetchDiggsBoreholes({ zoomToResults: true });
            } else if (target === 'diaphragm') {
                fetchDiggsBoreholesForDiaphragm({ zoomToResults: true });
            } else if (target === 'shallow') {
                fetchDiggsBoreholesForShallow({ zoomToResults: true });
            } else {
                fetchDiggsBoreholesForExcavation({ zoomToResults: true });
            }
        }
    } catch (e) {
        setStatus('Import failed: ' + (e.message || String(e)), 'error');
    } finally {
        clearTimeout(timeoutId);
        if (overlay) overlay.style.display = 'none';
    }
}

async function fetchDiggsBoreholes(opts = {}) {
    const select = document.getElementById('diggs-xml-select');
    const xmlFile = select ? select.value : 'DIGGS_Student_Hackathon_large.XML';
    const fetchBtn = document.getElementById('fetch-diggs-btn');
    const originalBtnText = fetchBtn ? fetchBtn.innerHTML : null;
    const requestId = ++diggsLastRequestId;

    setDiggsStatus('Loading DIGGS boreholes from XML…');
    if (fetchBtn) {
        fetchBtn.disabled = true;
        fetchBtn.innerHTML = '<i class="material-icons" style="font-size: 16px; vertical-align: middle;">hourglass_empty</i> Loading...';
    }

    try {
        const resp = await fetch('/api/diggs/boreholes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ xml_file: xmlFile })
        });
        if (requestId !== diggsLastRequestId) return;

        if (!resp.ok) {
            let details = '';
            try {
                const errJson = await resp.json();
                details = errJson.message || errJson.details || JSON.stringify(errJson);
            } catch (_) {
                try { details = await resp.text(); } catch (_) {}
            }
            throw new Error(`DIGGS load failed (HTTP ${resp.status})${details ? `: ${details}` : ''}`);
        }

        const data = await resp.json();
        if (!data || data.status !== 'success' || !data.data || !data.data.geojson) {
            throw new Error(data?.message || 'DIGGS response missing GeoJSON');
        }

        const count = renderDiggsGeoJSON(data.data.geojson, { zoomToResults: !!opts.zoomToResults });
        const s = data.data.summary || {};
        const fromCache = !!data.data.from_cache;
        const sourceLabel = fromCache ? 'cache' : 'fresh preprocess';
        diggsAutoLoaded = true;
        diggsAutoLoadRetryCount = 0;
        diggsDetailIndex = data.data.detail_index || {};
        
        // Update statistics bar
        updateDiggsStatistics(s);
        
        setDiggsStatus(
            `Loaded ${count || s.map_points || 0} points (Borehole: ${s.borehole_points || 0}, Sounding: ${s.sounding_points || 0}, SPT total: ${s.total_spt_count || 0}, CPT total: ${s.total_cpt_count || 0}, VS total: ${s.total_vs_count || 0}) [${sourceLabel}]. Click a point to view details.`,
            'success'
        );
        diggsDetailCache = {};
        // Preload db into memory so borehole_detail is instant on Import
        fetch('/api/diggs/preload-db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ xml_file: xmlFile })
        }).then(r => r.json()).then(function(d) {
            if (d && d.data && !d.data.loaded) {
                setDiggsStatus('DIGGS loaded. For faster import: run "python setup_diggs_cache.py" then refresh.', 'info');
            }
        }).catch(function() {});
    } catch (err) {
        console.error('DIGGS API error:', err);
        const msg = (err && err.message) ? err.message : 'Failed to load DIGGS XML data.';
        // Do NOT clear existing layer on failure; this prevents "points disappear" during retries/rebuild.
        // Auto-retry a few times because the backend may be preprocessing cache.
        if (!diggsAutoLoaded && diggsAutoLoadRetryCount < 6) {
            diggsAutoLoadRetryCount += 1;
            const delay = Math.min(12000, 800 * Math.pow(1.7, diggsAutoLoadRetryCount));
            setDiggsStatus(`Preparing DIGGS data… retry ${diggsAutoLoadRetryCount}/6 in ${Math.round(delay/1000)}s. (${msg})`, 'warning');
            setTimeout(() => {
                // Only retry if no newer request has been started since this failure.
                if (requestId === diggsLastRequestId) {
                    fetchDiggsBoreholes({ zoomToResults: !!opts.zoomToResults });
                }
            }, delay);
        } else {
            setDiggsStatus(msg, 'error');
        }
    } finally {
        if (fetchBtn) {
            fetchBtn.disabled = false;
            if (originalBtnText) fetchBtn.innerHTML = originalBtnText;
        }
    }
}

let geosettaFetchTimer = null;
function scheduleGeosettaFetch(delayMs = 350) {
    if (geosettaFetchTimer) clearTimeout(geosettaFetchTimer);
    geosettaFetchTimer = setTimeout(() => {
        fetchGeosettaBoreholes({ zoomToResults: false });
    }, delayMs);
}

async function fetchGeosettaBoreholes(opts = {}) {
    const mode = getInputMode();
    if (mode !== 'geosetta') return;
    if (!map || !marker) {
        alert('Map is not ready yet.');
        return;
    }

    const radiusEl = document.getElementById('geosetta-radius');
    const radius_m = radiusEl ? parseFloat(radiusEl.value) : 1000;
    if (!radius_m || isNaN(radius_m) || radius_m <= 0) {
        alert('Please enter a valid radius (meters).');
        return;
    }

    const lat = marker.getLatLng().lat;
    const lon = marker.getLatLng().lng;

    const requestId = ++geosettaLastRequestId;
    setGeosettaStatus('Loading Geosetta boreholes…');

    const fetchBtn = document.getElementById('fetch-geosetta-btn');
    const originalBtnText = fetchBtn ? fetchBtn.innerHTML : null;
    if (fetchBtn) {
        fetchBtn.disabled = true;
        fetchBtn.innerHTML = '<i class="material-icons" style="font-size: 16px; vertical-align: middle;">hourglass_empty</i> Loading...';
    }

    try {
        const resp = await fetch('/api/geosetta/points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude: lat, longitude: lon, radius_m: radius_m })
        });

        if (requestId !== geosettaLastRequestId) return; // ignore stale response

        if (!resp.ok) {
            let details = '';
            try {
                const errJson = await resp.json();
                details = errJson.message || errJson.details || JSON.stringify(errJson);
            } catch (_) {
                try { details = await resp.text(); } catch (_) {}
            }
            throw new Error(`Geosetta fetch failed (HTTP ${resp.status})${details ? `: ${details}` : ''}`);
        }

        const data = await resp.json();
        if (!data || data.status !== 'success' || !data.data || !data.data.geojson) {
            throw new Error(data?.message || 'Geosetta response missing GeoJSON');
        }

        const count = renderGeosettaGeoJSON(data.data.geojson, { zoomToResults: !!opts.zoomToResults });
        setGeosettaStatus(`Loaded ${count || data.data.feature_count || 0} points from Geosetta. Click a point to select a borehole.`, 'success');
    } catch (err) {
        console.error('Geosetta error:', err);
        setGeosettaStatus((err && err.message) ? err.message : 'Failed to load Geosetta points.', 'error');
        clearGeosettaLayer(true);
    } finally {
        if (fetchBtn) {
            fetchBtn.disabled = false;
            if (originalBtnText) fetchBtn.innerHTML = originalBtnText;
        }
    }
}

//  DIGGS  Leaflet （ USGS ）
function initDiggsMap(force = false) {
    //  Leaflet 
    if (typeof L === 'undefined') {
        console.log('Leaflet ， DIGGS ');
        //  Leaflet 
        setTimeout(() => {
            if (typeof L !== 'undefined') {
                initDiggsMap(force);
            }
        }, 100);
        return;
    }
    
    const container = document.getElementById('diggs-map-container');
    if (!container) {
        console.log('DIGGS ');
        return;
    }

    if (!force) {
        const containerParent = container.closest('.page-content');
        try {
            const hiddenByStyle = containerParent && (containerParent.style.display === 'none');
            const hiddenByComputed = containerParent && (window.getComputedStyle(containerParent).display === 'none');
            if (hiddenByStyle || hiddenByComputed) return;
        } catch (_) {}
        
        // 
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            console.log('DIGGS ，');
            return;
        }
    } else {
        // ，
        if (container.offsetHeight === 0) {
            container.style.height = '600px';
        }
    }

    if (diggsMap) {
        // 
        if (container.offsetHeight === 0) {
            container.style.height = '600px';
        }
        setTimeout(() => {
            if (diggsMap) diggsMap.invalidateSize();
        }, 80);
        return;
    }

    try {
        diggsMap = L.map('diggs-map-container', {
            zoomAnimation: true,
            markerZoomAnimation: false,
            fadeAnimation: true,
            zoomControl: true,
            attributionControl: true,
            preferCanvas: true
        }).setView([30.43, -91.17], 10);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap contributors © CARTO',
            maxZoom: 20,
            minZoom: 1,
            subdomains: ['a', 'b', 'c', 'd']
        }).addTo(diggsMap);

        setTimeout(() => {
            if (diggsMap) diggsMap.invalidateSize();
        }, 120);

        // Setup filter controls
        const filterAll = document.getElementById('diggs-filter-all');
        const filterCpt = document.getElementById('diggs-filter-cpt');
        const filterSpt = document.getElementById('diggs-filter-spt');
        
        if (filterAll) {
            filterAll.addEventListener('change', function() {
                if (this.checked) {
                    diggsCurrentFilter = 'all';
                    applyDiggsFilterToMap();
                }
            });
        }
        if (filterCpt) {
            filterCpt.addEventListener('change', function() {
                if (this.checked) {
                    diggsCurrentFilter = 'cpt';
                    applyDiggsFilterToMap();
                }
            });
        }
        if (filterSpt) {
            filterSpt.addEventListener('change', function() {
                if (this.checked) {
                    diggsCurrentFilter = 'spt';
                    applyDiggsFilterToMap();
                }
            });
        }
        
        // Setup test type and borehole selection dropdowns
        const testTypeSelect = document.getElementById('diggs-test-type-select');
        const boreholeSelect = document.getElementById('diggs-borehole-select');
        
        if (testTypeSelect) {
            testTypeSelect.addEventListener('change', function() {
                updateDiggsBoreholeDropdown();
                selectDiggsBoreholeFromDropdown();
            });
        }
        
        if (boreholeSelect) {
            boreholeSelect.addEventListener('change', function() {
                selectDiggsBoreholeFromDropdown();
            });
        }

        //  init ， changeTab  2 ，
    } catch (e) {
        console.error('DIGGS map init failed:', e);
    }
}

function clearDiggsLayerExcavation(keepMap) {
    if (diggsLayerExcavation && diggsMapExcavation) {
        diggsMapExcavation.removeLayer(diggsLayerExcavation);
    }
    diggsLayerExcavation = null;
    if (!keepMap && diggsMapExcavation) {
        try { diggsMapExcavation.remove(); } catch (_) {}
        diggsMapExcavation = null;
    }
}

function initDiggsMapExcavation(force) {
    if (typeof L === 'undefined') {
        setTimeout(function() { initDiggsMapExcavation(force); }, 150);
        return;
    }
    var container = document.getElementById('diggs-map-container-excavation');
    if (!container) return;
    var page = container.closest('.page-content');
    var tab = container.closest('.excavation-tab-content');
    if (!force) {
        if (page && (page.style.display === 'none' || window.getComputedStyle(page).display === 'none')) return;
        var rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
    }
    if (tab) {
        tab.style.display = 'block';
    }
    container.style.height = '450px';
    container.style.minHeight = '450px';
    container.style.width = '100%';
    container.style.display = 'block';

    var placeholder = container.querySelector('.diggs-map-placeholder');
    if (diggsMapExcavation) {
        if (placeholder) placeholder.style.display = 'none';
        setTimeout(function() { if (diggsMapExcavation) diggsMapExcavation.invalidateSize(); }, 80);
        return;
    }

    if (placeholder) placeholder.style.display = 'none';
    try {
        diggsMapExcavation = L.map('diggs-map-container-excavation', {
            zoomAnimation: true, markerZoomAnimation: false, fadeAnimation: true,
            zoomControl: true, attributionControl: true, preferCanvas: true
        }).setView([30.43, -91.17], 10);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap contributors © CARTO',
            maxZoom: 20, minZoom: 1, subdomains: ['a', 'b', 'c', 'd']
        }).addTo(diggsMapExcavation);
        setTimeout(function() { if (diggsMapExcavation) diggsMapExcavation.invalidateSize(); }, 120);
    } catch (e) {
        console.error('DIGGS excavation map init failed:', e);
        if (placeholder) placeholder.style.display = 'flex';
    }
}

function renderDiggsGeoJSONExcavation(geojson, opts) {
    if (!diggsMapExcavation || typeof L === 'undefined') return 0;
    clearDiggsLayerExcavation(true);
    diggsExcavationFeatureIdToLayer = {};
    diggsFeatureByKey = {};
    diggsAllFeatures = geojson.features || [];
    const filteredFeatures = applyDiggsFilter(diggsAllFeatures);
    const filteredGeoJSON = { ...geojson, features: filteredFeatures };
    let featureCount = 0;

    diggsLayerExcavation = L.geoJSON(filteredGeoJSON, {
        pointToLayer: function(feature, latlng) {
            const p = (feature && feature.properties) ? feature.properties : {};
            const ft = String(p.feature_type || '').toLowerCase();
            const isSounding = ft === 'sounding';
            return L.circleMarker(latlng, {
                radius: isSounding ? 4 : 5,
                color: isSounding ? 'rgba(255, 152, 0, 0.95)' : 'rgba(255, 193, 7, 0.95)',
                weight: 2, fillColor: isSounding ? 'rgba(255, 152, 0, 0.65)' : 'rgba(255, 193, 7, 0.65)', fillOpacity: 0.85
            });
        },
        onEachFeature: function(feature, layer) {
            const featureId = String((feature.properties || {}).id || '');
            if (featureId) diggsExcavationFeatureIdToLayer[featureId] = layer;
            const key = getDiggsFeatureKey(feature, featureCount);
            diggsFeatureByKey[key] = feature;
            featureCount++;
            const p = feature.properties || {};
            const title = escapeHtml(p.name || p.title || p.id || 'DIGGS Point');
            const typeText = escapeHtml(p.feature_type || '-');
            const sptCount = Number(p.spt_count || 0);
            const cptCount = Number(p.cpt_count || 0);
            const vsCount = Number(p.vs_count || 0);
            const depthText = p.total_depth ? `${escapeHtml(String(p.total_depth))} ${escapeHtml(String(p.total_depth_uom || ''))}` : '-';
            const detailDomId = _diggsDetailDomId(key) + '-exc';
            const popupHtml = `<div style="min-width: 320px; max-width: 450px;">
                <div style="font-weight: 800; margin-bottom: 8px; font-size: 14px;">${title}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Type: ${typeText}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Depth: ${depthText}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 8px;">SPT: ${sptCount} | CPT: ${cptCount} | VS: ${vsCount}</div>
                <hr style="margin: 8px 0; border: none; border-top: 1px solid rgba(0,0,0,0.1);">
                <div id="${detailDomId}" style="font-size: 11px; color:#444; margin-bottom: 10px;">Loading…</div>
            </div>`;
            layer.bindPopup(popupHtml);
            layer.on('popupopen', async function() {
                try {
                    const select = document.getElementById('diggs-xml-select-excavation') || document.getElementById('diggs-xml-select');
                    const xmlFile = select ? (select.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
                    const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
                    const el = document.getElementById(detailDomId);
                    if (!el) return;
                    const parts = [];
                    const lithRows = detail.lithology_rows_for_import || detail.lithology_uscs || [];
                    if (lithRows.length > 0) {
                        parts.push('<div style="margin-top: 8px; padding: 8px; background: rgba(123, 104, 238, 0.1); border-radius: 4px; border-left: 3px solid rgba(123, 104, 238, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">Layers (depth, soil type, γt)</div>');
                        parts.push(`<button type="button" class="diggs-import-stratigraphy-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsStratigraphyFromPopup==='function'){window.importDiggsStratigraphyFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 6px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(123, 104, 238, 0.2); border: 1px solid rgba(123, 104, 238, 0.5); border-radius: 4px; color: #4a148c; font-weight: 600;">Import to Stratigraphic Table</button>`);
                        parts.push('</div>');
                    }
                    if (!parts.length) parts.push('<div style="color:#777; font-size: 11px;">No lithology data for this borehole.</div>');
                    el.innerHTML = parts.join('');
                } catch (e) {
                    console.error('[DIGGS Excavation] Error loading detail:', e);
                    const el = document.getElementById(detailDomId);
                    if (el) el.innerHTML = `<div style="color:#b00020; font-size: 11px;">Failed: ${escapeHtml(e.message || String(e))}</div>`;
                }
            });
        }
    });
    diggsLayerExcavation.addTo(diggsMapExcavation);
    if (opts && opts.zoomToResults) {
        try {
            const b = diggsLayerExcavation.getBounds();
            if (b && b.isValid && b.isValid()) diggsMapExcavation.fitBounds(b.pad(0.12));
        } catch (_) {}
    }
    updateDiggsExcavationBoreholeDropdown(filteredFeatures);
    return featureCount;
}

function updateDiggsExcavationBoreholeDropdown(features) {
    const bar = document.getElementById('diggs-excavation-borehole-bar');
    const countEl = document.getElementById('diggs-excavation-borehole-count');
    const select = document.getElementById('diggs-borehole-select-excavation');
    const importBtn = document.getElementById('diggs-import-stratigraphy-excavation-btn');
    if (!bar || !countEl || !select) return;
    const list = features || [];
    countEl.textContent = String(list.length);
    select.innerHTML = '<option value="">-- Select Borehole --</option>';
    list.forEach(f => {
        const p = f.properties || {};
        const id = String(p.id || '');
        const name = escapeHtml(p.name || p.title || p.id || 'Unknown');
        const typeText = (p.feature_type || '').trim() || '-';
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${name} (${typeText})`;
        opt.style.color = '#333';
        select.appendChild(opt);
    });
    bar.style.display = 'block';
    if (importBtn) importBtn.disabled = true;
}

async function fetchDiggsBoreholesForExcavation(opts) {
    const select = document.getElementById('diggs-xml-select-excavation') || document.getElementById('diggs-xml-select');
    const xmlFile = select ? (select.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    const statusEl = document.getElementById('diggs-status-excavation');
    const btn = document.getElementById('fetch-diggs-excavation-btn');
    const originalText = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="material-icons" style="font-size:16px;vertical-align:middle;">hourglass_empty</i> Loading...'; }
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Loading DIGGS data…'; statusEl.style.background = 'rgba(0, 217, 255, 0.08)'; statusEl.style.border = '1px solid rgba(0, 217, 255, 0.25)'; }
    var excContainer = document.getElementById('diggs-map-container-excavation');
    if (excContainer) {
        excContainer.style.height = '450px';
        excContainer.style.minHeight = '450px';
        excContainer.style.width = '100%';
        excContainer.style.display = 'block';
    }
    initDiggsMapExcavation(true);
    try {
        const resp = await fetch('/api/diggs/boreholes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml_file: xmlFile }) });
        if (!resp.ok) {
            const errJson = await resp.json().catch(() => ({}));
            throw new Error(errJson.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (!data || data.status !== 'success' || !data.data || !data.data.geojson) throw new Error(data?.message || 'No GeoJSON');
        diggsDetailIndex = data.data.detail_index || {};
        setTimeout(function() {
            if (diggsMapExcavation) diggsMapExcavation.invalidateSize();
        }, 100);
        const count = renderDiggsGeoJSONExcavation(data.data.geojson, { zoomToResults: true });
        if (statusEl) { statusEl.textContent = `Loaded ${count} boreholes. Click a point to import stratigraphy.`; statusEl.style.background = 'rgba(255, 193, 7, 0.1)'; statusEl.style.border = '1px solid rgba(255, 193, 7, 0.3)'; }
    } catch (err) {
        console.error('DIGGS excavation load failed:', err);
        if (statusEl) { statusEl.textContent = (err && err.message) ? err.message : 'Load failed'; statusEl.style.background = 'rgba(200, 0, 0, 0.08)'; statusEl.style.border = '1px solid rgba(200, 0, 0, 0.3)'; }
    } finally {
        if (btn) { btn.disabled = false; if (originalText) btn.innerHTML = originalText; }
    }
}

function clearDiggsLayerDiaphragm(keepMap) {
    if (diggsLayerDiaphragm && diggsMapDiaphragm) {
        diggsMapDiaphragm.removeLayer(diggsLayerDiaphragm);
    }
    diggsLayerDiaphragm = null;
    if (!keepMap && diggsMapDiaphragm) {
        try { diggsMapDiaphragm.remove(); } catch (_) {}
        diggsMapDiaphragm = null;
    }
}

function initDiggsMapDiaphragm(force) {
    if (typeof L === 'undefined') {
        setTimeout(function() { initDiggsMapDiaphragm(force); }, 150);
        return;
    }
    const container = document.getElementById('diggs-map-container-diaphragm');
    if (!container) return;
    const page = container.closest('.page-content');
    const tab = container.closest('.excavation-tab-content');
    if (!force) {
        if (page && (page.style.display === 'none' || window.getComputedStyle(page).display === 'none')) return;
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
    }
    if (tab) tab.style.display = 'block';
    container.style.height = '450px';
    container.style.minHeight = '450px';
    container.style.width = '100%';
    container.style.display = 'block';

    const placeholder = container.querySelector('.diggs-map-placeholder');
    if (diggsMapDiaphragm) {
        if (placeholder) placeholder.style.display = 'none';
        setTimeout(function() { if (diggsMapDiaphragm) diggsMapDiaphragm.invalidateSize(); }, 80);
        return;
    }

    if (placeholder) placeholder.style.display = 'none';
    try {
        diggsMapDiaphragm = L.map('diggs-map-container-diaphragm', {
            zoomAnimation: true, markerZoomAnimation: false, fadeAnimation: true,
            zoomControl: true, attributionControl: true, preferCanvas: true
        }).setView([30.43, -91.17], 10);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap contributors © CARTO',
            maxZoom: 20, minZoom: 1, subdomains: ['a', 'b', 'c', 'd']
        }).addTo(diggsMapDiaphragm);
        setTimeout(function() { if (diggsMapDiaphragm) diggsMapDiaphragm.invalidateSize(); }, 120);
    } catch (e) {
        console.error('DIGGS diaphragm map init failed:', e);
        if (placeholder) placeholder.style.display = 'flex';
    }
}

function renderDiggsGeoJSONDiaphragm(geojson, opts) {
    if (!diggsMapDiaphragm || typeof L === 'undefined') return 0;
    clearDiggsLayerDiaphragm(true);
    diggsDiaphragmFeatureIdToLayer = {};
    let featureCount = 0;
    const features = (geojson && geojson.features) || [];

    diggsLayerDiaphragm = L.geoJSON({ ...geojson, features }, {
        pointToLayer: function(feature, latlng) {
            const p = (feature && feature.properties) ? feature.properties : {};
            const ft = String(p.feature_type || '').toLowerCase();
            const isSounding = ft === 'sounding';
            return L.circleMarker(latlng, {
                radius: isSounding ? 4 : 5,
                color: isSounding ? 'rgba(255, 152, 0, 0.95)' : 'rgba(255, 193, 7, 0.95)',
                weight: 2, fillColor: isSounding ? 'rgba(255, 152, 0, 0.65)' : 'rgba(255, 193, 7, 0.65)', fillOpacity: 0.85
            });
        },
        onEachFeature: function(feature, layer) {
            const featureId = String((feature.properties || {}).id || '');
            if (featureId) diggsDiaphragmFeatureIdToLayer[featureId] = layer;
            featureCount++;
            const p = feature.properties || {};
            const title = escapeHtml(p.name || p.title || p.id || 'DIGGS Point');
            const typeText = escapeHtml(p.feature_type || '-');
            const sptCount = Number(p.spt_count || 0);
            const cptCount = Number(p.cpt_count || 0);
            const vsCount = Number(p.vs_count || 0);
            const depthText = p.total_depth ? `${escapeHtml(String(p.total_depth))} ${escapeHtml(String(p.total_depth_uom || ''))}` : '-';
            const detailDomId = _diggsDetailDomId(featureId || String(featureCount)) + '-dia';
            const popupHtml = `<div style="min-width: 320px; max-width: 450px;">
                <div style="font-weight: 800; margin-bottom: 8px; font-size: 14px;">${title}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Type: ${typeText}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Depth: ${depthText}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 8px;">SPT: ${sptCount} | CPT: ${cptCount} | VS: ${vsCount}</div>
                <hr style="margin: 8px 0; border: none; border-top: 1px solid rgba(0,0,0,0.1);">
                <div id="${detailDomId}" style="font-size: 11px; color:#444; margin-bottom: 10px;">Loading…</div>
            </div>`;
            layer.bindPopup(popupHtml);
            layer.on('popupopen', async function() {
                try {
                    const select = document.getElementById('diggs-xml-select-diaphragm') || document.getElementById('diggs-xml-select-excavation');
                    const xmlFile = select ? (select.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
                    const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
                    const el = document.getElementById(detailDomId);
                    if (!el) return;
                    const parts = [];
                    const lithRows = detail.lithology_rows_for_import || detail.lithology_uscs || [];
                    if (lithRows.length > 0) {
                        parts.push('<div style="margin-top: 8px; padding: 8px; background: rgba(123, 104, 238, 0.1); border-radius: 4px; border-left: 3px solid rgba(123, 104, 238, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">Layers (depth, soil type, γt)</div>');
                        parts.push(`<button type="button" class="diggs-import-stratigraphy-diaphragm-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsStratigraphyToDiaphragmFromPopup==='function'){window.importDiggsStratigraphyToDiaphragmFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 6px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(123, 104, 238, 0.2); border: 1px solid rgba(123, 104, 238, 0.5); border-radius: 4px; color: #4a148c; font-weight: 600;">Import to Stratigraphic Table</button>`);
                        parts.push('</div>');
                    }
                    if (!parts.length) parts.push('<div style="color:#777; font-size: 11px;">No lithology data for this borehole.</div>');
                    el.innerHTML = parts.join('');
                } catch (e) {
                    console.error('[DIGGS Diaphragm] Error loading detail:', e);
                    const el = document.getElementById(detailDomId);
                    if (el) el.innerHTML = `<div style="color:#b00020; font-size: 11px;">Failed: ${escapeHtml(e.message || String(e))}</div>`;
                }
            });
        }
    });
    diggsLayerDiaphragm.addTo(diggsMapDiaphragm);
    if (opts && opts.zoomToResults) {
        try {
            const b = diggsLayerDiaphragm.getBounds();
            if (b && b.isValid && b.isValid()) diggsMapDiaphragm.fitBounds(b.pad(0.12));
        } catch (_) {}
    }
    updateDiggsDiaphragmBoreholeDropdown(features);
    return featureCount;
}

function updateDiggsDiaphragmBoreholeDropdown(features) {
    const bar = document.getElementById('diggs-diaphragm-borehole-bar');
    const countEl = document.getElementById('diggs-diaphragm-borehole-count');
    const select = document.getElementById('diggs-borehole-select-diaphragm');
    const importBtn = document.getElementById('diggs-import-stratigraphy-diaphragm-btn');
    if (!bar || !countEl || !select) return;
    const list = features || [];
    countEl.textContent = String(list.length);
    select.innerHTML = '<option value="">-- Select Borehole --</option>';
    list.forEach(function(f) {
        const p = f.properties || {};
        const id = String(p.id || '');
        const name = escapeHtml(p.name || p.title || p.id || 'Unknown');
        const typeText = (p.feature_type || '').trim() || '-';
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${name} (${typeText})`;
        opt.style.color = '#333';
        select.appendChild(opt);
    });
    bar.style.display = 'block';
    if (importBtn) importBtn.disabled = true;
}

async function fetchDiggsBoreholesForDiaphragm(opts) {
    const select = document.getElementById('diggs-xml-select-diaphragm') || document.getElementById('diggs-xml-select-excavation');
    const xmlFile = select ? (select.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    const statusEl = document.getElementById('diggs-status-diaphragm');
    const btn = document.getElementById('fetch-diggs-diaphragm-btn');
    const originalText = btn ? btn.innerHTML : null;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="material-icons" style="font-size:16px;vertical-align:middle;">hourglass_empty</i> Loading...';
    }
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = 'Loading DIGGS data…';
        statusEl.style.background = 'rgba(0, 217, 255, 0.08)';
        statusEl.style.border = '1px solid rgba(0, 217, 255, 0.25)';
    }
    const container = document.getElementById('diggs-map-container-diaphragm');
    if (container) {
        container.style.height = '450px';
        container.style.minHeight = '450px';
        container.style.width = '100%';
        container.style.display = 'block';
    }
    initDiggsMapDiaphragm(true);
    try {
        const resp = await fetch('/api/diggs/boreholes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ xml_file: xmlFile })
        });
        if (!resp.ok) {
            const errJson = await resp.json().catch(function() { return {}; });
            throw new Error(errJson.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (!data || data.status !== 'success' || !data.data || !data.data.geojson) {
            throw new Error((data && data.message) || 'No GeoJSON');
        }
        setTimeout(function() {
            if (diggsMapDiaphragm) diggsMapDiaphragm.invalidateSize();
        }, 100);
        const count = renderDiggsGeoJSONDiaphragm(data.data.geojson, { zoomToResults: true });
        if (statusEl) {
            statusEl.textContent = `Loaded ${count} boreholes. Click a point to import stratigraphy.`;
            statusEl.style.background = 'rgba(255, 193, 7, 0.1)';
            statusEl.style.border = '1px solid rgba(255, 193, 7, 0.3)';
        }
    } catch (err) {
        console.error('DIGGS diaphragm load failed:', err);
        if (statusEl) {
            statusEl.textContent = (err && err.message) ? err.message : 'Load failed';
            statusEl.style.background = 'rgba(200, 0, 0, 0.08)';
            statusEl.style.border = '1px solid rgba(200, 0, 0, 0.3)';
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            if (originalText) btn.innerHTML = originalText;
        }
    }
}

function clearDiggsLayerShallow(keepMap) {
    if (diggsLayerShallow && diggsMapShallow) {
        diggsMapShallow.removeLayer(diggsLayerShallow);
    }
    diggsLayerShallow = null;
    if (!keepMap && diggsMapShallow) {
        try { diggsMapShallow.remove(); } catch (_) {}
        diggsMapShallow = null;
    }
}

function initDiggsMapShallow(force) {
    if (typeof L === 'undefined') {
        setTimeout(function() { initDiggsMapShallow(force); }, 150);
        return;
    }
    const container = document.getElementById('diggs-map-container-shallow');
    if (!container) return;
    const page = container.closest('.page-content');
    if (!force) {
        if (page && (page.style.display === 'none' || window.getComputedStyle(page).display === 'none')) return;
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
    }
    container.style.height = '450px';
    container.style.minHeight = '450px';
    container.style.width = '100%';
    container.style.display = 'block';

    const placeholder = container.querySelector('.diggs-map-placeholder');
    if (diggsMapShallow) {
        if (placeholder) placeholder.style.display = 'none';
        setTimeout(function() { if (diggsMapShallow) diggsMapShallow.invalidateSize(); }, 80);
        return;
    }

    if (placeholder) placeholder.style.display = 'none';
    try {
        diggsMapShallow = L.map('diggs-map-container-shallow', {
            zoomAnimation: true, markerZoomAnimation: false, fadeAnimation: true,
            zoomControl: true, attributionControl: true, preferCanvas: true
        }).setView([30.43, -91.17], 10);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap contributors © CARTO',
            maxZoom: 20, minZoom: 1, subdomains: ['a', 'b', 'c', 'd']
        }).addTo(diggsMapShallow);
        setTimeout(function() { if (diggsMapShallow) diggsMapShallow.invalidateSize(); }, 120);
    } catch (e) {
        console.error('DIGGS shallow map init failed:', e);
        if (placeholder) placeholder.style.display = 'flex';
    }
}

function renderDiggsGeoJSONShallow(geojson, opts) {
    if (!diggsMapShallow || typeof L === 'undefined') return 0;
    clearDiggsLayerShallow(true);
    diggsShallowFeatureIdToLayer = {};
    let featureCount = 0;
    const features = (geojson && geojson.features) || [];

    diggsLayerShallow = L.geoJSON({ ...geojson, features }, {
        pointToLayer: function(feature, latlng) {
            const p = (feature && feature.properties) ? feature.properties : {};
            const ft = String(p.feature_type || '').toLowerCase();
            const isSounding = ft === 'sounding';
            return L.circleMarker(latlng, {
                radius: isSounding ? 4 : 5,
                color: isSounding ? 'rgba(255, 152, 0, 0.95)' : 'rgba(255, 193, 7, 0.95)',
                weight: 2, fillColor: isSounding ? 'rgba(255, 152, 0, 0.65)' : 'rgba(255, 193, 7, 0.65)', fillOpacity: 0.85
            });
        },
        onEachFeature: function(feature, layer) {
            const featureId = String((feature.properties || {}).id || '');
            if (featureId) diggsShallowFeatureIdToLayer[featureId] = layer;
            featureCount++;
            const p = feature.properties || {};
            const title = escapeHtml(p.name || p.title || p.id || 'DIGGS Point');
            const typeText = escapeHtml(p.feature_type || '-');
            const sptCount = Number(p.spt_count || 0);
            const cptCount = Number(p.cpt_count || 0);
            const vsCount = Number(p.vs_count || 0);
            const depthText = p.total_depth ? `${escapeHtml(String(p.total_depth))} ${escapeHtml(String(p.total_depth_uom || ''))}` : '-';
            const detailDomId = _diggsDetailDomId(featureId || String(featureCount)) + '-sf';
            const popupHtml = `<div style="min-width: 320px; max-width: 450px;">
                <div style="font-weight: 800; margin-bottom: 8px; font-size: 14px;">${title}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Type: ${typeText}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 3px;">Depth: ${depthText}</div>
                <div style="font-size: 11px; color:#666; margin-bottom: 8px;">SPT: ${sptCount} | CPT: ${cptCount} | VS: ${vsCount}</div>
                <hr style="margin: 8px 0; border: none; border-top: 1px solid rgba(0,0,0,0.1);">
                <div id="${detailDomId}" style="font-size: 11px; color:#444; margin-bottom: 10px;">Loading…</div>
            </div>`;
            layer.bindPopup(popupHtml);
            layer.on('popupopen', async function() {
                try {
                    const select = document.getElementById('diggs-xml-select-shallow') || document.getElementById('diggs-xml-select');
                    const xmlFile = select ? (select.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
                    const detail = await fetchDiggsBoreholeDetail(featureId, xmlFile);
                    const el = document.getElementById(detailDomId);
                    if (!el) return;
                    const parts = [];
                    const lithRows = detail.lithology_rows_for_import || detail.lithology_uscs || [];
                    if (lithRows.length > 0) {
                        parts.push('<div style="margin-top: 8px; padding: 8px; background: rgba(123, 104, 238, 0.1); border-radius: 4px; border-left: 3px solid rgba(123, 104, 238, 0.6);">');
                        parts.push('<div style="font-weight: 600; font-size: 11px; color:#333; margin-bottom: 6px;">Layers (depth, soil type, γt)</div>');
                        parts.push(`<button type="button" class="diggs-import-stratigraphy-shallow-btn" data-feature-id="${escapeHtml(featureId)}" data-borehole-name="${escapeHtml(p.name || p.title || p.id || 'DIGGS Point')}" onclick="if(typeof window.importDiggsStratigraphyToShallowFromPopup==='function'){window.importDiggsStratigraphyToShallowFromPopup(this.dataset.featureId||'',this.dataset.boreholeName||'DIGGS Point');}return false;" style="width: 100%; margin-top: 6px; padding: 8px 12px; font-size: 12px; cursor: pointer; background: rgba(123, 104, 238, 0.2); border: 1px solid rgba(123, 104, 238, 0.5); border-radius: 4px; color: #4a148c; font-weight: 600;">Import to Soil Layers Table</button>`);
                        parts.push('</div>');
                    }
                    if (!parts.length) parts.push('<div style="color:#777; font-size: 11px;">No lithology data for this borehole.</div>');
                    el.innerHTML = parts.join('');
                } catch (e) {
                    console.error('[DIGGS Shallow] Error loading detail:', e);
                    const el = document.getElementById(detailDomId);
                    if (el) el.innerHTML = `<div style="color:#b00020; font-size: 11px;">Failed: ${escapeHtml(e.message || String(e))}</div>`;
                }
            });
        }
    });
    diggsLayerShallow.addTo(diggsMapShallow);
    if (opts && opts.zoomToResults) {
        try {
            const b = diggsLayerShallow.getBounds();
            if (b && b.isValid && b.isValid()) diggsMapShallow.fitBounds(b.pad(0.12));
        } catch (_) {}
    }
    updateDiggsShallowBoreholeDropdown(features);
    return featureCount;
}

function updateDiggsShallowBoreholeDropdown(features) {
    const bar = document.getElementById('diggs-shallow-borehole-bar');
    const countEl = document.getElementById('diggs-shallow-borehole-count');
    const select = document.getElementById('diggs-borehole-select-shallow');
    const importBtn = document.getElementById('diggs-import-stratigraphy-shallow-btn');
    if (!bar || !countEl || !select) return;
    const list = features || [];
    countEl.textContent = String(list.length);
    select.innerHTML = '<option value="">-- Select Borehole --</option>';
    list.forEach(function(f) {
        const p = f.properties || {};
        const id = String(p.id || '');
        const name = escapeHtml(p.name || p.title || p.id || 'Unknown');
        const typeText = (p.feature_type || '').trim() || '-';
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${name} (${typeText})`;
        opt.style.color = '#333';
        select.appendChild(opt);
    });
    bar.style.display = 'block';
    if (importBtn) importBtn.disabled = true;
}

async function fetchDiggsBoreholesForShallow(opts) {
    const select = document.getElementById('diggs-xml-select-shallow') || document.getElementById('diggs-xml-select');
    const xmlFile = select ? (select.value || 'DIGGS_Student_Hackathon_large.XML') : 'DIGGS_Student_Hackathon_large.XML';
    const statusEl = document.getElementById('diggs-status-shallow');
    const btn = document.getElementById('fetch-diggs-shallow-btn');
    const originalText = btn ? btn.innerHTML : null;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="material-icons" style="font-size:16px;vertical-align:middle;">hourglass_empty</i> Loading...';
    }
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = 'Loading DIGGS data…';
        statusEl.style.background = 'rgba(0, 217, 255, 0.08)';
        statusEl.style.border = '1px solid rgba(0, 217, 255, 0.25)';
    }
    const container = document.getElementById('diggs-map-container-shallow');
    if (container) {
        container.style.height = '450px';
        container.style.minHeight = '450px';
        container.style.width = '100%';
        container.style.display = 'block';
    }
    initDiggsMapShallow(true);
    try {
        const resp = await fetch('/api/diggs/boreholes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ xml_file: xmlFile })
        });
        if (!resp.ok) {
            const errJson = await resp.json().catch(function() { return {}; });
            throw new Error(errJson.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (!data || data.status !== 'success' || !data.data || !data.data.geojson) {
            throw new Error((data && data.message) || 'No GeoJSON');
        }
        diggsDetailIndex = data.data.detail_index || {};
        setTimeout(function() {
            if (diggsMapShallow) diggsMapShallow.invalidateSize();
        }, 100);
        const count = renderDiggsGeoJSONShallow(data.data.geojson, { zoomToResults: true });
        if (statusEl) {
            statusEl.textContent = `Loaded ${count} boreholes. Click a point to import stratigraphy.`;
            statusEl.style.background = 'rgba(255, 193, 7, 0.1)';
            statusEl.style.border = '1px solid rgba(255, 193, 7, 0.3)';
        }
    } catch (err) {
        console.error('DIGGS shallow load failed:', err);
        if (statusEl) {
            statusEl.textContent = (err && err.message) ? err.message : 'Load failed';
            statusEl.style.background = 'rgba(200, 0, 0, 0.08)';
            statusEl.style.border = '1px solid rgba(200, 0, 0, 0.3)';
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            if (originalText) btn.innerHTML = originalText;
        }
    }
}

//  Leaflet 
function initMap(force = false) {
    //  Leaflet 
    if (typeof L === 'undefined') {
        console.log('Leaflet ，');
        //  Leaflet 
        setTimeout(() => {
            if (typeof L !== 'undefined') {
                initMap(force);
            }
        }, 100);
        return;
    }
    
    const mapContainer = document.getElementById('map-container');
    if (!mapContainer) {
        console.error('');
        return;
    }
    
    // （）
    if (!force) {
        const containerParent = mapContainer.closest('.page-content');
        try {
            const hiddenByStyle = containerParent && (containerParent.style.display === 'none');
            const hiddenByComputed = containerParent && (window.getComputedStyle(containerParent).display === 'none');
            if (hiddenByStyle || hiddenByComputed) {
                // ， UI；
                console.log('，');
                return;
            }
        } catch (_) {
            // ignore
        }
        
        // 
        const rect = mapContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            console.log('，');
            return;
        }
    } else {
        // ，
        if (mapContainer.offsetHeight === 0) {
            mapContainer.style.height = '300px';
        }
    }
    
    // ，
    if (map) {
        console.log('，');
        // 
        if (mapContainer.offsetHeight === 0) {
            mapContainer.style.height = '300px';
        }
        setTimeout(() => {
            if (map) {
                map.invalidateSize();
            }
        }, 100);
        return;
    }
    
    // ： (37.7749, -122.4194)
    const defaultLat = 37.7749;
    const defaultLon = -122.4194;
    
    try {
        // （ - ）
        map = L.map('map-container', {
            zoomAnimation: true,       // 
            markerZoomAnimation: false, // 
            fadeAnimation: true,       // 
            zoomControl: true,
            attributionControl: true,
            preferCanvas: true,        //  Canvas （）
            // 
            doubleClickZoom: true,
            boxZoom: true,
            keyboard: true,
            scrollWheelZoom: true,
            tap: true,
            touchZoom: true,
            // 
            renderer: L.canvas({ padding: 1.0 }),  //  padding 
            // 
            worldCopyJump: false,     // 
            maxBoundsViscosity: 1.0   // 
        }).setView([defaultLat, defaultLon], 4);  // （64）
        
        //  CDN - CartoDB Positron（， API key）
        //  OpenStreetMap 
        const tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 20,
            minZoom: 1,
            subdomains: ['a', 'b', 'c', 'd'],  // 
            //  - 
            updateWhenZooming: true,   // ，
            updateWhenIdle: false,     // ，
            keepBuffer: 2,             // 
            updateInterval: 200,       // （）
            tileSize: 256,             // 
            zoomOffset: 0,             // 
            errorTileUrl: '',          // （）
            timeout: 3000,             // 3（）
            crossOrigin: true,         // 
            maxNativeZoom: 18,         // 
            detectRetina: false,       // DPI
            retries: 3,                 // 
            retryDelay: 200            // （）
        });
        
        // （，）
        const backupTileServers = [
            {
                url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
                subdomains: ['a', 'b', 'c', 'd']
            },
            {
                url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
                attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles style by <a href="https://www.hot.openstreetmap.org/" target="_blank">HOT</a>',
                subdomains: ['a', 'b', 'c']
            },
            {
                url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                subdomains: ['a', 'b', 'c']
            }
        ];
        
        // 
        let errorCount = 0;
        let currentServerIndex = -1;  // -1 （CartoDB）
        
        tileLayer.on('tileerror', function(error, tile) {
            errorCount++;
            console.warn(':', error, tile);
            
            // （10），
            if (errorCount > 10 && currentServerIndex < backupTileServers.length - 1) {
                currentServerIndex++;
                console.log(':', backupTileServers[currentServerIndex].url);
                
                // 
                if (map.hasLayer(tileLayer)) {
                    map.removeLayer(tileLayer);
                }
                
                // 
                const backupTileLayer = L.tileLayer(backupTileServers[currentServerIndex].url, {
                    attribution: backupTileServers[currentServerIndex].attribution,
                    maxZoom: 20,
                    minZoom: 1,
                    subdomains: backupTileServers[currentServerIndex].subdomains,
                    updateWhenZooming: true,
                    updateWhenIdle: false,
                    keepBuffer: 2,
                    updateInterval: 200,
                    tileSize: 256,
                    zoomOffset: 0,
                    errorTileUrl: '',
                    timeout: 3000,
                    crossOrigin: true,
                    maxNativeZoom: 18,
                    detectRetina: false,
                    retries: 3,
                    retryDelay: 200
                });
                
                // 
                backupTileLayer.on('tileerror', function(err, t) {
                    if (currentServerIndex < backupTileServers.length - 1) {
                        currentServerIndex++;
                        console.log(':', backupTileServers[currentServerIndex].url);
                        map.removeLayer(backupTileLayer);
                        // （）
                    }
                });
                
                backupTileLayer.addTo(map);
                errorCount = 0;
                
                //  tileLayer 
                tileLayer = backupTileLayer;
            }
        });
        
        // （）
        tileLayer.on('tileload', function(e) {
            // ，
            if (errorCount > 0) {
                errorCount = Math.max(0, errorCount - 1);
            }
        });
        
        // ，
        
        tileLayer.addTo(map);
        
        // 
        setTimeout(() => {
            if (map) {
                map.invalidateSize();
                // 
                const bounds = map.getBounds();
                const zoom = map.getZoom();
                // 
                map.setZoom(zoom);
                
                // 
            }
        }, 100);
        
        // （USGS / Geosetta）
        const mode = getInputMode();
        const isMapEnabledMode = mode !== 'manual';
        
        // （，）
        marker = L.marker([defaultLat, defaultLon], {
            draggable: false  // 
        }).addTo(map);
        
        // 
        if (isMapEnabledMode && marker) marker.draggable.enable();
        
        // 
        updateInputsFromMarker();
        
        // 
        marker.on('dragend', function() {
            updateInputsFromMarker();
            const modeNow = getInputMode();
            const autoLoad = document.getElementById('geosetta-auto-load');
            if (modeNow === 'geosetta' && autoLoad && autoLoad.checked) {
                scheduleGeosettaFetch(350);
            }
        });
        
        // （ USGS/Geosetta ）
        map.on('click', function(e) {
            const modeNow = getInputMode();
            if (modeNow === 'manual') return;
            
            const lat = e.latlng.lat;
            const lon = e.latlng.lng;
            
            if (marker) {
                marker.setLatLng([lat, lon]);
            } else {
                marker = L.marker([lat, lon], {
                    draggable: true
                }).addTo(map);
                marker.on('dragend', function() {
                    updateInputsFromMarker();
                });
            }
            
            updateInputsFromMarker();

            // Geosetta: auto-load points near selected location
            const autoLoad = document.getElementById('geosetta-auto-load');
            if (modeNow === 'geosetta' && autoLoad && autoLoad.checked) {
                scheduleGeosettaFetch(250);
            }
        });
        
        console.log('');
    } catch (error) {
        console.error(':', error);
    }
}

// 
function updateInputsFromMarker() {
    if (!marker) return;
    
    const lat = marker.getLatLng().lat;
    const lon = marker.getLatLng().lng;
    
    const latInput = document.getElementById('latitude-input');
    const lonInput = document.getElementById('longitude-input');
    
    if (latInput) latInput.value = lat.toFixed(4);
    if (lonInput) lonInput.value = lon.toFixed(4);
}

// 
function updateMapFromInputs() {
    const latInput = document.getElementById('latitude-input');
    const lonInput = document.getElementById('longitude-input');
    
    if (!latInput || !lonInput || !map) return;
    
    const lat = parseFloat(latInput.value);
    const lon = parseFloat(lonInput.value);
    
    if (isNaN(lat) || isNaN(lon)) return;
    
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        alert('Please enter valid latitude/longitude range:\nLatitude: -90 to 90\nLongitude: -180 to 180');
        return;
    }
    
    map.setView([lat, lon], map.getZoom());
    
    // （USGS / Geosetta）
    const mode = getInputMode();
    const isMapEnabledMode = mode !== 'manual';
    
    if (marker) {
        marker.setLatLng([lat, lon]);
        if (isMapEnabledMode) {
            marker.draggable.enable();
        } else {
            marker.draggable.disable();
        }
    } else {
        marker = L.marker([lat, lon], {
            draggable: isMapEnabledMode
        }).addTo(map);
        marker.on('dragend', function() {
            updateInputsFromMarker();
            const modeNow = getInputMode();
            const autoLoad = document.getElementById('geosetta-auto-load');
            if (modeNow === 'geosetta' && autoLoad && autoLoad.checked) {
                scheduleGeosettaFetch(350);
            }
        });
    }
}

// ==========================================
// 
// ==========================================

// 
async function searchAddress() {
    const addressInput = document.getElementById('address-search-input');
    const searchBtn = document.getElementById('search-address-btn');
    const resultDiv = document.getElementById('address-search-result');
    
    if (!addressInput || !searchBtn) return;
    
    const address = addressInput.value.trim();
    
    if (!address) {
        alert('Please enter an address or location name');
        return;
    }
    
    // 
    const originalBtnText = searchBtn.innerHTML;
    searchBtn.disabled = true;
    searchBtn.innerHTML = '<i class="material-icons" style="font-size: 16px; vertical-align: middle;">hourglass_empty</i> Searching...';
    
    if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.textContent = 'Searching...';
        resultDiv.style.color = '#666';
    }
    
    try {
        const response = await fetch('/api/geocode', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ address: address })
        });
        
        const data = await response.json();
        
        if (data.status === 'success' && data.data) {
            const { latitude, longitude, display_name } = data.data;
            
            // 
            const latInput = document.getElementById('latitude-input');
            const lonInput = document.getElementById('longitude-input');
            if (latInput) latInput.value = latitude.toFixed(4);
            if (lonInput) lonInput.value = longitude.toFixed(4);
            
            // 
            if (map) {
                map.setView([latitude, longitude], 13); //  13 
                
                // 
                if (marker) {
                    marker.setLatLng([latitude, longitude]);
                } else {
                    marker = L.marker([latitude, longitude], {
                        draggable: true
                    }).addTo(map);
                    marker.on('dragend', function() {
                        updateInputsFromMarker();
                    });
                }
            }
            
            // 
            if (resultDiv) {
                resultDiv.textContent = `Found: ${display_name}`;
                resultDiv.style.color = '#4caf50';
            }
        } else {
            // 
            const errorMsg = data.message || 'Search failed';
            alert(errorMsg);
            if (resultDiv) {
                resultDiv.textContent = errorMsg;
                resultDiv.style.color = '#d32f2f';
            }
        }
    } catch (error) {
        console.error('Address search error:', error);
        alert('Address search failed. Please check your network connection or try again later.');
        if (resultDiv) {
            resultDiv.textContent = 'Search failed';
            resultDiv.style.color = '#d32f2f';
        }
    } finally {
        // 
        searchBtn.disabled = false;
        searchBtn.innerHTML = originalBtnText;
    }
}

// ==========================================
// USGS API 
// ==========================================

//  USGS 
async function fetchUSGSData() {
    const latInput = document.getElementById('latitude-input');
    const lonInput = document.getElementById('longitude-input');
    const riskCategorySelect = document.getElementById('risk-category-select');
    const codeModelSelect = document.getElementById('code-model-select');
    const fetchBtn = document.getElementById('fetch-usgs-btn');
    const resultsDiv = document.getElementById('usgs-results');
    
    if (!latInput || !lonInput || !riskCategorySelect) {
        alert('Cannot find required form elements');
        return;
    }
    
    const lat = parseFloat(latInput.value);
    const lon = parseFloat(lonInput.value);
    const riskCategory = riskCategorySelect.value;
    const deaggVs30Input = document.getElementById('deagg-vs30');
    const deaggVs30 = deaggVs30Input ? parseFloat(deaggVs30Input.value) : 760;
    
    // Combined selection: "designCode|deaggModel"
    const codeModelValue = codeModelSelect ? codeModelSelect.value : 'asce7-22|conus-2018';
    const parts = String(codeModelValue).split('|');
    const designCode = parts[0] || 'asce7-22';
    const deaggModel = parts[1] || 'conus-2018';

    // Site Class is auto-derived from Vs30
    const siteClass = inferSiteClassFromVs30(isNaN(deaggVs30) ? 760 : deaggVs30) || 'D';

    const requestPayload = {
        latitude: lat,
        longitude: lon,
        siteClass: siteClass,
        riskCategory: riskCategory,
        designCode: designCode,
        deaggModel: deaggModel,
        deaggVs30: isNaN(deaggVs30) ? 760 : deaggVs30
    };
    console.log('USGS request payload:', requestPayload);
    
    // 
    if (isNaN(lat) || isNaN(lon)) {
        alert('Please select a location on the map or enter valid latitude/longitude');
        return;
    }
    
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        alert('Please enter valid latitude/longitude range:\nLatitude: -90 to 90\nLongitude: -180 to 180');
        return;
    }
    
    // 
    const originalBtnText = fetchBtn.innerHTML;
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '<i class="material-icons" style="font-size: 16px; vertical-align: middle;">hourglass_empty</i> Fetching...';
    
    try {
        // （30）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        //  API
        const response = await fetch('/api/usgs/seismic', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestPayload),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            // Try to surface backend error details instead of generic "network" text
            let details = '';
            try {
                const errJson = await response.json();
                if (errJson && (errJson.message || errJson.details)) {
                    details = errJson.message || errJson.details;
                } else {
                    details = JSON.stringify(errJson);
                }
            } catch (_) {
                try {
                    details = await response.text();
                } catch (_) {}
            }
            const msg = `USGS fetch failed (HTTP ${response.status})${details ? `: ${details}` : ''}`;
            throw new Error(msg);
        }
        
        const data = await response.json();
        
        if (data.status === 'success') {
            // 
            displayUSGSResults(data.data);
            
            //  PGA_M 
            updatePGAInForm(data.data.pgaM);
            
            //  Mw ，
            if (!data.data.meanMw && !data.data.modeMw) {
                console.log('No Mw data available from Deaggregation API');
            }
            
        } else {
            // 
            let errorMsg = 'Failed to fetch USGS data: ' + (data.message || 'Unknown error');
            
            // ，
            if (data.debug) {
                console.error('USGS API debug info:', data.debug);
                errorMsg += '\n\nDebug info (check browser console):';
                errorMsg += '\nResponse keys: ' + JSON.stringify(data.debug.response_keys);
                errorMsg += '\nData keys: ' + JSON.stringify(data.debug.response_data_keys);
            }
            
            alert(errorMsg);
            if (resultsDiv) resultsDiv.style.display = 'none';
            
            // 
            console.error('USGS API error details:', data);
        }
        
    } catch (error) {
        console.error('USGS API error:', error);
        let errorMsg = 'Unable to fetch USGS data. ';
        if (error.name === 'AbortError') {
            errorMsg += 'Request timed out (30 seconds). The USGS API may be slow or unavailable.';
        } else {
            errorMsg += (error && error.message) ? error.message : 'Please check your network connection.';
        }
        alert(errorMsg);
        if (resultsDiv) resultsDiv.style.display = 'none';
    } finally {
        // 
        fetchBtn.disabled = false;
        fetchBtn.innerHTML = originalBtnText;
    }
}

//  USGS 
function displayUSGSResults(data) {
    const resultsDiv = document.getElementById('usgs-results');
    const pgamSpan = document.getElementById('result-pgam');
    const sdsSpan = document.getElementById('result-sds');
    const sd1Span = document.getElementById('result-sd1');
    const tlSpan = document.getElementById('result-tl');
    const meanMw475Span = document.getElementById('result-mean-mw-475');
    const meanMw2475Span = document.getElementById('result-mean-mw-2475');
    const meanR475Span = document.getElementById('result-mean-r-475');
    const meanEps475Span = document.getElementById('result-mean-eps-475');
    const meanR2475Span = document.getElementById('result-mean-r-2475');
    const meanEps2475Span = document.getElementById('result-mean-eps-2475');
    const modelSpan = document.getElementById('result-deagg-model');
    const vs30Span = document.getElementById('result-deagg-vs30');
    const siteClassUsedSpan = document.getElementById('result-site-class-used');
    
    if (!resultsDiv) return;
    
    // 
    if (pgamSpan) pgamSpan.textContent = (data.pgaM !== null && data.pgaM !== undefined) ? data.pgaM.toFixed(4) : 'N/A';
    if (modelSpan) modelSpan.textContent = data.deaggModel ? String(data.deaggModel) : 'N/A';
    if (vs30Span) vs30Span.textContent = (data.deaggVs30 !== null && data.deaggVs30 !== undefined) ? String(data.deaggVs30) : 'N/A';
    if (siteClassUsedSpan) siteClassUsedSpan.textContent = data.siteClass ? String(data.siteClass) : 'N/A';
    // Prefer explicit 475/2475 fields; fall back to legacy meanMw
    const mw475 = (data.meanMw475 !== null && data.meanMw475 !== undefined && !isNaN(data.meanMw475)) ? parseFloat(data.meanMw475) : null;
    const mw2475 = (data.meanMw2475 !== null && data.meanMw2475 !== undefined && !isNaN(data.meanMw2475)) ? parseFloat(data.meanMw2475) : (
        (data.meanMw !== null && data.meanMw !== undefined && !isNaN(data.meanMw)) ? parseFloat(data.meanMw) : null
    );
    if (meanMw475Span) meanMw475Span.textContent = (mw475 !== null) ? mw475.toFixed(2) : 'N/A';
    if (meanMw2475Span) meanMw2475Span.textContent = (mw2475 !== null) ? mw2475.toFixed(2) : 'N/A';

    const r475 = (data.meanDistanceKm475 !== null && data.meanDistanceKm475 !== undefined && !isNaN(data.meanDistanceKm475)) ? parseFloat(data.meanDistanceKm475) : null;
    const eps475 = (data.meanEpsilon475 !== null && data.meanEpsilon475 !== undefined && !isNaN(data.meanEpsilon475)) ? parseFloat(data.meanEpsilon475) : null;
    const r2475 = (data.meanDistanceKm2475 !== null && data.meanDistanceKm2475 !== undefined && !isNaN(data.meanDistanceKm2475)) ? parseFloat(data.meanDistanceKm2475) : null;
    const eps2475 = (data.meanEpsilon2475 !== null && data.meanEpsilon2475 !== undefined && !isNaN(data.meanEpsilon2475)) ? parseFloat(data.meanEpsilon2475) : null;

    if (meanR475Span) meanR475Span.textContent = (r475 !== null) ? r475.toFixed(1) : 'N/A';
    if (meanEps475Span) meanEps475Span.textContent = (eps475 !== null) ? eps475.toFixed(2) : 'N/A';
    if (meanR2475Span) meanR2475Span.textContent = (r2475 !== null) ? r2475.toFixed(1) : 'N/A';
    if (meanEps2475Span) meanEps2475Span.textContent = (eps2475 !== null) ? eps2475.toFixed(2) : 'N/A';
    if (sdsSpan) sdsSpan.textContent = (data.sds !== null && data.sds !== undefined) ? data.sds.toFixed(4) : 'N/A';
    if (sd1Span) sd1Span.textContent = (data.sd1 !== null && data.sd1 !== undefined) ? data.sd1.toFixed(4) : 'N/A';
    if (tlSpan) tlSpan.textContent = (data.tL !== null && data.tL !== undefined) ? data.tL.toFixed(2) : 'N/A';
    
    //  Mw （ Deaggregation API  Mw）
    console.log('USGS Data received:', data); // 
    console.log('meanMw:', data.meanMw, 'modeMw:', data.modeMw); // 
    
    // Mw note + internal Mw value (avoid stale note/value from a previous request)
    const noteText = document.getElementById('mw-note-text');
    const noteDiv = resultsDiv.querySelector('.mw-note');
    const mwInput = document.getElementById('usgs-mw'); // hidden input

    if (mw2475 !== null) {
        // Auto-fill Mw using 2475-year Mean Mw (common liquefaction standard)
        if (mwInput) {
            mwInput.value = mw2475.toFixed(2);
            console.log('Updated Mw input to:', mwInput.value);
        }

        if (noteText && noteDiv) {
            const noteMsg =
                `Mean Mw (475yr): ${mw475 !== null ? mw475.toFixed(2) : 'N/A'}, r=${r475 !== null ? r475.toFixed(1) : 'N/A'} km, ε0=${eps475 !== null ? eps475.toFixed(2) : 'N/A'} | ` +
                `Mean Mw (2475yr): ${mw2475.toFixed(2)}, r=${r2475 !== null ? r2475.toFixed(1) : 'N/A'} km, ε0=${eps2475 !== null ? eps2475.toFixed(2) : 'N/A'} (from USGS Deaggregation API)`;
            noteText.textContent = noteMsg;
            noteDiv.style.display = 'block';
            console.log('Displayed Mw note:', noteMsg);
        }

        // JS fallback for later analysis
        window.usgsMwValue = mw2475;
        // Keep full USGS payload for Excel export / reporting
        window.usgsSeismicData = data;
    } else {
        console.log('No Mw data available or Mw is invalid');

        // Clear stale UI note from previous requests
        if (noteText) noteText.textContent = '';
        if (noteDiv) noteDiv.style.display = 'none';

        // Reset Mw to default fallback to avoid using a previous location's Mw
        if (mwInput) mwInput.value = '7.5';
        window.usgsMwValue = null;
        window.usgsSeismicData = data;
    }
    
    // 
    resultsDiv.style.display = 'block';
}

// ==========================================
// Return Period Info Modal
// ==========================================
function openReturnPeriodModal() {
    const modal = document.getElementById('return-period-modal');
    if (modal) modal.style.display = 'flex';
}

function closeReturnPeriodModal() {
    const modal = document.getElementById('return-period-modal');
    if (modal) modal.style.display = 'none';
}

function openNshmModelModal() {
    const modal = document.getElementById('nshm-model-modal');
    if (modal) {
        modal.style.display = 'flex';
        const content = modal.querySelector('.nshm-model-modal-content');
        if (content) content.scrollTop = 0;
    }
}

function closeNshmModelModal() {
    const modal = document.getElementById('nshm-model-modal');
    if (modal) modal.style.display = 'none';
}

// ==========================================
// CPT Workflow / Formulas Modal
// ==========================================
function openCptWorkflowModal() {
    const modal = document.getElementById('cpt-workflow-modal');
    if (modal) modal.style.display = 'block';
}

function closeCptWorkflowModal() {
    const modal = document.getElementById('cpt-workflow-modal');
    if (modal) modal.style.display = 'none';
}

function openSptDiggsNoticeModal() {
    const modal = document.getElementById('spt-diggs-notice-modal');
    if (modal) modal.style.display = 'flex';
}

function closeSptDiggsNoticeModal() {
    const modal = document.getElementById('spt-diggs-notice-modal');
    if (modal) modal.style.display = 'none';
}

function openDiaphragmDiggsSoilNoticeModal() {
    const modal = document.getElementById('diaphragm-diggs-soil-notice-modal');
    if (modal) modal.style.display = 'flex';
}

function closeDiaphragmDiggsSoilNoticeModal() {
    const modal = document.getElementById('diaphragm-diggs-soil-notice-modal');
    if (modal) modal.style.display = 'none';
}

function openShallowDiggsSoilNoticeModal() {
    const modal = document.getElementById('shallow-diggs-soil-notice-modal');
    if (modal) modal.style.display = 'flex';
}

function closeShallowDiggsSoilNoticeModal() {
    const modal = document.getElementById('shallow-diggs-soil-notice-modal');
    if (modal) modal.style.display = 'none';
}

//  PGA_M 
function updatePGAInForm(pgamValue) {
    if (pgamValue === null || pgamValue === undefined) return;
    
    //  PGA_M （ Analysis Conditions ）
    const pgaInputs = document.querySelectorAll('input[type="number"]');
    for (let input of pgaInputs) {
        const label = input.closest('.form-group')?.querySelector('label');
        if (label && label.textContent.includes('PGA')) {
            input.value = pgamValue.toFixed(2);
            //  change 
            input.dispatchEvent(new Event('change', { bubbles: true }));
            break;
        }
    }
}

// ==========================================
// Excavation Analysis Functions
// ==========================================

//  Uplift 
function drawUpliftDiagram() {
    const container = document.getElementById('uplift-diagram');
    if (!container || typeof Plotly === 'undefined') {
        return;
    }
    
    const layout = {
        xaxis: { range: [0, 7], showgrid: false, zeroline: false, visible: false, fixedrange: true },
        yaxis: { range: [-8, 1], showgrid: false, zeroline: false, visible: false, fixedrange: true },
        margin: { l: 0, r: 0, t: 0, b: 0 },
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
        shapes: [
            // Ground surface
            { type: 'line', x0: 0, y0: 0, x1: 7, y1: 0, line: { color: '#333', width: 2 } },
            // Excavation
            { type: 'rect', x0: 0, x1: 3.3, y0: -2, y1: 0, fillcolor: 'rgba(200,200,200,0.3)', line: { width: 1, color: '#666' } },
            // Soil layers
            { type: 'rect', x0: 0, x1: 3.3, y0: -4, y1: -2, fillcolor: 'rgba(173,216,230,0.4)', line: { width: 1, color: '#666' } },
            { type: 'rect', x0: 0, x1: 3.3, y0: -6, y1: -4, fillcolor: 'rgba(200,150,100,0.4)', line: { width: 1, color: '#666' } },
            // Wall
            { type: 'rect', x0: 3.3, x1: 3.7, y0: -6, y1: 0, fillcolor: '#666', line: { width: 0 } },
            // Water level
            { type: 'line', x0: 0, y0: -1, x1: 3.3, y1: -1, line: { color: 'blue', width: 2, dash: 'dash' } },
            // Labels
            { type: 'line', x0: 0, y0: -4, x1: 3.3, y1: -4, line: { color: 'red', width: 2 } }
        ],
        annotations: [
            { x: 1.65, y: -1, text: 'Water Level', showarrow: false, font: { size: 10, color: 'blue' } },
            { x: 1.65, y: -4, text: 'Interface (U layer)', showarrow: false, font: { size: 10, color: 'red' } },
            { x: 1.65, y: -1.5, text: 'Uw', showarrow: true, arrowhead: 2, ax: 0, ay: -20, font: { size: 12, color: 'blue' } },
            { x: 1.65, y: -3, text: 'Σγti×hi', showarrow: true, arrowhead: 2, ax: 0, ay: 20, font: { size: 12, color: '#F9A825' } },
            { x: 3.5, y: 0.5, text: 'Uplift occurs when water pressure (Uw) exceeds the total weight of overlying soil layers (Σγti×hi).', showarrow: false, font: { size: 9, color: '#333' }, xanchor: 'left', bgcolor: 'rgba(255,255,255,0.8)', bordercolor: '#ccc', borderwidth: 1 }
        ]
    };
    
    Plotly.newPlot(container, [], layout, { displayModeBar: false, staticPlot: true, responsive: true });
}

//  Sand Boil 
function drawSandBoilDiagram() {
    const container = document.getElementById('sand-boil-diagram');
    if (!container || typeof Plotly === 'undefined') {
            return;
        }
        
    const layout = {
        xaxis: { range: [0, 7], showgrid: false, zeroline: false, visible: false, fixedrange: true },
        yaxis: { range: [-8, 1], showgrid: false, zeroline: false, visible: false, fixedrange: true },
        margin: { l: 0, r: 0, t: 0, b: 0 },
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
        shapes: [
            // Ground surface
            { type: 'line', x0: 0, y0: 0, x1: 7, y1: 0, line: { color: '#333', width: 2 } },
            // Excavation
            { type: 'rect', x0: 0, x1: 3.3, y0: -2, y1: 0, fillcolor: 'rgba(200,200,200,0.3)', line: { width: 1, color: '#666' } },
            // Soil layer with γsub (thickness D)
            { type: 'rect', x0: 0, x1: 3.3, y0: -2, y1: -4.5, fillcolor: 'rgba(173,216,230,0.4)', line: { width: 1, color: '#666' } },
            // Impermeable layer [U]
            { type: 'rect', x0: 0, x1: 3.3, y0: -4.5, y1: -6.5, fillcolor: 'rgba(200,150,100,0.4)', line: { width: 1, color: '#666' } },
            // Wall
            { type: 'rect', x0: 3.3, x1: 3.7, y0: -6.5, y1: 0, fillcolor: '#666', line: { width: 0 } },
            // Water level
            { type: 'line', x0: 0, y0: -1, x1: 3.3, y1: -1, line: { color: 'blue', width: 2, dash: 'dash' } },
            // ΔH_w arrow
            { type: 'line', x0: 3.5, y0: -1, x1: 3.5, y1: -2, line: { color: 'red', width: 2, arrowhead: 2 } }
        ],
        annotations: [
            { x: 1.65, y: -1, text: 'Water Level', showarrow: false, font: { size: 10, color: 'blue' } },
            { x: 1.65, y: -3.25, text: 'D (γsub)', showarrow: false, font: { size: 10, color: '#F9A825' } },
            { x: 3.8, y: -1.5, text: 'ΔH_w', showarrow: false, font: { size: 10, color: 'red' } },
            { x: 1.65, y: -5.5, text: 'Interface (U layer)', showarrow: false, font: { size: 10, color: 'brown' } },
            { x: 3.5, y: 0.5, text: 'Sand boil occurs when water head difference (ΔH_w) causes upward seepage through permeable layers (D) below the excavation.', showarrow: false, font: { size: 9, color: '#000' }, xanchor: 'left', bgcolor: 'rgba(255,255,255,0.8)', bordercolor: '#ccc', borderwidth: 1 }
        ]
    };
    
    Plotly.newPlot(container, [], layout, { displayModeBar: false, staticPlot: true, responsive: true });
}

// （）- 
function updateExcavationProfilePlot() {
    const container = document.getElementById('excavation-profile-plot');
    if (!container || typeof Plotly === 'undefined') {
        return;
    }
    
    // 
    const wallLength = parseFloat(document.getElementById('excavation-wall-length')?.value || 21.0);
    
    // 
    const layers = [];
    const strataTable = document.getElementById('stratigraphic-table-body');
    if (strataTable) {
        const rows = strataTable.querySelectorAll('tr');
        rows.forEach((row) => {
        const depth = parseFloat(row.querySelector('.strata-depth')?.value || 0);
            const gamma = parseFloat(row.querySelector('.strata-gamma')?.value || 0);
        const type = row.querySelector('.strata-type')?.value || 'D';
        const code = row.querySelector('.strata-code')?.value || '';
            
        if (depth > 0) {
                layers.push({ bot_depth: depth, gamma: gamma, type: type, code: code });
            }
        });
    }
    
    // 
    const maxDepth = Math.max(
        ...layers.map(l => l.bot_depth),
        wallLength,
        10
    ) + 5;
    
    // 
    const shapes = [];
    const annotations = [];
    
    // 
    shapes.push({
        type: 'line',
        x0: 0, x1: 10,
        y0: 0, y1: 0,
        line: { color: '#333', width: 2 }
    });
    
    //  GL+0 
    const unitSystem = getCurrentUnitSystem();
    const depthUnit = unitSystem === 'metric' ? 'm' : 'ft';
    annotations.push({
        x: 9.5, y: 0.2,
        text: `GL+0 (${depthUnit})`,
        showarrow: false,
        font: { size: 12, color: 'red' },
        xref: 'x',
        yref: 'y'
    });
    
    // （）
    let excavationDepth = 0;
    const stagesTable = document.getElementById('excavation-stages-table');
    if (stagesTable) {
        const rows = stagesTable.querySelectorAll('tbody tr');
        if (rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            excavationDepth = parseFloat(lastRow.querySelector('.stage-depth')?.value || 0);
        }
    }
    
    // 
    let prevDepth = 0;
    const lastLayerIndex = layers.length - 1;
    
    layers.forEach((layer, index) => {
        const botDepth = layer.bot_depth;
        const isU = layer.type === 'U' || layer.type === 'UNDRAINED';
        // U ，D 
        const color = isU ? 'rgba(120, 80, 40, 0.6)' : 'rgba(240, 230, 140, 0.5)';
        
        // ，
        const actualBottomDepth = (index === lastLayerIndex) ? maxDepth : botDepth;
        
        // 
        const layerTop = prevDepth;
        const layerBottom = actualBottomDepth;
        
        // ，
        if (layerTop < wallLength && layerBottom > wallLength) {
            // 
            // ：
            const upperTop = -layerTop;
            const upperBottom = -wallLength;
            if (upperTop > upperBottom) {
                // （）- 
                if (wallLength > excavationDepth) {
                    const leftTop = -Math.max(layerTop, excavationDepth);
                    const leftBottom = -wallLength;
            if (leftTop > leftBottom) {
                // ，
                // ， wallLength 
                shapes.push({
                    type: 'rect',
                    x0: 0, x1: 4.85,
                            y0: leftBottom, y1: leftTop,
                    fillcolor: color,
                            line: { width: 0 }
                });
                // 
                shapes.push({
                    type: 'line',
                    x0: 0, x1: 4.85,
                    y0: leftTop, y1: leftTop,
                    line: { color: '#888', width: 1 }
                });
                shapes.push({
                    type: 'line',
                    x0: 0, x1: 0,
                    y0: leftBottom, y1: leftTop,
                    line: { color: '#888', width: 1 }
                });
                shapes.push({
                    type: 'line',
                    x0: 4.85, x1: 4.85,
                    y0: leftBottom, y1: leftTop,
                    line: { color: '#888', width: 1 }
                });
            }
        }
                // （）
                // ，
                // ， wallLength 
            shapes.push({
                type: 'rect',
                x0: 5.15, x1: 10,
                    y0: upperBottom, y1: upperTop,
                fillcolor: color,
                    line: { width: 0 }
            });
            // 
            shapes.push({
                type: 'line',
                x0: 5.15, x1: 10,
                y0: upperTop, y1: upperTop,
                line: { color: '#888', width: 1 }
            });
            shapes.push({
                type: 'line',
                x0: 5.15, x1: 5.15,
                y0: upperBottom, y1: upperTop,
                line: { color: '#888', width: 1 }
            });
            shapes.push({
                type: 'line',
                x0: 10, x1: 10,
                y0: upperBottom, y1: upperTop,
                line: { color: '#888', width: 1 }
            });
            }
            // ：，
            // ：， wallLength 
            const lowerTop = -wallLength;
            const lowerBottom = -layerBottom;
            if (lowerTop > lowerBottom) {
            // ，
                shapes.push({
                    type: 'rect',
                    x0: 0, x1: 10,
                    y0: lowerBottom, y1: lowerTop,
                    fillcolor: color,
                    line: { width: 0 } // 
                });
            // ，（ wallLength ）
                shapes.push({
                type: 'line',
                    x0: 0, x1: 10,
                y0: lowerBottom, y1: lowerBottom,
                line: { color: '#888', width: 1 }
            });
    shapes.push({
                type: 'line',
                x0: 0, x1: 0,
                y0: lowerBottom, y1: lowerTop,
                line: { color: '#888', width: 1 }
            });
    shapes.push({
        type: 'line',
                x0: 10, x1: 10,
                y0: lowerBottom, y1: lowerTop,
                line: { color: '#888', width: 1 }
            });
            }
        } else if (layerBottom > wallLength) {
            // ，
            //  if ， layerTop >= wallLength
            //  layerTop 
            const continuousTop = -layerTop;
            const continuousBottom = -layerBottom;
            if (continuousTop > continuousBottom) {
                // ，
                //  layerTop == wallLength，， wallLength 
    shapes.push({
        type: 'rect',
        x0: 0, x1: 10,
                    y0: continuousBottom, y1: continuousTop,
                    fillcolor: color,
                    line: { width: 0 } // 
                });
                // 
    shapes.push({
        type: 'line',
        x0: 0, x1: 10,
                    y0: continuousBottom, y1: continuousBottom,
                    line: { color: '#888', width: 1 }
                });
                shapes.push({
                    type: 'line',
                    x0: 0, x1: 0,
                    y0: continuousBottom, y1: continuousTop,
                    line: { color: '#888', width: 1 }
                });
                shapes.push({
                    type: 'line',
                    x0: 10, x1: 10,
                    y0: continuousBottom, y1: continuousTop,
                    line: { color: '#888', width: 1 }
                });
                //  layerTop > wallLength 
                if (layerTop > wallLength) {
                    shapes.push({
                        type: 'line',
                        x0: 0, x1: 10,
                        y0: continuousTop, y1: continuousTop,
                        line: { color: '#888', width: 1 }
                    });
                }
            }
        } else {
            // ，
            
            // （）- 
            if (layerBottom > excavationDepth) {
                const leftTop = -Math.max(layerTop, excavationDepth);
                const leftBottom = -layerBottom;
                if (leftTop > leftBottom) {
            shapes.push({
                type: 'rect',
                x0: 0, x1: 4.85,
                        y0: leftBottom, y1: leftTop,
                        fillcolor: color,
                        line: { color: '#888', width: 1 }
                    });
                }
            }
            
            // （）- （，）
            const rightTop = -layerTop;
            const rightBottom = -layerBottom;
            if (rightTop > rightBottom) {
            shapes.push({
                type: 'rect',
                    x0: 5.15, x1: 10,
                    y0: rightBottom, y1: rightTop,
                    fillcolor: color,
                    line: { color: '#888', width: 1 }
                });
            }
        }
        
        //  [D]  [U] 
        // 
        const layerMidDepth = -(prevDepth + actualBottomDepth) / 2;
        const layerLabel = `[${layer.type}]`;
        const soilType = layer.code || '';
        
        // 
            annotations.push({
            x: 7.5, y: layerMidDepth,
            text: layerLabel,
                showarrow: false, 
            font: { size: 14, color: 'black', family: 'Arial' },
            xref: 'x',
            yref: 'y'
        });
        
        // ，
        if (soilType) {
            annotations.push({
                x: 8.5, y: layerMidDepth,
                text: soilType,
                showarrow: false,
                font: { size: 12, color: 'black' },
                xref: 'x',
                yref: 'y'
            });
        }
        
        prevDepth = botDepth; //  prevDepth  botDepth，
    });
    
    // （，）
    if (excavationDepth > 0) {
        shapes.push({
            type: 'rect',
            x0: 0, x1: 4.85,
            y0: -excavationDepth, y1: 0,
            fillcolor: 'rgba(200, 200, 200, 0.3)',
            line: { color: '#333', width: 2 }
        });
        
        // 
                shapes.push({
                    type: 'line',
                    x0: 0, x1: 4.85,
            y0: -excavationDepth, y1: -excavationDepth,
            line: { color: '#333', width: 3 }
        });
        
        // 
                annotations.push({
            x: 2.4,
            y: -excavationDepth,
            text: 'Excavation Surface',
                    showarrow: false,
            font: { size: 12, color: '#333', family: 'Arial' },
            xref: 'x',
            yref: 'y',
            xanchor: 'center',
            yanchor: 'top',
            bgcolor: 'rgba(255, 255, 255, 0.8)',
            bordercolor: '#333',
            borderwidth: 1
        });
    }
    
    // （）
    // ，
                shapes.push({
        type: 'rect',
        x0: 4.85, x1: 5.15,
        y0: -wallLength, y1: 0,
        fillcolor: '#999',
        line: { width: 0 }
    });
    
    const layout = {
        xaxis: {
            range: [0, 10],
            showgrid: false,
            zeroline: false,
            visible: false, 
            fixedrange: false 
        },
        yaxis: {
            range: [-maxDepth, 1],
            showgrid: false, 
            zeroline: false, 
            visible: true, 
            fixedrange: false,
            title: getDepthUnitLabel(),
            autorange: false
        },
        margin: { l: 60, r: 20, t: 40, b: 20 },
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
        shapes: shapes,
        annotations: annotations,
        title: {
            text: 'Interactive Excavation Profile',
            font: { size: 14 }
        }
    };
    
    Plotly.newPlot(container, [], layout, { 
        displayModeBar: true, 
        staticPlot: false, 
        responsive: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    });
}

// （，）
function updateExcavationPlot() {
    drawUpliftDiagram();
    drawSandBoilDiagram();
}

// （ DIGGS Import Stratigraphy）
function fillStratigraphicTableFromLayers(layers) {
    const numSelect = document.getElementById('excavation-num-strata');
    const tbody = document.getElementById('stratigraphic-table-body');
    if (!numSelect || !tbody) {
        console.warn('[Stratigraphy] excavation-num-strata or stratigraphic-table-body not found');
        return false;
    }
    const n = Math.min(Math.max(layers.length, 1), 10);
    numSelect.value = String(n);
    updateStratigraphicTable(layers);
    return true;
}

function getExcavationInterfaceList() {
    const rows = document.querySelectorAll('#stratigraphic-table-body tr');
    const interfaces = [];
    rows.forEach((row) => {
        const type = (row.querySelector('.strata-type')?.value || 'D').toUpperCase();
        const depth = parseFloat(row.querySelector('.strata-depth')?.value || 0);
        const code = (row.querySelector('.strata-code')?.value || '').trim();
        if ((type === 'U' || type === 'UNDRAINED') && Number.isFinite(depth) && depth > 0) {
            interfaces.push({ depth, code: code || 'U' });
        }
    });
    return interfaces;
}

function syncExcavationInterfaceInputs() {
    const interfaces = getExcavationInterfaceList();
    if (!interfaces.length) {
        return { interfaces: [], selectedIndex: -1, selected: null };
    }
    // When UI inputs exist, allow user to pick nearest interface by depth; otherwise use first U-layer
    const depthInput = document.getElementById('excavation-interface-depth');
    const descInput = document.getElementById('excavation-interface-desc');
    let idx = 0;
    if (depthInput && descInput) {
        const typedDepth = parseFloat(depthInput.value);
        if (Number.isFinite(typedDepth)) {
            idx = interfaces.reduce((bestIdx, itf, currentIdx, arr) => {
                const bestDiff = Math.abs(arr[bestIdx].depth - typedDepth);
                const curDiff = Math.abs(itf.depth - typedDepth);
                return curDiff < bestDiff ? currentIdx : bestIdx;
            }, 0);
        }
        const selected = interfaces[idx];
        depthInput.value = Number(selected.depth).toFixed(2);
        depthInput.dataset.interfaceIndex = String(idx);
        const currentDesc = (descInput.value || '').trim();
        if (!currentDesc || currentDesc.toLowerCase() === 'interface') {
            descInput.value = selected.code || `Interface ${idx + 1}`;
        }
    }
    const selected = interfaces[idx];
    return { interfaces, selectedIndex: idx, selected };
}

// （ customLayers ）
function updateStratigraphicTable(customLayers) {
    const numStrata = parseInt(document.getElementById('excavation-num-strata')?.value || 9);
    const tbody = document.getElementById('stratigraphic-table-body');
    const unitSystem = getCurrentUnitSystem();
    const M_TO_FT = 3.28084;
    const KN_M3_TO_PCF = 6.36588;
    
    if (!tbody) {
        console.error('stratigraphic-table-body not found');
        return;
    }
    
    console.log(`Generating ${numStrata} strata rows`);
    
    // （）
    const defaultLayers = [
        { code: 'SF', type: 'D', depth: 1.3, gamma: 19.03 },
        { code: 'CL', type: 'U', depth: 4.2, gamma: 16.97 },
        { code: 'SM', type: 'D', depth: 6.1, gamma: 18.93 },
        { code: 'ML', type: 'D', depth: 8.5, gamma: 18.14 },
        { code: 'CL', type: 'U', depth: 10.6, gamma: 17.26 },
        { code: 'ML', type: 'D', depth: 17.0, gamma: 18.14 },
        { code: 'SM', type: 'D', depth: 23.2, gamma: 18.44 },
        { code: 'CL', type: 'U', depth: 24.7, gamma: 17.46 },
        { code: 'GW', type: 'D', depth: 28.2, gamma: 21.57 }
    ];
    
    // 
    tbody.innerHTML = '';
    
    // 
    const layersToUse = Array.isArray(customLayers) && customLayers.length > 0 ? customLayers : null;
    const effectiveNum = layersToUse ? Math.min(layersToUse.length, 10) : numStrata;
    
    for (let i = 0; i < effectiveNum; i++) {
        const row = document.createElement('tr');
        
        // ，
        const layerData = layersToUse ? layersToUse[i] : (defaultLayers[i] || {
            code: i === 0 ? 'SF' : i === 1 ? 'CL' : 'SM',
            type: (i === 0 || i === 2) ? 'D' : 'U',
            depth: (i + 1) * 3.0,
            gamma: 18.5
        });
        const displayDepth = unitSystem === 'imperial' ? (Number(layerData.depth) * M_TO_FT) : Number(layerData.depth);
        const displayGamma = unitSystem === 'imperial' ? (Number(layerData.gamma) * KN_M3_TO_PCF) : Number(layerData.gamma);
        
        row.innerHTML = `
            <td style="text-align: center; padding: 8px;">${i + 1}</td>
            <td style="padding: 8px;">
                <input type="text" class="strata-code" value="${layerData.code}" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" onchange="updateStratigraphicIllustrate();">
            </td>
            <td style="padding: 8px;">
                <select class="strata-type" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" onchange="updateStratigraphicIllustrate(); updateExcavationProfilePlot(); updateExcavationStagesTable();">
                    <option value="D" ${layerData.type === 'D' ? 'selected' : ''}>D</option>
                    <option value="U" ${layerData.type === 'U' ? 'selected' : ''}>U</option>
                </select>
            </td>
            <td style="padding: 8px;">
                <input type="number" class="strata-depth" value="${displayDepth.toFixed(1)}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" onchange="updateStratigraphicIllustrate(); updateExcavationProfilePlot(); updateExcavationStagesTable();">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="strata-gamma" value="${displayGamma.toFixed(2)}" step="0.01" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" onchange="updateExcavationProfilePlot();">
            </td>
            <td style="padding: 8px; text-align: center; background-color: #f5f5f5; color: #666; font-size: 12px;" class="illustrate-uplift" readonly>-</td>
            <td style="padding: 8px; text-align: center; background-color: #f5f5f5; color: #666; font-size: 12px;" class="illustrate-sand-boil" readonly>-</td>
        `;
        
        tbody.appendChild(row);
    }
    
    //  Illustrate 
    updateStratigraphicIllustrate();
    
    // 
    updateExcavationProfilePlot();
}

//  Illustrate 
function updateStratigraphicIllustrate() {
    const rows = document.querySelectorAll('#stratigraphic-table-body tr');
    const layers = [];
    
    rows.forEach((row, index) => {
    const depth = parseFloat(row.querySelector('.strata-depth')?.value || 0);
        const type = row.querySelector('.strata-type')?.value || 'D';
        const code = row.querySelector('.strata-code')?.value || '';
        
        if (depth > 0) {
            layers.push({ bot_depth: depth, type: type, code: code });
        }
    });
    
    //  U （interfaces）
    const interfaces = [];
    layers.forEach((layer, index) => {
        if (layer.type === 'U' || layer.type === 'UNDRAINED') {
            interfaces.push({
                depth: layer.bot_depth,
                code: layer.code,
                index: index
            });
        }
    });
    
    //  Illustrate 
    rows.forEach((row, index) => {
        const layer = layers[index];
        if (!layer) return;
        
        const upliftCell = row.querySelector('.illustrate-uplift');
        const sandBoilCell = row.querySelector('.illustrate-sand-boil');
        
        if (!upliftCell || !sandBoilCell) return;
        
        //  Uplift （： U  interface）
        if (layer.type === 'U' || layer.type === 'UNDRAINED') {
            const interfaceIndex = interfaces.findIndex(i => i.depth === layer.bot_depth);
            if (interfaceIndex >= 0) {
                const unitSystem = getCurrentUnitSystem();
                const depthUnit = unitSystem === 'metric' ? 'm' : 'ft';
                const displayDepth = unitSystem === 'metric' ? layer.bot_depth : layer.bot_depth * 3.28084;
                upliftCell.textContent = `Interface ${interfaceIndex + 1}: GL-${displayDepth.toFixed(2)}${depthUnit}`;
                upliftCell.style.color = '#333';
            } else {
                upliftCell.textContent = '-';
                upliftCell.style.color = '#999';
            }
        } else {
            upliftCell.textContent = '-';
            upliftCell.style.color = '#999';
        }
        
        //  Sand Boil （：D ，U ）
        if (layer.type === 'D' || layer.type === 'DRAINED') {
            sandBoilCell.textContent = 'Sand Boil Potential';
            sandBoilCell.style.color = '#333';
        } else {
            sandBoilCell.textContent = 'Cohesive Layer';
            sandBoilCell.style.color = '#333';
        }
        
        // 
        upliftCell.setAttribute('readonly', 'true');
        sandBoilCell.setAttribute('readonly', 'true');
    });

    // Keep target-interface UI aligned with current U-layers.
    syncExcavationInterfaceInputs();
}

// ：1st, 2nd, 3rd, 4th, ...
function ordinalSuffix(n) {
    const j = n % 10, k = n % 100;
    if (j === 1 && k !== 11) return n + 'st';
    if (j === 2 && k !== 12) return n + 'nd';
    if (j === 3 && k !== 13) return n + 'rd';
    return n + 'th';
}

// 
function updateExcavationStagesTable() {
    const numStages = parseInt(document.getElementById('excavation-order')?.value || 4);
    const tbody = document.getElementById('excavation-stages-table-body');
    const thead = document.getElementById('excavation-stages-table-head');
    
    if (!tbody || !thead) {
        console.error('excavation-stages-table-body or head not found');
        return;
    }
    
    console.log(`Generating ${numStages} excavation stage rows`);
    
    // （）
    const strataRows = document.querySelectorAll('#stratigraphic-table-body tr');
    const layers = [];
    let prevDepth = 0;
    strataRows.forEach((row) => {
        const depth = parseFloat(row.querySelector('.strata-depth')?.value || 0);
        const type = row.querySelector('.strata-type')?.value || 'D';
        const code = row.querySelector('.strata-code')?.value || '';
        
        if (depth > 0) {
            layers.push({
                top: prevDepth,
                bottom: depth,
                type: type,
                code: code
            });
            prevDepth = depth;
        }
    });
    
    // U（）
    const uLayers = layers.filter(l => l.type === 'U').sort((a, b) => a.top - b.top);
    const uLayerCount = uLayers.length;
    
    // ：DwU
    const unitSystem = getCurrentUnitSystem();
    const depthUnit = unitSystem === 'metric' ? '(m)' : '(ft)';
    let headerHTML = `<tr><th>Excavation Stage</th><th>Depth ${depthUnit}</th>`;
    for (let i = 0; i < uLayerCount; i++) {
        headerHTML += `<th>D<sub>w,${i + 1}</sub> ${depthUnit}</th>`;
    }
    headerHTML += '</tr>';
    thead.innerHTML = headerHTML;
    
    // 
    tbody.innerHTML = '';
    
    // 
    const gwtInput = document.getElementById('excavation-gwt')?.value || '2,4.5,8';
    const gwtLevels = gwtInput.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
    
    // （）
    const defaultStages = [
        { depth: 2.2, waterLevels: [2, 4.5, 8] },
        { depth: 5.3, waterLevels: [2, 4.5, 8] },
        { depth: 8.3, waterLevels: [2, 7.2, 8] },
        { depth: 11.9, waterLevels: [2, 7.2, 8] }
    ];
    
    // UD（UD，U）
    // ：U layerD layerDw，
    //       U D D，DDw，
    const uLayerDGroups = [];
    for (let i = 0; i < uLayers.length; i++) {
        const uLayer = uLayers[i];
        const nextULayer = i < uLayers.length - 1 ? uLayers[i + 1] : null;
        
        // UD（U）
        const dLayersBelow = [];
        for (const layer of layers) {
            if (layer.type === 'D' && layer.top >= uLayer.bottom) {
                // U，DU，U
                if (nextULayer === null || layer.bottom <= nextULayer.top) {
                    dLayersBelow.push(layer);
                } else {
                    break; // U
                }
            }
        }
        uLayerDGroups.push({
            uLayer: uLayer,
            dLayers: dLayersBelow
        });
    }
    
    // 
    for (let i = 0; i < numStages; i++) {
        const row = document.createElement('tr');
        
        // ，
        const stageData = defaultStages[i] || {
            depth: (i + 1) * 2.0,
            waterLevels: gwtLevels.length > 0 ? gwtLevels : [2.0]
        };
        
        let rowHTML = `
            <td style="text-align: center; padding: 8px;">${i + 1}</td>
            <td style="padding: 8px;">
                <input type="number" class="stage-depth" value="${stageData.depth.toFixed(1)}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" onchange="updateExcavationProfilePlot(); updateExcavationStagesTable();">
            </td>
        `;
        
        // UDw（UDDw）
        for (let j = 0; j < uLayerCount; j++) {
            const uGroup = uLayerDGroups[j];
            
            // UDw（）
            const waterLevel = stageData.waterLevels[j] || (gwtLevels[j] || 2.0);
            rowHTML += `
                <td style="padding: 8px;">
                    <input type="number" class="stage-water-level" data-ulayer-index="${j}" value="${waterLevel.toFixed(1)}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" onchange="updateExcavationProfilePlot();">
                </td>
            `;
        }
        
        rowHTML += '</tr>';
        row.innerHTML = rowHTML;
        tbody.appendChild(row);
    }
    
    // 
    updateExcavationProfilePlot();
}

// 
function initExcavationPage() {
    console.log('Initializing Deep Excavation page...');
    
    // 
    updateStratigraphicTable();
    
    // 
    updateExcavationStagesTable();
    
    if (typeof Plotly === 'undefined') {
        console.error('Plotly not loaded');
        return;
    }
    
    drawUpliftDiagram();
    drawSandBoilDiagram();
    updateExcavationProfilePlot();
    console.log('Deep Excavation page initialized');
}

// （）
function updateExcavationMainPlot() {
    const container = document.getElementById('excavation-plot-container');
    if (!container || typeof Plotly === 'undefined') {
        return;
    }
    
    // 
    const unitSystem = getCurrentUnitSystem();
    const depthUnit = unitSystem === 'metric' ? 'm' : 'ft';
    const wallLength = parseFloat(document.getElementById('excavation-wall-length')?.value || 21.0);
    const gwtInput = document.getElementById('excavation-gwt')?.value || '2.0';
    const gwtLevels = gwtInput.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
    const gwt = gwtLevels.length > 0 ? gwtLevels[0] : 2.0;
    
    // 
    const layers = [];
    const strataTable = document.getElementById('stratigraphic-table-body');
    if (strataTable) {
        const rows = strataTable.querySelectorAll('tr');
        rows.forEach((row) => {
        const depth = parseFloat(row.querySelector('.strata-depth')?.value || 0);
            const gamma = parseFloat(row.querySelector('.strata-gamma')?.value || 0);
        const type = row.querySelector('.strata-type')?.value || 'D';
        const code = row.querySelector('.strata-code')?.value || '';
            
        if (depth > 0) {
                layers.push({ bot_depth: depth, gamma: gamma, type: type, code: code });
            }
        });
    }
    
    // 
    const stages = [];
    const stagesTable = document.getElementById('excavation-stages-table');
    if (stagesTable) {
        const rows = stagesTable.querySelectorAll('tbody tr');
        rows.forEach((row, index) => {
            const depth = parseFloat(row.querySelector('.stage-depth')?.value || 0);
            if (depth > 0) {
                // 
                const waterLevelInput = row.querySelector('.stage-water-level');
                const waterLevel = waterLevelInput ? parseFloat(waterLevelInput.value || gwt) : gwt;
                stages.push({ name: `Stage ${index + 1}`, depth: depth, water_level: waterLevel });
            }
        });
    }
    
    // 
    const maxDepth = Math.max(
        ...layers.map(l => l.bot_depth),
        wallLength,
        ...stages.map(s => s.depth),
        10
    ) + 5;
    
    // 
    const shapes = [];
    const annotations = [];
    
    // 
    let prevDepth = 0;
    layers.forEach((layer) => {
        const botDepth = layer.bot_depth;
        const isU = layer.type === 'U' || layer.type === 'UNDRAINED';
        const color = isU ? 'rgba(120, 80, 40, 0.6)' : 'rgba(240, 230, 140, 0.5)';
        
        // （）
        if (prevDepth < wallLength) {
        shapes.push({
            type: 'rect',
                x0: 0, x1: 4.85,
                y0: -Math.min(botDepth, wallLength), y1: -prevDepth,
            fillcolor: color,
                line: { color: '#888', width: 1 }
            });
        }
        
        // （）
        if (botDepth > wallLength) {
            shapes.push({
                type: 'rect',
                x0: 5.15, x1: 10,
                y0: -botDepth, y1: -Math.max(prevDepth, wallLength),
                fillcolor: color,
                line: { color: '#888', width: 1 }
            });
        }
        
        prevDepth = botDepth;
    });
    
    // 
    shapes.push({ 
        type: 'rect', 
        x0: 4.85, x1: 5.15,
        y0: -wallLength, y1: 0,
        fillcolor: '#666',
        line: { width: 0 }
    });

    // （）
    const currentStage = stages.length > 0 ? stages[stages.length - 1] : null;
    if (currentStage) {
        // 
        shapes.push({
            type: 'rect',
            x0: 0, x1: 4.85,
            y0: -currentStage.depth, y1: 0,
            fillcolor: 'rgba(200, 200, 200, 0.3)',
            line: { color: '#333', width: 2 }
        });
        
        // 
        if (currentStage.water_level > 0) {
        shapes.push({
            type: 'line',
                x0: 0, x1: 10,
                y0: -currentStage.water_level, y1: -currentStage.water_level,
            line: { color: 'blue', width: 2, dash: 'dash' }
        });
        annotations.push({ 
                x: 5, y: -currentStage.water_level,
                text: `Water Level: ${currentStage.water_level.toFixed(2)} ${depthUnit}`,
            showarrow: false, 
                font: { size: 12, color: 'blue' },
                bgcolor: 'rgba(255,255,255,0.8)',
                bordercolor: 'blue',
                borderwidth: 1
        });
        }
    }

    const layout = {
        xaxis: { range: [0, 10], showgrid: false, zeroline: false, visible: false, fixedrange: false },
        yaxis: { 
            range: [-maxDepth, 1], 
            showgrid: true, 
            zeroline: false, 
            visible: true, 
            fixedrange: false,
            title: `Depth (${depthUnit})`,
            autorange: false
        },
        margin: { l: 60, r: 20, t: 40, b: 20 },
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
        shapes: shapes,
        annotations: annotations,
        title: {
            text: 'Excavation Profile (Interactive)',
            font: { size: 16 }
        }
    };
    
    Plotly.newPlot(container, [], layout, { 
        displayModeBar: true, 
        staticPlot: false, 
        responsive: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    });
}

// 
async function runExcavationAnalysis() {
    const modal = document.getElementById('excavationAnalysisModal');
    const modalContent = document.getElementById('excavation-modal-content');
    if (!modal || !modalContent) {
        alert('Modal display area not found');
        return;
    }
    
    // 
    modal.style.display = 'flex';
    modalContent.innerHTML = '<p style="color: #a0522d; font-weight: bold; text-align: center; padding: 40px;">Calculating excavation analysis...</p>';
    
    try {
        // 
        const wallLength = parseFloat(document.getElementById('excavation-wall-length')?.value || 21.0);
        const gwtInput = document.getElementById('excavation-gwt')?.value || '2.0';
        const gwtLevels = gwtInput.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        const gwtGl = gwtLevels.length > 0 ? gwtLevels[0] : 2.0;
        const syncInfo = syncExcavationInterfaceInputs();
        if (!syncInfo.interfaces || syncInfo.interfaces.length === 0) {
            alert('Please define at least one U layer as the target interface.');
            closeExcavationAnalysisModal();
            return;
        }
        const interfaceIndex = Number.isInteger(syncInfo.selectedIndex) && syncInfo.selectedIndex >= 0 ? syncInfo.selectedIndex : 0;
        const interfaceDepth = syncInfo.interfaces[interfaceIndex].depth;
        const interfaceDesc = (syncInfo.selected?.code || syncInfo.interfaces[interfaceIndex]?.code || `Interface ${interfaceIndex + 1}`).trim() || `Interface ${interfaceIndex + 1}`;
        
    //  Uplift  Sand Boil 
    const analyzeUplift = true;
    const analyzeSandBoil = true;
    const fsURequired = parseFloat(document.getElementById('fs-u-required')?.value || 1.2);
    const fsP1Required = parseFloat(document.getElementById('fs-p1-required')?.value || 1.5);
    const fsP2Required = parseFloat(document.getElementById('fs-p2-required')?.value || 2.0);
    
        // 
    const layers = [];
        const strataTableBody = document.getElementById('stratigraphic-table-body');
        if (strataTableBody) {
            const rows = strataTableBody.querySelectorAll('tr');
            rows.forEach((row) => {
                const depth = parseFloat(row.querySelector('.strata-depth')?.value || 0);
                const gamma = parseFloat(row.querySelector('.strata-gamma')?.value || 0);
        const type = row.querySelector('.strata-type')?.value || 'D';
                const code = row.querySelector('.strata-code')?.value || '';
        
        if (depth > 0 && gamma > 0) {
                    layers.push({ bot_depth: depth, gamma: gamma, type: type, code: code });
                }
            });
        }
        
        console.log('Collected layers:', layers.length, layers);
        
        // （ stage  D）
    const stages = [];
        const stagesTableBody = document.getElementById('excavation-stages-table-body');
        if (stagesTableBody) {
            const rows = stagesTableBody.querySelectorAll('tr');
            rows.forEach((row, index) => {
                const depth = parseFloat(row.querySelector('.stage-depth')?.value || 0);
        if (depth > 0) {
                    //  Dw （ U  Dw）
                    const waterLevelInputs = row.querySelectorAll('.stage-water-level');
                    const waterLevels = [];
                    waterLevelInputs.forEach(input => {
                        const value = parseFloat(input.value);
                        if (!isNaN(value) && input.value.trim() !== '') {
                            waterLevels.push(value);
                        } else {
                            // ，
                            waterLevels.push(gwtLevels[waterLevels.length] || gwtGl);
                        }
                    });
            stages.push({
                        name: `${ordinalSuffix(index + 1)} Stage`,
                        depth: depth,
                        water_levels: waterLevels.length > 0 ? waterLevels : [gwtGl]
            });
        }
    });
        }
        
        console.log('Collected stages:', stages.length, stages, '(each stage will have D calculated)');
    
        if (layers.length === 0) {
            alert('Please enter at least one soil layer');
            closeExcavationAnalysisModal();
        return;
    }
    
        if (stages.length === 0) {
            alert('Please enter at least one excavation stage');
            closeExcavationAnalysisModal();
            return;
        }
        
        console.log('Request data:', {
            layers: layers.length,
            stages: stages.length,
                analyze_uplift: analyzeUplift,
            analyze_sand_boil: analyzeSandBoil
        });
        
            const unitSystem = getCurrentUnitSystem();
            const requestData = {
                unit_system: unitSystem,
                wall_length: wallLength,
                gwt_gl: gwtGl,
                interface_depth: interfaceDepth,
                interface_desc: interfaceDesc,
                interface_index: interfaceIndex,
                layers: layers,
                stages: stages,
                analyze_uplift: analyzeUplift,
                analyze_sand_boil: analyzeSandBoil,
                fs_u_required: fsURequired,
                fs_p1_required: fsP1Required,
                fs_p2_required: fsP2Required
            };
        
        //  API
        const response = await fetch('/api/excavation/calculate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Error Response:', errorText);
            throw new Error(`API: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        
        console.log('=== API Response ===');
        console.log('Full response:', JSON.stringify(data, null, 2));
        console.log('Response status:', data.status);
        console.log('Uplift results:', data.uplift_results);
        console.log('Uplift results count:', data.uplift_results?.length || 0);
        console.log('Sand boil results:', data.sand_boil_results);
        console.log('Sand boil results count:', data.sand_boil_results?.length || 0);
        console.log('Metadata:', data.metadata);
        
        if (data.status !== 'success') {
            throw new Error(data.message || 'Calculation failed');
        }
        
        // 
        window.excavationRequestData = requestData;
            
            // 
        console.log('=== Calling displayExcavationResults ===');
        try {
            displayExcavationResults(data);
            console.log('displayExcavationResults completed successfully');
        } catch (displayError) {
            console.error('Error in displayExcavationResults:', displayError);
            const modalContent = document.getElementById('excavation-modal-content');
            if (modalContent) {
                modalContent.innerHTML = `<p style="color: #d32f2f;">Error displaying results: ${displayError.message}</p>`;
            }
            throw displayError;
        }
        
        
    } catch (error) {
        console.error('Excavation analysis error:', error);
        const modalContent = document.getElementById('excavation-modal-content');
        if (modalContent) {
            modalContent.innerHTML = `<p style="color: #d32f2f;">Error: ${error.message}</p>`;
        }
    }
}

//  - 
function displayExcavationResults(data) {
    console.log('=== displayExcavationResults START ===');
    console.log('Full data:', JSON.stringify(data, null, 2));
    
    const modal = document.getElementById('excavationAnalysisModal');
    const modalContent = document.getElementById('excavation-modal-content');
    if (!modal || !modalContent) {
        console.error('excavationAnalysisModal or excavation-modal-content not found');
        alert('Cannot find modal display area');
        return;
    }
    
    const upliftResults = data.uplift_results || [];
    const sandBoilResults = data.sand_boil_results || [];
    const metadata = data.metadata || {};
    
    console.log('Uplift results:', upliftResults);
    console.log('Uplift results length:', upliftResults.length);
    console.log('Sand boil results:', sandBoilResults);
    console.log('Sand boil results length:', sandBoilResults.length);
    
    let html = '<div class="excavation-results-section"><h3 style="color: #1e293b; margin-bottom: 16px; font-size: 17px; font-weight: 600;">Analysis Summary</h3>';
    
    // （ Stage, Status, FS）
    if (upliftResults && Array.isArray(upliftResults) && upliftResults.length > 0) {
        html += '<div class="excavation-results-section"><h4>Uplift Analysis</h4>';
        
        for (let idx = 0; idx < upliftResults.length; idx++) {
            const interfaceData = upliftResults[idx];
            const interfaceName = interfaceData.interface || `Interface ${idx + 1}`;
            const stages = interfaceData.stages || [];
            
            html += `<div class="excavation-results-subsection"><h5>${escapeHtml(interfaceName)}</h5>`;
            html += '<table class="excavation-results-table"><thead><tr>';
            html += '<th>Stage</th><th>Check Result</th>';
            html += '</tr></thead><tbody>';
            
            if (stages && Array.isArray(stages) && stages.length > 0) {
                for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
                    const stage = stages[stageIdx];
                    const stageName = stage.Stage || '';
                    const result = stage.Result || stage.Note || '';
                    const status = stage.Status || 'OK';
                    
                    const resultColor = (status === 'NG' || String(status).includes('NG') || String(result).includes('NG')) ? '#dc2626' : 
                                       (String(result).toLowerCase().includes('no check') || String(result).toLowerCase().includes('')) ? '#64748b' : '#059669';
                    
                    html += '<tr>';
                    html += `<td>${escapeHtml(String(stageName || ''))}</td>`;
                    html += `<td style="color: ${resultColor}; font-weight: 600;">${escapeHtml(String(result || status || ''))}</td>`;
                    html += '</tr>';
                }
            } else {
                html += '<tr><td colspan="2" style="padding: 16px; text-align: center; color: #64748b; background-color: #f8fafc; font-size: 14px;">No data</td></tr>';
            }
            
            html += '</tbody></table></div>';
        }
        
        html += '</div>';
    } else {
        html += '<div style="padding: 14px 18px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px;">';
        html += '<p style="color: #64748b; margin: 0; font-size: 14px;">No uplift analysis results.</p>';
        html += '</div>';
    }
    
    // 
    if (sandBoilResults && sandBoilResults.length > 0) {
        html += '<div class="excavation-results-section"><h4>Sand Boil Analysis</h4>';
        html += '<table class="excavation-results-table"><thead><tr>';
        html += '<th>Stage</th><th>Check Result</th>';
        html += '</tr></thead><tbody>';
        
        for (let idx = 0; idx < sandBoilResults.length; idx++) {
            const result = sandBoilResults[idx];
            const stageName = result.Stage || '';
            const checkResult = result.Result || result.Note || result.Status || result.status || '';
            
            const resultColor = (checkResult === 'NG' || String(checkResult).includes('NG')) ? '#dc2626' : 
                               (String(checkResult).toLowerCase().includes('no check') || String(checkResult).toLowerCase().includes('')) ? '#64748b' : '#059669';
            
            html += '<tr>';
            html += `<td>${escapeHtml(String(stageName || ''))}</td>`;
            html += `<td style="color: ${resultColor}; font-weight: 600;">${escapeHtml(String(checkResult || ''))}</td>`;
            html += '</tr>';
        }
        
        html += '</tbody></table></div>';
    } else {
        html += '<div style="padding: 14px 18px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px;">';
        html += '<p style="color: #64748b; margin: 0; font-size: 14px;">No sand boil analysis results.</p>';
        html += '</div>';
    }
    
    html += '</div>';
    
    // （）
    if ((upliftResults && upliftResults.length > 0) || (sandBoilResults && sandBoilResults.length > 0)) {
        html += '<div style="text-align: center; margin-top: 24px; padding-top: 20px; border-top: 1px solid #e2e8f0;">';
        html += '<button id="download-excavation-excel-btn" class="btn-run" style="padding: 12px 24px; font-size: 14px; background-color: #334155; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">';
        html += '<i class="material-icons" style="font-size: 18px; vertical-align: middle; margin-right: 6px;">download</i> Download Report';
        html += '</button>';
        html += '</div>';
    }
    
    console.log('=== Setting HTML content ===');
    console.log('HTML length:', html.length);
    console.log('HTML preview (first 500 chars):', html.substring(0, 500));
    
    try {
        modalContent.innerHTML = html;
        console.log('HTML content set successfully');
    } catch (htmlError) {
        console.error('Error setting HTML:', htmlError);
        modalContent.innerHTML = `<p style="color: #d32f2f;">Error setting HTML content: ${htmlError.message}</p>`;
        return;
    }
    
    //  modal
    modal.style.display = 'flex';
    
    // 
    const closeBtn = modal.querySelector('.close-btn');
    if (closeBtn) {
        // （）
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        // 
        newCloseBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            closeExcavationAnalysisModal();
        });
    }
    
    console.log('Modal display style:', modal.style.display);
    
    // 
    setTimeout(() => {
        const tables = modalContent.querySelectorAll('table');
        console.log('=== Table Check ===');
        console.log('Number of tables found in modal:', tables.length);
        tables.forEach((table, idx) => {
            const tbody = table.querySelector('tbody');
            const rows = tbody ? tbody.querySelectorAll('tr') : [];
            console.log(`Table ${idx + 1}:`, {
                hasTbody: !!tbody,
                tbodyRows: rows.length,
                allRows: table.querySelectorAll('tr').length,
                visible: table.offsetHeight > 0,
                display: window.getComputedStyle(table).display,
                innerHTML_length: table.innerHTML.length
            });
            
            // 
            rows.forEach((row, rowIdx) => {
                const cells = row.querySelectorAll('td');
                console.log(`  Row ${rowIdx + 1}: ${cells.length} cells`, {
                    firstCell: cells[0] ? cells[0].textContent : 'N/A',
                    visible: row.offsetHeight > 0
                });
            });
        });
        
        // （excavation ）
        const excResultArea = document.getElementById('excavation-result-area');
        if (excResultArea) {
            excResultArea.style.display = 'block';
            excResultArea.style.visibility = 'visible';
            excResultArea.style.opacity = '1';
            excResultArea.style.height = 'auto';
            excResultArea.style.minHeight = '100px';
        }
    }, 300);
    
    // 
    setTimeout(() => {
        const downloadBtn = document.getElementById('download-excavation-excel-btn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', downloadExcavationCalculationReport);
            console.log('Download button event listener attached');
        } else {
            console.warn('Download button not found after setting HTML');
        }
    }, 100);
}

// ：
function formatValue(value) {
    if (value === null || value === undefined) return '';
    if (value === '-') return '-';
    if (typeof value === 'number') {
        return value.toFixed(2);
    }
    return String(value);
}

//  Excavation Analysis Modal
function closeExcavationAnalysisModal() {
    const modal = document.getElementById('excavationAnalysisModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Excavation GWT configuration modal
function showGWTConfig() {
    const modal = document.getElementById('gwt-config-modal');
    if (modal) modal.style.display = 'block';
}

function closeGWTConfig() {
    const modal = document.getElementById('gwt-config-modal');
    if (modal) modal.style.display = 'none';
}

// Water Pressure Analysis Mode Modal Functions
function toggleWaterPressureModal() {
    const modal = document.getElementById('water-pressure-modal');
    if (modal) {
        if (modal.style.display === 'none' || modal.style.display === '') {
            modal.style.display = 'block';
        } else {
            modal.style.display = 'none';
        }
    }
}

function closeWaterPressureModal() {
    const modal = document.getElementById('water-pressure-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Seepage and Sand Boil Safety Factor Formulations Modal
function toggleSeepageFSModal() {
    const modal = document.getElementById('seepage-fs-modal');
    if (modal) {
        if (modal.style.display === 'none' || modal.style.display === '') {
            modal.style.display = 'block';
            const inner = modal.querySelector('div > div');
            if (inner) inner.scrollTop = 0;
        } else {
            modal.style.display = 'none';
        }
    }
}

function closeSeepageFSModal() {
    const modal = document.getElementById('seepage-fs-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Shallow Foundation: Service Loads  Modal
function toggleSfServiceLoadsInfoModal() {
    const modal = document.getElementById('sf-service-loads-info-modal');
    if (modal) {
        if (modal.style.display === 'none' || modal.style.display === '') {
            modal.style.display = 'block';
            const inner = modal.querySelector('div > div');
            if (inner) inner.scrollTop = 0;
        } else {
            modal.style.display = 'none';
        }
    }
}

function closeSfServiceLoadsInfoModal() {
    const modal = document.getElementById('sf-service-loads-info-modal');
    if (modal) modal.style.display = 'none';
}

// 
document.addEventListener('DOMContentLoaded', function() {
    const closeBtn = document.querySelector('#excavationAnalysisModal .close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            closeExcavationAnalysisModal();
            });
        }
    });
    
//  modal 
document.addEventListener('click', function(event) {
    const modal = document.getElementById('excavationAnalysisModal');
    if (modal && event.target === modal) {
        closeExcavationAnalysisModal();
    }
    
    const waterPressureModal = document.getElementById('water-pressure-modal');
    if (waterPressureModal && event.target === waterPressureModal) {
        closeWaterPressureModal();
    }
    
    const seepageFSModal = document.getElementById('seepage-fs-modal');
    if (seepageFSModal && event.target === seepageFSModal) {
        closeSeepageFSModal();
    }
    
    const sfServiceLoadsModal = document.getElementById('sf-service-loads-info-modal');
    if (sfServiceLoadsModal && event.target === sfServiceLoadsModal) {
        closeSfServiceLoadsInfoModal();
    }

    const gwtConfigModal = document.getElementById('gwt-config-modal');
    if (gwtConfigModal && event.target === gwtConfigModal) {
        closeGWTConfig();
    }
    
    const nshmModal = document.getElementById('nshm-model-modal');
    if (nshmModal && event.target === nshmModal) {
        closeNshmModelModal();
    }
});

// ：HTML
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

//  Excel 
async function downloadExcavationCalculationReport() {
    if (!window.excavationRequestData) {
        alert('');
        return;
    }
    
    if (window.isDownloading) {
        console.log('Download already in progress');
        return;
    }
    
    window.isDownloading = true;
    
    try {
        const response = await fetch('/api/excavation/export-excel', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(window.excavationRequestData)
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || 'Download failed');
        }
        
        const blob = await response.blob();
        if (blob.size < 500) {
            const text = await blob.text();
            try {
                const err = JSON.parse(text);
                throw new Error(err.message || 'Excel export failed');
            } catch (parseErr) {
                throw new Error('Excel file is empty or invalid' + (text ? ` (${text.substring(0, 100)}...)` : ''));
            }
        }
        const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Excavation_Analysis_Report.xlsx';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        
        console.log('Excel file downloaded');
    } catch (error) {
        console.error('Excel download error:', error);
        alert('Excel download failed: ' + error.message);
    } finally {
        setTimeout(() => {
            window.isDownloading = false;
        }, 2000);
    }
}

// 
function getCurrentUnitSystem() {
    const metricRadio = document.querySelector('input[name="excavation-unit-system"][value="metric"]');
    return metricRadio && metricRadio.checked ? 'metric' : 'imperial';
}

// 
function getDepthUnitLabel() {
    const unitSystem = getCurrentUnitSystem();
    return unitSystem === 'metric' ? 'Depth (m)' : 'Depth (ft)';
}

// 
function changeExcavationUnitSystem(unitSystem) {
    console.log('Changing unit system to:', unitSystem);
    
    // 
    const M_TO_FT = 3.28084;
    const KN_M3_TO_PCF = 6.36588; // 1 kN/m³ ≈ 6.36588 pcf
    
    // 
    const wallLengthInput = document.getElementById('excavation-wall-length');
    if (wallLengthInput) {
        const currentValue = parseFloat(wallLengthInput.value) || 0;
        if (unitSystem === 'imperial') {
            wallLengthInput.value = (currentValue * M_TO_FT).toFixed(2);
        } else {
            wallLengthInput.value = (currentValue / M_TO_FT).toFixed(2);
        }
    }
    
    // 
    const gwtInput = document.getElementById('excavation-gwt');
    if (gwtInput) {
        const currentValue = gwtInput.value;
        const values = currentValue.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        if (values.length > 0) {
            if (unitSystem === 'imperial') {
                gwtInput.value = values.map(v => (v * M_TO_FT).toFixed(2)).join(',');
            } else {
                gwtInput.value = values.map(v => (v / M_TO_FT).toFixed(2)).join(',');
            }
        }
    }
    
    const gwtSandBoilInput = document.getElementById('excavation-gwt-sand-boil');
    if (gwtSandBoilInput) {
        const currentValue = parseFloat(gwtSandBoilInput.value) || 0;
        if (unitSystem === 'imperial') {
            gwtSandBoilInput.value = (currentValue * M_TO_FT).toFixed(2);
        } else {
            gwtSandBoilInput.value = (currentValue / M_TO_FT).toFixed(2);
        }
    }

    const interfaceDepthInput = document.getElementById('excavation-interface-depth');
    if (interfaceDepthInput && interfaceDepthInput.value !== '') {
        const currentValue = parseFloat(interfaceDepthInput.value) || 0;
        if (unitSystem === 'imperial') {
            interfaceDepthInput.value = (currentValue * M_TO_FT).toFixed(2);
        } else {
            interfaceDepthInput.value = (currentValue / M_TO_FT).toFixed(2);
        }
    }
    
    // 
    const strataRows = document.querySelectorAll('#stratigraphic-table-body tr');
    strataRows.forEach(row => {
        const depthInput = row.querySelector('.strata-depth');
        const gammaInput = row.querySelector('.strata-gamma');
        
        if (depthInput) {
            const currentValue = parseFloat(depthInput.value) || 0;
            if (unitSystem === 'imperial') {
                depthInput.value = (currentValue * M_TO_FT).toFixed(2);
            } else {
                depthInput.value = (currentValue / M_TO_FT).toFixed(2);
            }
        }
        
        if (gammaInput) {
            const currentValue = parseFloat(gammaInput.value) || 0;
            if (unitSystem === 'imperial') {
                gammaInput.value = (currentValue * KN_M3_TO_PCF).toFixed(2);
            } else {
                gammaInput.value = (currentValue / KN_M3_TO_PCF).toFixed(2);
            }
        }
    });
    
    // 
    const stageRows = document.querySelectorAll('#excavation-stages-table-body tr');
    stageRows.forEach(row => {
        const depthInput = row.querySelector('.stage-depth');
        if (depthInput) {
            const currentValue = parseFloat(depthInput.value) || 0;
            if (unitSystem === 'imperial') {
                depthInput.value = (currentValue * M_TO_FT).toFixed(2);
            } else {
                depthInput.value = (currentValue / M_TO_FT).toFixed(2);
            }
        }
        
        const waterLevelInputs = row.querySelectorAll('.stage-water-level');
        waterLevelInputs.forEach(input => {
            const currentValue = parseFloat(input.value) || 0;
            if (unitSystem === 'imperial') {
                input.value = (currentValue * M_TO_FT).toFixed(2);
            } else {
                input.value = (currentValue / M_TO_FT).toFixed(2);
            }
        });
    });
    
    // 
    updateUnitLabels(unitSystem);
    
    // 
    updateExcavationProfilePlot();
    updateStratigraphicIllustrate();
    syncExcavationInterfaceInputs();
}

// ==========================================
// Supported Diaphragm Wall Depth Check Functions
// ==========================================

// 
function changeDiaphragmUnitSystem(unitSystem) {
    console.log('Changing diaphragm unit system to:', unitSystem);
    
    // 
    const M_TO_FT = 3.28084;
    const KN_M3_TO_PCF = 6.36588;
    const KPA_TO_KSF = 1.0 / 47.88026;
    const KN_PER_KIP = 4.44822;
    
    // 
    const unitLabels = document.querySelectorAll('.diaphragm-unit-length');
    unitLabels.forEach(label => {
        label.textContent = unitSystem === 'metric' ? '(m)' : '(ft)';
    });
    const stressLabels = document.querySelectorAll('.diaphragm-unit-stress');
    stressLabels.forEach(label => {
        label.textContent = unitSystem === 'metric' ? '(kPa)' : '(ksf)';
    });
    const momentLabels = document.querySelectorAll('.diaphragm-unit-moment');
    momentLabels.forEach(label => {
        label.textContent = unitSystem === 'metric' ? '(kN·m/m)' : '(kip·ft/ft)';
    });
    
    // 
    const inputsToConvert = ['diaphragm-ds', 'diaphragm-de', 'diaphragm-dl', 'diaphragm-dw-ret', 'diaphragm-dw-exc'];
    inputsToConvert.forEach(inputId => {
        const input = document.getElementById(inputId);
        if (input && input.value) {
            const currentValue = parseFloat(input.value);
            if (!isNaN(currentValue)) {
                input.value = unitSystem === 'imperial'
                    ? (currentValue * M_TO_FT).toFixed(2)
                    : (currentValue / M_TO_FT).toFixed(2);
            }
        }
    });

    // 
    const rows = document.querySelectorAll('#diaphragm-stratigraphic-table-body tr');
    rows.forEach((row) => {
        const convertField = (selector, factor) => {
            const input = row.querySelector(selector);
            if (!input || input.value === '') return;
            const v = parseFloat(input.value);
            if (!Number.isFinite(v)) return;
            input.value = unitSystem === 'imperial' ? (v * factor).toFixed(2) : (v / factor).toFixed(2);
        };
        convertField('.diaphragm-layer-depth', M_TO_FT);
        convertField('.diaphragm-layer-gamma', KN_M3_TO_PCF);
        convertField('.diaphragm-layer-c', KPA_TO_KSF);
        convertField('.diaphragm-layer-su', KPA_TO_KSF);
        convertField('.diaphragm-dw-exc-layer', M_TO_FT);
        convertField('.diaphragm-dw-ret-layer', M_TO_FT);
    });

    //  SURCHARGE/SUB 
    const convertStandalone = (selector, factor) => {
        document.querySelectorAll(selector).forEach((el) => {
            if (!el || el.value === '') return;
            const v = parseFloat(el.value);
            if (!Number.isFinite(v)) return;
            el.value = unitSystem === 'imperial' ? (v * factor).toFixed(2) : (v / factor).toFixed(2);
        });
    };
    convertStandalone('#diaphragm-surcharge-q, #diaphragm-surcharge-sh, .diaphragm-sub-q', KPA_TO_KSF);
    convertStandalone('.diaphragm-sub-z, .diaphragm-sub-a, .diaphragm-sub-b', M_TO_FT);
    convertStandalone('#diaphragm-ms', 1.0 / KN_PER_KIP);

    // 
    const headers = document.querySelectorAll('#diaphragm-stratigraphic-table th, #diaphragm-sub-table th');
    headers.forEach((th) => {
        th.innerHTML = th.innerHTML
            .replace(/\(m\)/g, unitSystem === 'imperial' ? '(ft)' : '(m)')
            .replace(/\(kN\/m³\)|\(pcf\)/g, unitSystem === 'imperial' ? '(pcf)' : '(kN/m³)')
            .replace(/\(kPa\)|\(ksf\)/g, unitSystem === 'imperial' ? '(ksf)' : '(kPa)')
            .replace(/GL-m|GL-ft/g, unitSystem === 'imperial' ? 'GL-ft' : 'GL-m');
    });
    
    //  DL/De 
    updateDiaphragmRatio();
    updateDiaphragmInteractiveProfile();
}

//  DL/De 
function updateDiaphragmRatio() {
    const deInput = document.getElementById('diaphragm-de');
    const dlInput = document.getElementById('diaphragm-dl');
    const ratioInput = document.getElementById('diaphragm-dl-de-ratio');
    
    if (deInput && dlInput && ratioInput) {
        const de = parseFloat(deInput.value) || 0;
        const dl = parseFloat(dlInput.value) || 0;
        
        if (de > 0) {
            ratioInput.value = (dl / de).toFixed(2);
        } else {
            ratioInput.value = '0';
        }
    }
}

// 
document.addEventListener('DOMContentLoaded', function() {
    const deInput = document.getElementById('diaphragm-de');
    const dlInput = document.getElementById('diaphragm-dl');
    
    if (deInput) {
        deInput.addEventListener('input', updateDiaphragmRatio);
    }
    if (dlInput) {
        dlInput.addEventListener('input', updateDiaphragmRatio);
    }
});

function getDiaphragmSurchargeMode() {
    const selected = document.querySelector('input[name="diaphragm-surcharge-mode"]:checked');
    return selected ? selected.value : 'manual';
}

function updateDiaphragmSurchargeInputs() {
    const mode = getDiaphragmSurchargeMode();
    const manualWrap = document.getElementById('diaphragm-surcharge-manual-wrap');
    const subWrap = document.getElementById('diaphragm-surcharge-sub-wrap');
    if (manualWrap) manualWrap.style.display = mode === 'sub' ? 'none' : 'flex';
    if (subWrap) subWrap.style.display = mode === 'sub' ? 'block' : 'none';
}

function renumberDiaphragmSubRows() {
    const rows = document.querySelectorAll('#diaphragm-sub-table-body tr');
    rows.forEach((row, idx) => {
        const noCell = row.querySelector('.diaphragm-sub-no');
        if (noCell) noCell.textContent = String(idx + 1);
    });
}

function addDiaphragmSubRow(seed = {}) {
    const tbody = document.getElementById('diaphragm-sub-table-body');
    if (!tbody) return;
    const row = document.createElement('tr');
    row.innerHTML = `
        <td class="diaphragm-sub-no" style="border: 1px solid #999; padding: 6px; text-align: center;">1</td>
        <td style="border: 1px solid #999; padding: 6px;"><input type="number" class="diaphragm-sub-z" value="${Number(seed.Z || 0)}" step="0.1" style="width: 100%;"></td>
        <td style="border: 1px solid #999; padding: 6px;"><input type="number" class="diaphragm-sub-a" value="${Number(seed.A || 0)}" step="0.1" style="width: 100%;"></td>
        <td style="border: 1px solid #999; padding: 6px;"><input type="number" class="diaphragm-sub-b" value="${Number(seed.B || 0)}" step="0.1" style="width: 100%;"></td>
        <td style="border: 1px solid #999; padding: 6px;"><input type="number" class="diaphragm-sub-q" value="${Number(seed.Q || 0)}" step="0.1" style="width: 100%;"></td>
        <td style="border: 1px solid #999; padding: 6px; text-align: center;"><button type="button" class="info-btn" onclick="removeDiaphragmSubRow(this)" style="padding: 4px 8px;">x</button></td>
    `;
    tbody.appendChild(row);
    renumberDiaphragmSubRows();
}

function removeDiaphragmSubRow(btn) {
    const tr = btn && btn.closest ? btn.closest('tr') : null;
    if (tr) tr.remove();
    renumberDiaphragmSubRows();
}

function _supportedTagNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function _supportedTagFmt(value, digits = 2) {
    const n = _supportedTagNum(value);
    return n === null ? '-' : n.toFixed(digits);
}

function _supportedTagTable(title, columns, rows, emptyText = 'No data', sumRow = null) {
    if (!Array.isArray(rows) || !rows.length) {
        return `<div style="padding: 12px; border: 1px solid #d0d7de; border-radius: 6px; color: #64748b;">${emptyText}</div>`;
    }
    let html = `
        <div style="margin-top: 10px; overflow-x: auto; border: 1px solid #999;">
            <div style="padding: 8px 10px; background: #4F81BD; color: #fff; font-weight: 700; font-size: 13px;">${escapeHtml(title)}</div>
            <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
                <thead>
                    <tr style="background: #D7E4BC;">
    `;
    columns.forEach((c) => {
        html += `<th style="border: 1px solid #999; padding: 6px; text-align: center;">${escapeHtml(c.label)}</th>`;
    });
    html += '</tr><tr style="background: #D7E4BC;">';
    columns.forEach((c) => {
        html += `<th style="border: 1px solid #999; padding: 5px; text-align: center; font-weight: 500;">${escapeHtml(c.unit || '')}</th>`;
    });
    html += '</tr></thead><tbody>';
    rows.forEach((row) => {
        html += '<tr>';
        columns.forEach((c) => {
            const raw = row[c.key];
            const n = _supportedTagNum(raw);
            const isNumeric = n !== null && raw !== '-' && raw !== '';
            const digits = c.digits != null ? c.digits : 2;
            const display = isNumeric ? n.toFixed(digits) : (raw == null || raw === '' ? '-' : escapeHtml(String(raw)));
            html += `<td style="border: 1px solid #999; padding: 6px; text-align: ${isNumeric ? 'right' : 'center'};">${display}</td>`;
        });
        html += '</tr>';
    });
    if (sumRow && Array.isArray(sumRow.values)) {
        html += '<tr style="background: #f8fafc; font-weight: 700;">';
        columns.forEach((c, idx) => {
            const raw = sumRow.values[idx];
            const n = _supportedTagNum(raw);
            const isNumeric = n !== null && raw !== '-' && raw !== '';
            const digits = c.digits != null ? c.digits : 2;
            const display = isNumeric ? n.toFixed(digits) : (raw == null || raw === '' ? '-' : escapeHtml(String(raw)));
            html += `<td style="border: 1px solid #999; padding: 6px; text-align: ${isNumeric ? 'right' : 'center'};">${display}</td>`;
        });
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
}

function _supportedTagPanel(title, bodyHtml, isOpen = false) {
    return `
        <details ${isOpen ? 'open' : ''} style="margin-top: 12px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;">
            <summary style="cursor: pointer; padding: 10px 12px; font-weight: 700; color: #1e293b; background: #f8fafc;">${escapeHtml(title)}</summary>
            <div style="padding: 10px 12px;">${bodyHtml}</div>
        </details>
    `;
}

// 
async function runDiaphragmWallAnalysis() {
    try {
        const M_TO_FT = 3.28084;
        const KPA_TO_TF_M2 = 1.0 / 9.80665;
        const KN_TO_TF = 1.0 / 9.80665;
        const KSF_TO_TF_M2 = 4.88243;
        const KN_M3_TO_TF_M3 = 1.0 / 9.80665;
        const PCF_TO_TF_M3 = 0.016018;
        const KIP_TO_TF = 1.0 / 2.20462262;
        const unitSystem = (document.querySelector('input[name="diaphragm-unit-system"]:checked') || {}).value || 'metric';

        const toM = (v) => unitSystem === 'imperial' ? v / M_TO_FT : v;
        const stressToTfM2 = (v) => unitSystem === 'imperial' ? v * KSF_TO_TF_M2 : v * KPA_TO_TF_M2;
        const gammaToTfM3 = (v) => unitSystem === 'imperial' ? v * PCF_TO_TF_M3 : v * KN_M3_TO_TF_M3;
        const momentToTfM = (v) => unitSystem === 'imperial' ? v * KIP_TO_TF : v * KN_TO_TF;

        const validationErrors = [];

        const designCode = document.getElementById('diaphragm-design-code')?.value || 'TWN-112 (2023)';
        const excavationType = document.getElementById('diaphragm-excavation-type')?.value || 'Supported';
        const clayMethod = document.getElementById('diaphragm-clay-method')?.value || 'total_stress';
        const kaMethod = document.getElementById('diaphragm-ka-method')?.value || 'Rankine';
        const kpMethod = document.getElementById('diaphragm-kp-method')?.value || 'Caquot-Kerisel';
        const deltaAPhi = document.getElementById('diaphragm-delta-a-phi')?.value || '1/3';
        const deltaPPhi = document.getElementById('diaphragm-delta-p-phi')?.value || '1/2';
        const cwC = document.getElementById('diaphragm-cw-c')?.value || '2/3';
        const cwSu = document.getElementById('diaphragm-cw-su')?.value || '2/3';

        const dsRaw = parseFloat(document.getElementById('diaphragm-ds')?.value || 0);
        const deRaw = parseFloat(document.getElementById('diaphragm-de')?.value || 0);
        const dlRaw = parseFloat(document.getElementById('diaphragm-dl')?.value || 0);
        const msRaw = parseFloat(document.getElementById('diaphragm-ms')?.value || 0);
        const fssR = parseFloat(document.getElementById('diaphragm-fss-r')?.value || 0);
        const fshR = parseFloat(document.getElementById('diaphragm-fsh-r')?.value || 0);
        const dwRetRaw = parseFloat(document.getElementById('diaphragm-dw-ret')?.value || 0);
        const dwExcRaw = parseFloat(document.getElementById('diaphragm-dw-exc')?.value || 0);

        if (!dsRaw || dsRaw <= 0) validationErrors.push('Please enter Deepest Support Depth (Ds)');
        if (!deRaw || deRaw <= 0) validationErrors.push('Please enter Excavation Depth (De)');
        if (!dlRaw || dlRaw <= 0) validationErrors.push('Please enter Wall Length (DL)');
        if (dlRaw <= deRaw) validationErrors.push('Wall Length (DL) must be greater than Excavation Depth (De)');
        if (dsRaw >= deRaw) validationErrors.push('Deepest Support Depth (Ds) must be less than Excavation Depth (De)');
        if (!fssR || fssR <= 0) validationErrors.push('Please enter FSs requirement');
        if (!fshR || fshR <= 0) validationErrors.push('Please enter FSh requirement');
        if (!Number.isFinite(dwRetRaw)) validationErrors.push('Please enter retained side groundwater level');
        if (!Number.isFinite(dwExcRaw)) validationErrors.push('Please enter excavation side groundwater level');

        const surchargeMode = getDiaphragmSurchargeMode();
        const surchargeQRaw = parseFloat(document.getElementById('diaphragm-surcharge-q')?.value || 0);
        const surchargeShRaw = parseFloat(document.getElementById('diaphragm-surcharge-sh')?.value || 0);
        const subRecordsRaw = [];
        document.querySelectorAll('#diaphragm-sub-table-body tr').forEach((row) => {
            const z = parseFloat(row.querySelector('.diaphragm-sub-z')?.value || 0);
            const a = parseFloat(row.querySelector('.diaphragm-sub-a')?.value || 0);
            const b = parseFloat(row.querySelector('.diaphragm-sub-b')?.value || 0);
            const q = parseFloat(row.querySelector('.diaphragm-sub-q')?.value || 0);
            if (Number.isFinite(z) && Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(q)) {
                subRecordsRaw.push({ Z: z, A: a, B: b, Q: q });
            }
        });
        if (surchargeMode === 'sub' && subRecordsRaw.length === 0) {
            validationErrors.push('SUB mode requires at least one surcharge record');
        }

        const layerRows = document.querySelectorAll('#diaphragm-stratigraphic-table-body tr');
        if (!layerRows.length) validationErrors.push('Please add at least one soil layer');

        const layers = [];
        let prevDepthRaw = 0;
        layerRows.forEach((row) => {
            const type = row.querySelector('.diaphragm-layer-type')?.value || 'D';
            const code = row.querySelector('.diaphragm-layer-code')?.value || '';
            const depthRaw = parseFloat(row.querySelector('.diaphragm-layer-depth')?.value || 0);
            const gammaRaw = parseFloat(row.querySelector('.diaphragm-layer-gamma')?.value || 0);
            const cRaw = parseFloat(row.querySelector('.diaphragm-layer-c')?.value || 0);
            const phi = parseFloat(row.querySelector('.diaphragm-layer-phi')?.value || 0);
            const suRaw = parseFloat(row.querySelector('.diaphragm-layer-su')?.value || 0);
            const sptRaw = row.querySelector('.diaphragm-layer-spt')?.value || '';
            const seepage = row.querySelector('.diaphragm-seepage-mode')?.value || '-';
            const dwExcLayerRaw = row.querySelector('.diaphragm-dw-exc-layer')?.value || '';
            const dwRetLayerRaw = row.querySelector('.diaphragm-dw-ret-layer')?.value || '';

            if (!(depthRaw > prevDepthRaw)) return;
            const thicknessRaw = depthRaw - prevDepthRaw;
            prevDepthRaw = depthRaw;
            if (!(gammaRaw > 0) || !(thicknessRaw > 0)) return;

            let suValue = Number.isFinite(suRaw) ? suRaw : 0;
            if (type === 'U' && suValue > 3.0) suValue = stressToTfM2(suValue);
            if (type === 'D') suValue = 0;

            layers.push({
                thickness: toM(thicknessRaw),
                type: type,
                code: code || `L${layers.length + 1}`,
                gamma: gammaToTfM3(gammaRaw),
                c: stressToTfM2(cRaw || 0),
                phi: phi || 0,
                su: suValue || 0,
                spt: sptRaw === '' ? null : Number(sptRaw),
                seepage: seepage || '-',
                dw_exc_layer: dwExcLayerRaw === '' ? null : toM(parseFloat(dwExcLayerRaw)),
                dw_ret_layer: dwRetLayerRaw === '' ? null : toM(parseFloat(dwRetLayerRaw)),
            });
        });
        if (!layers.length) validationErrors.push('Please provide at least one valid soil layer with depth and unit weight');

        if (validationErrors.length > 0) {
            alert('Please complete the following required fields:\n\n' + validationErrors.join('\n'));
            return;
        }

        const ds = toM(dsRaw);
        const de = toM(deRaw);
        const dl = toM(dlRaw);
        const ms = momentToTfM(msRaw);
        const dwRet = toM(dwRetRaw);
        const dwExc = toM(dwExcRaw);

        const requestData = {
            design_code: designCode,
            excavation_type: excavationType,
            clay_method: clayMethod,
            ka_method: kaMethod,
            kp_method: kpMethod,
            delta_a_phi: deltaAPhi,
            delta_p_phi: deltaPPhi,
            cw_c_ratio: cwC,
            cw_su_ratio: cwSu,
            ds: ds,
            de: de,
            dl: dl,
            ms: ms,
            fssR: fssR,
            fshR: fshR,
            dw_ret: dwRet,
            dw_exc: dwExc,
            surcharge_mode: surchargeMode,
            surcharge_q: stressToTfM2(surchargeQRaw || 0),
            surcharge_sh: stressToTfM2(surchargeShRaw || 0),
            sub_records: subRecordsRaw.map((r) => ({
                Z: toM(r.Z),
                A: toM(r.A),
                B: toM(r.B),
                Q: stressToTfM2(r.Q),
            })),
            layers: layers,
            excavation_depth: -de,
            wall_depth: -dl,
            water_level_active: dwRet,
            water_level_passive: dwExc,
            unit_system: unitSystem,
        };

        const response = await fetch('/api/supported-tag/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData),
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') {
            throw new Error(result.message || 'Analysis failed');
        }

        const modalInput = {
            ds: dsRaw,
            de: deRaw,
            dl: dlRaw,
            ms: msRaw,
            fssR: fssR,
            fshR: fshR,
            designCode: designCode,
            unitSystem: unitSystem,
        };
        showSupportedTagAnalysisModal(result, modalInput);

        window.supportedTagRequestData = requestData;
        window.supportedTagInputData = {
            ds: ds,
            de: de,
            dl: dl,
            ms: ms,
            fssR: fssR,
            fshR: fshR,
        };
        window.supportedTagResult = result;
    } catch (error) {
        console.error('Analysis error:', error);
        alert('Analysis failed: ' + error.message);
    }
}

//  Supported Tag  Modal
function showSupportedTagAnalysisModal(result, inputData) {
    const modal = document.getElementById('supportedTagAnalysisModal');
    const content = document.getElementById('supported-tag-modal-content');
    if (!modal || !content) return;

    const metadata = result.metadata || {};
    const lateral = result.lateral_analysis || {};
    const heave = result.heave_analysis || {};
    const tables = result.tables || {};

    const fsS = _supportedTagNum(lateral.factor_of_safety) || 0;
    const fsH = _supportedTagNum(heave.factor_of_safety) || 0;
    const reqS = _supportedTagNum(inputData.fssR) || _supportedTagNum(lateral.required_fs) || 1.2;
    const reqH = _supportedTagNum(inputData.fshR) || _supportedTagNum(heave.required_fs) || 1.2;
    const fsSOk = fsS >= reqS;
    const fsHOk = fsH >= reqH;

    const lengthUnit = inputData.unitSystem === 'imperial' ? 'ft' : 'm';
    const momentUnitInput = inputData.unitSystem === 'imperial' ? 'kip·ft/ft' : 'kN·m/m';
    const baseUnits = metadata.units || {};
    const stressUnit = baseUnits.stress || 'tf/m²';
    const forceUnit = 'tf/m';
    const momentUnit = baseUnits.moment || 'tf-m/m';

    const surchargePanel = _supportedTagTable(
        'Surcharge-induced Lateral Pressure',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'Dqh1', label: 'Dqh1', unit: 'm' },
            { key: 'Dqh2', label: 'Dqh2', unit: 'm' },
            { key: 'sigma_q1', label: 'sigma_q1', unit: stressUnit },
            { key: 'sigma_q2', label: 'sigma_q2', unit: stressUnit },
            { key: 'Pqh', label: 'Pqh', unit: forceUnit },
            { key: 'Lqh', label: 'Lqh', unit: 'm' },
            { key: 'Mqh', label: 'Mqh', unit: momentUnit },
        ],
        tables.surcharge_lateral_rows || [],
        'No data',
        { values: ['Σ', '', '', '', '', '', 'ΣMqh', _supportedTagNum(tables.sum_Mqh) || 0] }
    );

    const waterPanel = _supportedTagTable(
        'Water Pressure',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'D1', label: 'D1', unit: 'm' },
            { key: 'D2', label: 'D2', unit: 'm' },
            { key: 'sigma_wa1', label: 'sigma_wa1', unit: stressUnit },
            { key: 'sigma_wa2', label: 'sigma_wa2', unit: stressUnit },
            { key: 'sigma_wp1', label: 'sigma_wp1', unit: stressUnit },
            { key: 'sigma_wp2', label: 'sigma_wp2', unit: stressUnit },
            { key: 'Pwa', label: 'Pwa', unit: forceUnit },
            { key: 'Lwa', label: 'Lwa', unit: 'm' },
            { key: 'Mwa', label: 'Mwa', unit: momentUnit },
            { key: 'Pwp', label: 'Pwp', unit: forceUnit },
            { key: 'Lwp', label: 'Lwp', unit: 'm' },
            { key: 'Mwp', label: 'Mwp', unit: momentUnit },
        ],
        tables.water_rows || [],
        'No data',
        { values: ['Σ', '', '', '', '', '', '', '', '', '', '', 'ΣMwa', _supportedTagNum(tables.sum_Mwa) || 0, '', 'ΣMwp', _supportedTagNum(tables.sum_Mwp) || 0] }
    );

    const activePanel = _supportedTagTable(
        'Active Earth Pressure (Retained Side)',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'D1', label: 'D1', unit: 'm' },
            { key: 'D2', label: 'D2', unit: 'm' },
            { key: 'Drainage', label: 'Drainage', unit: '' },
            { key: 'gamma_t', label: 'gamma_t', unit: 'tf/m³' },
            { key: 'Kahm', label: 'Kahm', unit: '-', digits: 4 },
            { key: 'Kachm', label: 'Kachm', unit: '-', digits: 4 },
            { key: 'sigma_v1_eff', label: "sigma'v1", unit: stressUnit },
            { key: 'sigma_v2_eff', label: "sigma'v2", unit: stressUnit },
            { key: 'sigma_a1', label: 'sigma_a1', unit: stressUnit },
            { key: 'sigma_a2', label: 'sigma_a2', unit: stressUnit },
            { key: 'Pa', label: 'Pa', unit: forceUnit },
            { key: 'La', label: 'La', unit: 'm' },
            { key: 'Ma', label: 'Ma', unit: momentUnit },
        ],
        tables.active_rows || [],
        'No data',
        { values: ['Σ', '', '', '', '', '', '', '', '', '', '', '', '', 'ΣMa', _supportedTagNum(tables.sum_Ma) || 0] }
    );

    const passivePanel = _supportedTagTable(
        'Passive Earth Pressure (Excavation Side)',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'D1', label: 'D1', unit: 'm' },
            { key: 'D2', label: 'D2', unit: 'm' },
            { key: 'Drainage', label: 'Drainage', unit: '' },
            { key: 'gamma_t', label: 'gamma_t', unit: 'tf/m³' },
            { key: 'Kphm', label: 'Kphm', unit: '-', digits: 4 },
            { key: 'Kpchm', label: 'Kpchm', unit: '-', digits: 4 },
            { key: 'sigma_v1_eff', label: "sigma'v1", unit: stressUnit },
            { key: 'sigma_v2_eff', label: "sigma'v2", unit: stressUnit },
            { key: 'sigma_p1', label: 'sigma_p1', unit: stressUnit },
            { key: 'sigma_p2', label: 'sigma_p2', unit: stressUnit },
            { key: 'Pp', label: 'Pp', unit: forceUnit },
            { key: 'Lp', label: 'Lp', unit: 'm' },
            { key: 'Mp', label: 'Mp', unit: momentUnit },
        ],
        tables.passive_rows || [],
        'No data',
        { values: ['Σ', '', '', '', '', '', '', '', '', '', '', '', '', 'ΣMp', _supportedTagNum(tables.sum_Mp) || 0] }
    );

    const drivingWeightPanel = _supportedTagTable(
        'Basal Heave - Driving Soil Weight',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'D1', label: 'D1', unit: 'm' },
            { key: 'D2', label: 'D2', unit: 'm' },
            { key: 'gamma_t', label: 'gamma_t', unit: 'tf/m³' },
            { key: 'W', label: 'W', unit: forceUnit },
            { key: 'Lc', label: 'Lc', unit: 'm' },
            { key: 'Mc', label: 'Mc', unit: momentUnit },
        ],
        tables.weight_rows || [],
        'No data',
        { values: ['Σ', '', '', '', 'ΣW', _supportedTagNum(tables.sum_w) || 0, 'ΣMc', _supportedTagNum(tables.sum_mc) || 0] }
    );

    const surchargeDrivingPanel = _supportedTagTable(
        'Basal Heave - Surcharge Driving Moment',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'x1', label: 'x1', unit: 'm' },
            { key: 'x2', label: 'x2', unit: 'm' },
            { key: 'qv', label: 'qv', unit: stressUnit },
            { key: 'Pqv', label: 'Pqv', unit: forceUnit },
            { key: 'Lqv', label: 'Lqv', unit: 'm' },
            { key: 'Mqv', label: 'Mqv', unit: momentUnit },
        ],
        tables.surcharge_driving_rows || [],
        'No data',
        { values: ['Σ', '', '', '', '', 'ΣMqv', _supportedTagNum(tables.sum_mqv) || 0] }
    );

    const shearActiveUpper = _supportedTagTable(
        'Potential Failure Plane Shear Resistance - Active Side (Upper)',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'D1', label: 'D1', unit: 'm' },
            { key: 'D2', label: 'D2', unit: 'm' },
            { key: 'Drainage', label: 'Drainage', unit: '' },
            { key: 'gamma_t', label: 'gamma_t', unit: 'tf/m³' },
            { key: 'Su1', label: 'Su1', unit: stressUnit },
            { key: 'Su2', label: 'Su2', unit: stressUnit },
            { key: 'theta1', label: 'theta1', unit: 'deg' },
            { key: 'theta2', label: 'theta2', unit: 'deg' },
            { key: 'sigma_v1', label: 'sigma_v1', unit: stressUnit },
            { key: 'sigma_v2', label: 'sigma_v2', unit: stressUnit },
            { key: 'sigma_v1_eff', label: "sigma'v1", unit: stressUnit },
            { key: 'sigma_v2_eff', label: "sigma'v2", unit: stressUnit },
        ],
        tables.shear_active_upper || []
    );
    const shearActiveLower = _supportedTagTable(
        'Potential Failure Plane Shear Resistance - Active Side (Lower)',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'C1', label: 'C1', unit: '-' },
            { key: 'C2', label: 'C2', unit: '-' },
            { key: 'C3', label: 'C3', unit: '-' },
            { key: 'C4', label: 'C4', unit: '-' },
            { key: 'I1', label: 'I1', unit: 'm' },
            { key: 'I2', label: 'I2', unit: 'm' },
            { key: 'I3', label: 'I3', unit: 'm' },
            { key: 'I4', label: 'I4', unit: 'm' },
            { key: 'tau1', label: 'tau1', unit: stressUnit },
            { key: 'tau2', label: 'tau2', unit: stressUnit },
            { key: 'V', label: 'V', unit: forceUnit },
        ],
        tables.shear_active_lower || [],
        'No data',
        { values: ['Σ', '', '', '', '', '', '', '', '', '', '', 'Va', _supportedTagNum(tables.va) || 0] }
    );

    const shearPassiveUpper = _supportedTagTable(
        'Potential Failure Plane Shear Resistance - Passive Side (Upper)',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'D1', label: 'D1', unit: 'm' },
            { key: 'D2', label: 'D2', unit: 'm' },
            { key: 'Drainage', label: 'Drainage', unit: '' },
            { key: 'gamma_t', label: 'gamma_t', unit: 'tf/m³' },
            { key: 'Su1', label: 'Su1', unit: stressUnit },
            { key: 'Su2', label: 'Su2', unit: stressUnit },
            { key: 'theta1', label: 'theta1', unit: 'deg' },
            { key: 'theta2', label: 'theta2', unit: 'deg' },
            { key: 'sigma_v1', label: 'sigma_v1', unit: stressUnit },
            { key: 'sigma_v2', label: 'sigma_v2', unit: stressUnit },
            { key: 'sigma_v1_eff', label: "sigma'v1", unit: stressUnit },
            { key: 'sigma_v2_eff', label: "sigma'v2", unit: stressUnit },
        ],
        tables.shear_passive_upper || []
    );
    const shearPassiveLower = _supportedTagTable(
        'Potential Failure Plane Shear Resistance - Passive Side (Lower)',
        [
            { key: 'No', label: 'No', unit: '', digits: 0 },
            { key: 'LayerID', label: 'Layer', unit: '' },
            { key: 'C1', label: 'C1', unit: '-' },
            { key: 'C2', label: 'C2', unit: '-' },
            { key: 'C3', label: 'C3', unit: '-' },
            { key: 'C4', label: 'C4', unit: '-' },
            { key: 'I1', label: 'I1', unit: 'm' },
            { key: 'I2', label: 'I2', unit: 'm' },
            { key: 'I3', label: 'I3', unit: 'm' },
            { key: 'I4', label: 'I4', unit: 'm' },
            { key: 'tau1', label: 'tau1', unit: stressUnit },
            { key: 'tau2', label: 'tau2', unit: stressUnit },
            { key: 'V', label: 'V', unit: forceUnit },
        ],
        tables.shear_passive_lower || [],
        'No data',
        { values: ['Σ', '', '', '', '', '', '', '', '', '', '', 'Vp', _supportedTagNum(tables.vp) || 0] }
    );

    const drivingMoment = _supportedTagNum(lateral.driving_moment) || 0;
    const resistingMoment = _supportedTagNum(lateral.resisting_moment) || 0;
    const va = _supportedTagNum(heave.va) || 0;
    const vp = _supportedTagNum(heave.vp) || 0;
    const sumMc = _supportedTagNum(heave.sum_mc) || 0;
    const sumMqv = _supportedTagNum(heave.sum_mqv) || 0;
    const dlMinusDs = (_supportedTagNum(metadata.dl) || 0) - (_supportedTagNum(metadata.ds) || 0);

    content.innerHTML = `
        <div style="margin-bottom: 16px; padding: 14px 16px; border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc;">
            <div style="font-size: 16px; font-weight: 700; color: #1e293b; margin-bottom: 8px;">Braced Excavation Retaining Wall Analysis (Clay Wall)</div>
            <div style="font-size: 13px; color: #475569; line-height: 1.7;">
                <div>Design Code: ${escapeHtml(inputData.designCode || metadata.design_code || 'TWN-112 (2023)')}</div>
                <div>D<sub>s</sub> = ${_supportedTagFmt(inputData.ds)} ${lengthUnit}, D<sub>e</sub> = ${_supportedTagFmt(inputData.de)} ${lengthUnit}, D<sub>L</sub> = ${_supportedTagFmt(inputData.dl)} ${lengthUnit}</div>
                <div>M<sub>s</sub> = ${_supportedTagFmt(inputData.ms)} ${momentUnitInput}</div>
            </div>
        </div>

        <div style="margin-bottom: 16px; padding: 14px 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #ffffff;">
            <div style="font-size: 15px; font-weight: 700; color: #1e293b; margin-bottom: 8px;">Results Summary</div>
            <div style="font-size: 13px; line-height: 1.8;">
                <div>Lateral force balance: FS<sub>s</sub> = ${_supportedTagFmt(fsS)} ${fsSOk ? '>=' : '<'} FS<sub>s,r</sub> = ${_supportedTagFmt(reqS)} <span style="font-weight: 700; color: ${fsSOk ? '#16a34a' : '#dc2626'};">${fsSOk ? 'OK' : 'NG'}</span></div>
                <div>Basal heave: FS<sub>h</sub> = ${_supportedTagFmt(fsH)} ${fsHOk ? '>=' : '<'} FS<sub>h,r</sub> = ${_supportedTagFmt(reqH)} <span style="font-weight: 700; color: ${fsHOk ? '#16a34a' : '#dc2626'};">${fsHOk ? 'OK' : 'NG'}</span></div>
                <div style="margin-top: 8px;">Moment equilibrium: (SigmaM<sub>p</sub> + SigmaM<sub>wp</sub> + M<sub>s</sub>) = ${_supportedTagFmt(resistingMoment)} ${momentUnit}, (SigmaM<sub>a</sub> + SigmaM<sub>wa</sub> + SigmaM<sub>qh</sub>) = ${_supportedTagFmt(drivingMoment)} ${momentUnit}</div>
                <div>Basal heave line: FS<sub>h</sub> = ((V<sub>a</sub> + V<sub>p</sub>) * (D<sub>L</sub> - D<sub>s</sub>)) / (SigmaM<sub>c</sub> + SigmaM<sub>qv</sub>) = ((${_supportedTagFmt(va)} + ${_supportedTagFmt(vp)}) * ${_supportedTagFmt(dlMinusDs)}) / (${_supportedTagFmt(sumMc)} + ${_supportedTagFmt(sumMqv)})</div>
            </div>
        </div>

        ${_supportedTagPanel('1. Surcharge-induced Lateral Pressure Table', surchargePanel, true)}
        ${_supportedTagPanel('2. Water Pressure Table', waterPanel)}
        ${_supportedTagPanel('3. Active Earth Pressure Table (Retained Side)', activePanel)}
        ${_supportedTagPanel('4. Passive Earth Pressure Table (Excavation Side)', passivePanel)}
        ${_supportedTagPanel('5. Basal Heave - Shear Resistance (Active Side, Va)', shearActiveUpper + shearActiveLower)}
        ${_supportedTagPanel('6. Basal Heave - Shear Resistance (Passive Side, Vp)', shearPassiveUpper + shearPassiveLower)}
        ${_supportedTagPanel('7. Basal Heave - Driving Soil Weight (ΣW, ΣMc)', drivingWeightPanel)}
        ${_supportedTagPanel('8. Basal Heave - Surcharge Driving Moment (ΣMqv)', surchargeDrivingPanel)}
        ${_supportedTagPanel('9. Final Basal Heave Check', `
            <div style="font-size: 13px; line-height: 1.8;">
                <div>FS<sub>h</sub> = ((V<sub>a</sub> + V<sub>p</sub>) * (D<sub>L</sub> - D<sub>s</sub>)) / (SigmaM<sub>c</sub> + SigmaM<sub>qv</sub>)</div>
                <div>= ((${_supportedTagFmt(va)} + ${_supportedTagFmt(vp)}) * ${_supportedTagFmt(dlMinusDs)}) / (${_supportedTagFmt(sumMc)} + ${_supportedTagFmt(sumMqv)})</div>
                <div style="margin-top: 6px;">Computed FS<sub>h</sub> = <strong>${_supportedTagFmt(fsH)}</strong>, Required FS<sub>h,r</sub> = <strong>${_supportedTagFmt(reqH)}</strong>, <span style="color:${fsHOk ? '#16a34a' : '#dc2626'}; font-weight:700;">${fsHOk ? 'OK' : 'NG'}</span></div>
            </div>
        `)}
    `;

    modal.style.display = 'flex';
}

//  Supported Tag  Modal
function closeSupportedTagAnalysisModal() {
    const modal = document.getElementById('supportedTagAnalysisModal');
    if (modal) modal.style.display = 'none';
}

//  Supported Tag 
async function downloadSupportedTagReport() {
    if (!window.supportedTagRequestData || !window.supportedTagResult) {
        alert('Please run analysis first');
        return;
    }
    try {
        const downloadData = {
            ...window.supportedTagRequestData,
            input_data: {
                ...(window.supportedTagInputData || {}),
            },
        };
        const response = await fetch('/api/supported-tag/export-excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(downloadData),
        });
        const contentType = response.headers.get('content-type');
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `Server error (${response.status})`);
        }
        if (!contentType || !contentType.includes('spreadsheet')) {
            const text = await response.text();
            throw new Error('Server returned unexpected content type: ' + text.substring(0, 120));
        }
        const blob = await response.blob();
        if (blob.size < 500) throw new Error('Excel file is empty or invalid');

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Supported_Tag_Analysis_Report.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (error) {
        console.error('Excel download error:', error);
        alert('Excel download failed: ' + error.message);
    }
}

// 
function updateUnitLabels(unitSystem) {
    const isMetric = unitSystem === 'metric';
    const depthUnit = isMetric ? '(m)' : '(ft)';
    const gammaUnit = isMetric ? '(kN/m³)' : '(pcf)';
    
    // 
    const wallLengthLabel = document.querySelector('label[for="excavation-wall-length"]')?.parentElement?.querySelector('span');
    if (wallLengthLabel && (wallLengthLabel.textContent.includes('(m)') || wallLengthLabel.textContent.includes('(ft)'))) {
        wallLengthLabel.textContent = depthUnit;
    }
    
    // 
    const depthHeaders = document.querySelectorAll('#stratigraphic-table th');
    depthHeaders.forEach(th => {
        if (th.textContent.includes('Depth (m)') || th.textContent.includes('Depth (ft)')) {
            th.textContent = `Depth ${depthUnit}`;
        }
        if (th.textContent.includes('γt (tf/m³)') || th.textContent.includes('γt (kN/m³)') || th.textContent.includes('γt (pcf)')) {
            th.textContent = `γt ${gammaUnit}`;
        }
    });
    
    // 
    const stageHeaders = document.querySelectorAll('#excavation-stages-table-head th');
    stageHeaders.forEach(th => {
        if (th.textContent.includes('(m)') || th.textContent.includes('(ft)')) {
            th.textContent = th.textContent.replace(/\(m\)|\(ft\)/g, depthUnit);
        }
    });
    
    // 
    document.querySelectorAll('span').forEach(span => {
        if (span.textContent === '(m)' || span.textContent === '(ft)') {
            span.textContent = depthUnit;
        }
    });
}

//  Deep Excavation 
function switchExcavationTab(tabName) {
    // 
    const tabContents = document.querySelectorAll('.excavation-tab-content');
    tabContents.forEach(content => {
        content.style.display = 'none';
    });
    
    //  active 
    const tabButtons = document.querySelectorAll('.excavation-tab-btn');
    tabButtons.forEach(btn => {
        btn.style.backgroundColor = 'transparent';
        btn.style.color = '#666';
        btn.style.borderBottom = '3px solid transparent';
    });
    
    // 
    let tabIndex = -1;
    if (tabName === 'uplift-sand-boil') {
        tabIndex = 0;
        const tabContent = document.getElementById('uplift-sand-boil-tab');
        if (tabContent) {
            tabContent.style.display = 'block';
            if (typeof diggsMapExcavation !== 'undefined' && diggsMapExcavation) {
                setTimeout(function() { diggsMapExcavation.invalidateSize(); }, 50);
                setTimeout(function() { diggsMapExcavation.invalidateSize(); }, 300);
            }
        }
    } else if (tabName === 'supported-diaphragm-wall') {
        tabIndex = 1;
        const tabContent = document.getElementById('supported-diaphragm-wall-tab');
        if (tabContent) {
            tabContent.style.display = 'block';
            if (typeof diggsMapDiaphragm !== 'undefined' && diggsMapDiaphragm) {
                setTimeout(function() { diggsMapDiaphragm.invalidateSize(); }, 50);
                setTimeout(function() { diggsMapDiaphragm.invalidateSize(); }, 300);
            }
        }
    } else if (tabName === 'cantilever-excavation') {
        tabIndex = 2;
        const tabContent = document.getElementById('cantilever-excavation-tab');
        if (tabContent) {
            tabContent.style.display = 'block';
        }
    }
    
    // 
    if (tabIndex >= 0 && tabButtons[tabIndex]) {
        const btn = tabButtons[tabIndex];
        btn.style.color = '#FF6B9D';
        btn.style.borderBottom = '3px solid #FF6B9D';
    }
}

// Cantilever Excavation 
function changeCantileverUnitSystem(unitSystem) {
    console.log('Changing cantilever unit system to:', unitSystem);
    const M_TO_FT = 3.28084;
    const KN_M3_TO_PCF = 6.36588;
    const KPA_TO_KSF = 1.0 / 47.88026;
    
    // 
    const unitLabels = document.querySelectorAll('.cantilever-unit-length');
    unitLabels.forEach(label => {
        label.textContent = unitSystem === 'metric' ? '(m)' : '(ft)';
    });

    const lengthInputIds = ['cantilever-de', 'cantilever-dl', 'cantilever-dw-ret', 'cantilever-dw-exc'];
    lengthInputIds.forEach((inputId) => {
        const input = document.getElementById(inputId);
        if (!input || input.value === '') return;
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        input.value = unitSystem === 'imperial' ? (v * M_TO_FT).toFixed(2) : (v / M_TO_FT).toFixed(2);
    });

    const rows = document.querySelectorAll('#cantilever-stratigraphic-table-body tr');
    rows.forEach((row) => {
        const convertField = (selector, factor) => {
            const input = row.querySelector(selector);
            if (!input || input.value === '') return;
            const v = parseFloat(input.value);
            if (!Number.isFinite(v)) return;
            input.value = unitSystem === 'imperial' ? (v * factor).toFixed(2) : (v / factor).toFixed(2);
        };
        convertField('.cantilever-layer-depth', M_TO_FT);
        convertField('.cantilever-layer-gamma', KN_M3_TO_PCF);
        convertField('.cantilever-layer-c', KPA_TO_KSF);
        convertField('.cantilever-layer-su', KPA_TO_KSF);
    });

    const waterRows = document.querySelectorAll('#cantilever-layered-water-table-body tr');
    waterRows.forEach((row) => {
        ['.cantilever-dw-exc-layer', '.cantilever-dw-ret-layer'].forEach((selector) => {
            const input = row.querySelector(selector);
            if (!input || input.value === '') return;
            const v = parseFloat(input.value);
            if (!Number.isFinite(v)) return;
            input.value = unitSystem === 'imperial' ? (v * M_TO_FT).toFixed(2) : (v / M_TO_FT).toFixed(2);
        });
    });

    const headers = document.querySelectorAll('#cantilever-stratigraphic-table th, #cantilever-layered-water-table th');
    headers.forEach((th) => {
        th.innerHTML = th.innerHTML
            .replace(/\(m\)/g, unitSystem === 'imperial' ? '(ft)' : '(m)')
            .replace(/\(kN\/m³\)|\(pcf\)/g, unitSystem === 'imperial' ? '(pcf)' : '(kN/m³)')
            .replace(/\(kPa\)|\(ksf\)/g, unitSystem === 'imperial' ? '(ksf)' : '(kPa)')
            .replace(/GL-m|GL-ft/g, unitSystem === 'imperial' ? 'GL-ft' : 'GL-m');
    });
    
    //  DL/De 
    updateCantileverRatio();
    updateCantileverInteractiveProfile();
}

//  Cantilever DL/De 
function updateCantileverRatio() {
    const deInput = document.getElementById('cantilever-de');
    const dlInput = document.getElementById('cantilever-dl');
    const ratioInput = document.getElementById('cantilever-dl-de-ratio');
    
    if (deInput && dlInput && ratioInput) {
        const de = parseFloat(deInput.value) || 0;
        const dl = parseFloat(dlInput.value) || 0;
        
        if (de > 0) {
            ratioInput.value = (dl / de).toFixed(2);
        } else {
            ratioInput.value = '0';
        }
    }
}

//  Cantilever 
document.addEventListener('DOMContentLoaded', function() {
    const cantileverDeInput = document.getElementById('cantilever-de');
    const cantileverDlInput = document.getElementById('cantilever-dl');
    
    if (cantileverDeInput) {
        cantileverDeInput.addEventListener('input', updateCantileverRatio);
    }
    if (cantileverDlInput) {
        cantileverDlInput.addEventListener('input', updateCantileverRatio);
    }
});

//  Cantilever 
function runCantileverAnalysis() {
    alert('Cantilever Excavation analysis is coming soon!');
    // TODO: 
}

//  Supported Diaphragm （ DIGGS Import）
function fillDiaphragmStratigraphicTableFromLayers(layers) {
    const numSelect = document.getElementById('diaphragm-num-layers');
    const tbody = document.getElementById('diaphragm-stratigraphic-table-body');
    if (!numSelect || !tbody) {
        console.warn('[Diaphragm Stratigraphy] controls not found');
        return false;
    }
    const n = Math.min(Math.max(layers.length, 1), 10);
    numSelect.value = String(n);
    updateDiaphragmStratigraphicTable(layers);
    return true;
}

//  Diaphragm Wall 
function updateDiaphragmStratigraphicTable(customLayers) {
    const numLayers = parseInt(document.getElementById('diaphragm-num-layers')?.value || 8);
    const tbody = document.getElementById('diaphragm-stratigraphic-table-body');
    const unitSystem = (document.querySelector('input[name="diaphragm-unit-system"]:checked') || {}).value || 'metric';
    const M_TO_FT = 3.28084;
    const KN_M3_TO_PCF = 6.36588;
    const KPA_TO_KSF = 1.0 / 47.88026;
    
    if (!tbody) return;
    
    // （）
    const defaultLayers = [
        { code: 'SF', type: 'D', depth: 1.50, gamma: 18.14, c: 0.00, phi: 28.00, su: '', spt: '', dw_exc: '', dw_ret: '', seepage: '' },
        { code: 'CL/ML', type: 'U', depth: 6.80, gamma: 18.44, c: '', phi: '', su: 0.24, spt: '', dw_exc: '', dw_ret: '', seepage: '' },
        { code: 'ML', type: 'D', depth: 9.50, gamma: 17.75, c: 0.00, phi: 29.00, su: '', spt: '', dw_exc: '', dw_ret: 5.00, seepage: '' },
        { code: 'SM', type: 'D', depth: 16.70, gamma: 18.73, c: 0.00, phi: 30.00, su: '', spt: 14.05, dw_exc: 14.05, dw_ret: 5.00, seepage: '' },
        { code: 'ML/CL', type: 'U', depth: 20.40, gamma: 18.24, c: '', phi: '', su: 0.25, spt: '', dw_exc: '', dw_ret: '', seepage: '' },
        { code: 'SM/ML', type: 'D', depth: 29.30, gamma: 18.83, c: 0.00, phi: 31.00, su: '', spt: '', dw_exc: 10.60, dw_ret: 7.00, seepage: 'H' },
        { code: 'ML/CL', type: 'U', depth: 33.00, gamma: 18.83, c: '', phi: '', su: 0.27, spt: '', dw_exc: '', dw_ret: '', seepage: '' },
        { code: 'SM', type: 'D', depth: 38.40, gamma: 19.81, c: 0.00, phi: 32.00, su: '', spt: '', dw_exc: 7.00, dw_ret: 7.00, seepage: '' }
    ];
    
    tbody.innerHTML = '';
    const layersToUse = Array.isArray(customLayers) && customLayers.length > 0 ? customLayers : null;
    const effectiveNum = layersToUse ? Math.min(layersToUse.length, 10) : numLayers;

    for (let i = 0; i < effectiveNum; i++) {
        const layerData = layersToUse ? layersToUse[i] : (defaultLayers[i] || {
            code: 'SM',
            type: 'D',
            depth: (i + 1) * 5.0,
            gamma: 18.5,
            c: 0,
            phi: 30,
            su: '',
            spt: '',
            dw_exc: '',
            dw_ret: '',
            seepage: ''
        });
        const displayDepth = unitSystem === 'imperial' ? (Number(layerData.depth) * M_TO_FT) : Number(layerData.depth);
        const displayGamma = unitSystem === 'imperial' ? (Number(layerData.gamma) * KN_M3_TO_PCF) : Number(layerData.gamma);
        const displayC = layerData.c === '' ? '' : (unitSystem === 'imperial' ? (Number(layerData.c) * KPA_TO_KSF) : Number(layerData.c));
        const displayDwExc = layerData.dw_exc === '' ? '' : (unitSystem === 'imperial' ? (Number(layerData.dw_exc) * M_TO_FT) : Number(layerData.dw_exc));
        const displayDwRet = layerData.dw_ret === '' ? '' : (unitSystem === 'imperial' ? (Number(layerData.dw_ret) * M_TO_FT) : Number(layerData.dw_ret));
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="text-align: center; padding: 8px;">${i + 1}</td>
            <td style="padding: 8px;">
                <input type="text" class="diaphragm-layer-code" value="${layerData.code}" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <select class="diaphragm-layer-type" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
                    <option value="D" ${layerData.type === 'D' ? 'selected' : ''}>D</option>
                    <option value="U" ${layerData.type === 'U' ? 'selected' : ''}>U</option>
                </select>
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-layer-depth" value="${displayDepth}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-layer-gamma" value="${displayGamma}" step="0.01" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-layer-c" value="${displayC}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-layer-phi" value="${layerData.phi}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-layer-su" value="${layerData.su}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-layer-spt" value="${layerData.spt}" step="1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-dw-exc-layer" value="${displayDwExc}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="diaphragm-dw-ret-layer" value="${displayDwRet}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
            <td style="padding: 8px;">
                <select class="diaphragm-seepage-mode" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
                    <option value="" ${layerData.seepage === '' ? 'selected' : ''}>-</option>
                    <option value="H" ${layerData.seepage === 'H' ? 'selected' : ''}>H</option>
                    <option value="no-seepage" ${layerData.seepage === 'no-seepage' ? 'selected' : ''}>No Seepage</option>
                    <option value="seepage" ${layerData.seepage === 'seepage' ? 'selected' : ''}>Seepage</option>
                </select>
            </td>
        `;
        tbody.appendChild(row);
    }
    
    // 
    updateDiaphragmInteractiveProfile();
}

//  Diaphragm Wall （，）
function updateDiaphragmLayeredWaterTable() {
    // ，
    // 
}

//  Diaphragm Wall 
function updateDiaphragmInteractiveProfile() {
    const container = document.getElementById('diaphragm-interactive-profile');
    if (!container || typeof Plotly === 'undefined') {
        return;
    }
    const unitSystem = (document.querySelector('input[name="diaphragm-unit-system"]:checked') || {}).value || 'metric';
    const lengthUnit = unitSystem === 'imperial' ? 'ft' : 'm';
    
    // 
    const layers = [];
    const rows = document.querySelectorAll('#diaphragm-stratigraphic-table-body tr');
    let prevDepth = 0;
    
    rows.forEach((row, index) => {
        const depth = parseFloat(row.querySelector('.diaphragm-layer-depth')?.value || 0);
        const code = row.querySelector('.diaphragm-layer-code')?.value || '';
        const type = row.querySelector('.diaphragm-layer-type')?.value || 'D';
        const gamma = parseFloat(row.querySelector('.diaphragm-layer-gamma')?.value || 18.5);
        const c = parseFloat(row.querySelector('.diaphragm-layer-c')?.value || 0);
        const phi = parseFloat(row.querySelector('.diaphragm-layer-phi')?.value || 30);
        
        if (depth > prevDepth) {
            layers.push({
                top: prevDepth,
                bottom: depth,
                code: code,
                type: type,
                gamma: gamma,
                c: c,
                phi: phi
            });
            prevDepth = depth;
        }
    });
    
    // 
    const dwRet = parseFloat(document.getElementById('diaphragm-dw-ret')?.value || 6);
    const dwExc = parseFloat(document.getElementById('diaphragm-dw-exc')?.value || 6);
    const de = parseFloat(document.getElementById('diaphragm-de')?.value || 0);
    const dl = parseFloat(document.getElementById('diaphragm-dl')?.value || 0);
    
    // 
    const traces = [];
    const maxDepth = Math.max(...layers.map(l => l.bottom), dl, dwRet, dwExc, de) + 2;
    
    // 
    layers.forEach((layer, idx) => {
        const color = layer.type === 'U' ? '#8B4513' : '#D2B48C';
        traces.push({
            x: [0, 10, 10, 0, 0],
            y: [-layer.top, -layer.top, -layer.bottom, -layer.bottom, -layer.top],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: color,
            line: { color: '#000', width: 1 },
            showlegend: false,
            hoverinfo: 'skip'
        });
        
        // 
        const midDepth = (layer.top + layer.bottom) / 2;
        const cohesionUnit = unitSystem === 'imperial' ? 'ksf' : 'kPa';
        traces.push({
            x: [5],
            y: [-midDepth],
            type: 'scatter',
            mode: 'text',
            text: [`[${layer.code}] c = ${layer.c} ${cohesionUnit} / φ = ${layer.phi}°`],
            textfont: { size: 10 },
            showlegend: false,
            hoverinfo: 'skip'
        });
    });
    
    // 
    if (dl > 0) {
        traces.push({
            x: [4.85, 5.15, 5.15, 4.85, 4.85],
            y: [0, 0, -dl, -dl, 0],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: '#808080',
            line: { color: '#000', width: 2 },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    // 
    if (de > 0) {
        traces.push({
            x: [0, 4.85, 4.85, 0, 0],
            y: [0, 0, -de, -de, 0],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: 'rgba(200, 200, 200, 0.3)',
            line: { color: '#000', width: 2 },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    // 
    if (dwRet > 0) {
        traces.push({
            x: [5.15, 10],
            y: [-dwRet, -dwRet],
            type: 'scatter',
            mode: 'lines',
            line: { color: '#0066CC', width: 2, dash: 'dash' },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    if (dwExc > 0) {
        traces.push({
            x: [0, 4.85],
            y: [-dwExc, -dwExc],
            type: 'scatter',
            mode: 'lines',
            line: { color: '#0066CC', width: 2, dash: 'dash' },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    // （）
    if (de > 0 && layers.length > 0) {
        const pressure = 6.5; // 
        traces.push({
            x: [0, pressure, pressure, 0, 0],
            y: [-de, -de, -dl, -dl, -de],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: 'rgba(255, 0, 0, 0.2)',
            line: { color: '#FF0000', width: 1 },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    const layout = {
        xaxis: { 
            title: `Distance (${lengthUnit})`, 
            range: [0, 10],
            showgrid: false,
            zeroline: false
        },
        yaxis: { 
            title: `Depth (${lengthUnit})`, 
            range: [-maxDepth, 1],
            autorange: 'reversed',
            showgrid: false,
            zeroline: false
        },
        margin: { l: 60, r: 20, t: 20, b: 60 },
        showlegend: false,
        plot_bgcolor: '#E6F3FF',
        paper_bgcolor: 'white'
    };
    
    Plotly.newPlot(container, traces, layout, { responsive: true, displayModeBar: false });
}

//  Cantilever 
function updateCantileverStratigraphicTable() {
    const numLayers = parseInt(document.getElementById('cantilever-num-layers')?.value || 3);
    const tbody = document.getElementById('cantilever-stratigraphic-table-body');
    const unitSystem = (document.querySelector('input[name="cantilever-unit-system"]:checked') || {}).value || 'metric';
    const M_TO_FT = 3.28084;
    const KN_M3_TO_PCF = 6.36588;
    const KPA_TO_KSF = 1.0 / 47.88026;
    
    if (!tbody) return;
    
    // 
    const defaultLayers = [
        { code: 'SF', type: 'D', depth: 1.2, gamma: 18.14, c: 0, phi: 28, su: '', spt: '' },
        { code: 'CL', type: 'D', depth: 4.1, gamma: 17.26, c: 0, phi: 29, su: '', spt: '' },
        { code: 'SM', type: 'D', depth: 15.0, gamma: 18.83, c: 0, phi: 30, su: '', spt: '' }
    ];
    
    tbody.innerHTML = '';
    
    for (let i = 0; i < numLayers; i++) {
        const layerData = defaultLayers[i] || {
            code: 'SM',
            type: 'D',
            depth: (i + 1) * 5.0,
            gamma: 18.5,
            c: 0,
            phi: 30,
            su: '',
            spt: ''
        };
        const displayDepth = unitSystem === 'imperial' ? (Number(layerData.depth) * M_TO_FT) : Number(layerData.depth);
        const displayGamma = unitSystem === 'imperial' ? (Number(layerData.gamma) * KN_M3_TO_PCF) : Number(layerData.gamma);
        const displayC = layerData.c === '' ? '' : (unitSystem === 'imperial' ? (Number(layerData.c) * KPA_TO_KSF) : Number(layerData.c));
        const displaySu = layerData.su === '' ? '' : (unitSystem === 'imperial' ? (Number(layerData.su) * KPA_TO_KSF) : Number(layerData.su));
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="text-align: center; padding: 8px;">${i + 1}</td>
            <td style="padding: 8px;">
                <input type="text" class="cantilever-layer-code" value="${layerData.code}" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <select class="cantilever-layer-type" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
                    <option value="D" ${layerData.type === 'D' ? 'selected' : ''}>D</option>
                    <option value="U" ${layerData.type === 'U' ? 'selected' : ''}>U</option>
                </select>
            </td>
            <td style="padding: 8px;">
                <input type="number" class="cantilever-layer-depth" value="${displayDepth}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="cantilever-layer-gamma" value="${displayGamma}" step="0.01" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="cantilever-layer-c" value="${displayC}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="cantilever-layer-phi" value="${layerData.phi}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="cantilever-layer-su" value="${displaySu}" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="cantilever-layer-spt" value="${layerData.spt}" step="1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
        `;
        tbody.appendChild(row);
    }
    
    // 
    updateCantileverLayeredWaterTable();
    // 
    updateCantileverInteractiveProfile();
}

//  Cantilever 
function updateCantileverLayeredWaterTable() {
    const numLayers = parseInt(document.getElementById('cantilever-num-layers')?.value || 3);
    const tbody = document.getElementById('cantilever-layered-water-table-body');
    
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    for (let i = 0; i < numLayers; i++) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="padding: 8px;">
                <input type="number" class="cantilever-dw-exc-layer" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
            <td style="padding: 8px;">
                <input type="number" class="cantilever-dw-ret-layer" step="0.1" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;" placeholder="-">
            </td>
            <td style="padding: 8px;">
                <select class="cantilever-seepage-mode" style="width: 100%; padding: 5px; border: 1px solid #e2e8f0; border-radius: 4px;">
                    <option value="">-</option>
                    <option value="no-seepage">No Seepage</option>
                    <option value="seepage">Seepage</option>
                </select>
            </td>
        `;
        tbody.appendChild(row);
    }
}

//  Cantilever 
function updateCantileverInteractiveProfile() {
    const container = document.getElementById('cantilever-interactive-profile');
    if (!container || typeof Plotly === 'undefined') {
        return;
    }
    const unitSystem = (document.querySelector('input[name="cantilever-unit-system"]:checked') || {}).value || 'metric';
    const lengthUnit = unitSystem === 'imperial' ? 'ft' : 'm';
    
    // 
    const layers = [];
    const rows = document.querySelectorAll('#cantilever-stratigraphic-table-body tr');
    let prevDepth = 0;
    
    rows.forEach((row, index) => {
        const depth = parseFloat(row.querySelector('.cantilever-layer-depth')?.value || 0);
        const code = row.querySelector('.cantilever-layer-code')?.value || '';
        const type = row.querySelector('.cantilever-layer-type')?.value || 'D';
        const gamma = parseFloat(row.querySelector('.cantilever-layer-gamma')?.value || 18.5);
        const c = parseFloat(row.querySelector('.cantilever-layer-c')?.value || 0);
        const phi = parseFloat(row.querySelector('.cantilever-layer-phi')?.value || 30);
        
        if (depth > prevDepth) {
            layers.push({
                top: prevDepth,
                bottom: depth,
                code: code,
                type: type,
                gamma: gamma,
                c: c,
                phi: phi
            });
            prevDepth = depth;
        }
    });
    
    // 
    const dwRet = parseFloat(document.getElementById('cantilever-dw-ret')?.value || 6);
    const dwExc = parseFloat(document.getElementById('cantilever-dw-exc')?.value || 6);
    const de = parseFloat(document.getElementById('cantilever-de')?.value || 0);
    const dl = parseFloat(document.getElementById('cantilever-dl')?.value || 0);
    
    // （ Diaphragm Wall ）
    const traces = [];
    const maxDepth = Math.max(...layers.map(l => l.bottom), dl, dwRet, dwExc, de) + 2;
    
    // 
    layers.forEach((layer, idx) => {
        const color = layer.type === 'U' ? '#8B4513' : '#D2B48C';
        traces.push({
            x: [0, 10, 10, 0, 0],
            y: [-layer.top, -layer.top, -layer.bottom, -layer.bottom, -layer.top],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: color,
            line: { color: '#000', width: 1 },
            showlegend: false,
            hoverinfo: 'skip'
        });
        
        // 
        const midDepth = (layer.top + layer.bottom) / 2;
        const cohesionUnit = unitSystem === 'imperial' ? 'ksf' : 'kPa';
        traces.push({
            x: [5],
            y: [-midDepth],
            type: 'scatter',
            mode: 'text',
            text: [`[${layer.code}] c = ${layer.c} ${cohesionUnit} / φ = ${layer.phi}°`],
            textfont: { size: 10 },
            showlegend: false,
            hoverinfo: 'skip'
        });
    });
    
    // 
    if (dl > 0) {
        traces.push({
            x: [4.85, 5.15, 5.15, 4.85, 4.85],
            y: [0, 0, -dl, -dl, 0],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: '#808080',
            line: { color: '#000', width: 2 },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    // 
    if (de > 0) {
        traces.push({
            x: [0, 4.85, 4.85, 0, 0],
            y: [0, 0, -de, -de, 0],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: 'rgba(200, 200, 200, 0.3)',
            line: { color: '#000', width: 2 },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    // 
    if (dwRet > 0) {
        traces.push({
            x: [5.15, 10],
            y: [-dwRet, -dwRet],
            type: 'scatter',
            mode: 'lines',
            line: { color: '#0066CC', width: 2, dash: 'dash' },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    if (dwExc > 0) {
        traces.push({
            x: [0, 4.85],
            y: [-dwExc, -dwExc],
            type: 'scatter',
            mode: 'lines',
            line: { color: '#0066CC', width: 2, dash: 'dash' },
            showlegend: false,
            hoverinfo: 'skip'
        });
    }
    
    const layout = {
        xaxis: { 
            title: `Distance (${lengthUnit})`, 
            range: [0, 10],
            showgrid: false,
            zeroline: false
        },
        yaxis: { 
            title: `Depth (${lengthUnit})`, 
            range: [-maxDepth, 1],
            autorange: 'reversed',
            showgrid: false,
            zeroline: false
        },
        margin: { l: 60, r: 20, t: 20, b: 60 },
        showlegend: false,
        plot_bgcolor: '#E6F3FF',
        paper_bgcolor: 'white'
    };
    
    Plotly.newPlot(container, traces, layout, { responsive: true, displayModeBar: false });
}

// ========== Shallow Foundation ==========
function changeSfUnitSystem(unit) {
    const selected = (unit !== undefined && unit !== '') ? unit : ((document.querySelector('input[name="sf-unit-system"]:checked') || {}).value || 'metric');
    const previous = window.__sfUnitSystem || selected;
    const unitChanged = previous !== selected;
    const isMetric = selected === 'metric';
    const length = isMetric ? 'm' : 'ft';
    const pressure = isMetric ? 'kPa' : 'ksf';
    const weight = isMetric ? 'kN/m³' : 'pcf';  // γt: metric kN/m³, imperial pcf (not psf)
    const force = isMetric ? 'kN' : 'kip';
    const moment = isMetric ? 'kN·m' : 'kip·ft';
    document.querySelectorAll('.sf-unit-length').forEach(el => { el.textContent = length; });
    document.querySelectorAll('.sf-unit-pressure').forEach(el => { el.textContent = pressure; });
    document.querySelectorAll('.sf-unit-weight').forEach(el => { el.textContent = weight; });
    document.querySelectorAll('.sf-unit-force').forEach(el => { el.textContent = force; });
    document.querySelectorAll('.sf-unit-moment').forEach(el => { el.textContent = moment; });

    // Keep Stratigraphic Settings headers with proper subscripts and unit labels.
    const sfHeaderRow = document.querySelector('#sf-layers-table thead tr');
    if (sfHeaderRow) {
        sfHeaderRow.innerHTML = `
            <th>z<sub>top</sub> (<span class="sf-unit-length">${length}</span>)</th>
            <th>z<sub>bot</sub> (<span class="sf-unit-length">${length}</span>)</th>
            <th>γ<sub>t</sub> (<span class="sf-unit-weight">${weight}</span>)</th>
            <th>Soil Class</th>
            <th>Drainage</th>
            <th>S<sub>u</sub> (<span class="sf-unit-pressure">${pressure}</span>)</th>
            <th>c′ (<span class="sf-unit-pressure">${pressure}</span>)</th>
            <th>φ′ (°)</th>
            <th></th>
        `;
    }

    if (unitChanged) {
        const FT_TO_M = 0.3048;
        const KN_TO_KIP = 0.22480894387096;
        const KNM_TO_KIPFT = 0.73756214927727;
        const KPA_TO_KSF = 0.02088543423315;
        const KNM3_TO_PCF = 6.36588037829;

        const convert = (value, metricToImperialFactor) => {
            const v = Number(value);
            if (!Number.isFinite(v)) return value;
            if (previous === 'metric' && selected === 'imperial') {
                return (v * metricToImperialFactor).toFixed(3);
            }
            return (v / metricToImperialFactor).toFixed(3);
        };

        const convertById = (id, factor) => {
            const el = document.getElementById(id);
            if (!el || el.value === '') return;
            el.value = convert(el.value, factor);
        };

        const convertBySelector = (selector, factor) => {
            document.querySelectorAll(selector).forEach((el) => {
                if (!el || el.value === '') return;
                el.value = convert(el.value, factor);
            });
        };

        // Length-related fields
        ['sf-Df', 'sf-Lx', 'sf-Ly', 'sf-cx', 'sf-cy', 'sf-ecx', 'sf-ecy', 'sf-Dw'].forEach((id) => convertById(id, 1.0 / FT_TO_M));
        convertBySelector('.sf-z-top, .sf-z-bot', 1.0 / FT_TO_M);

        // Unit weight and soil strength
        convertBySelector('.sf-gamma-t', KNM3_TO_PCF);
        convertBySelector('.sf-su, .sf-c-prime', KPA_TO_KSF);

        // Loads
        ['D', 'L', 'W', 'E'].forEach((k) => {
            ['Vx', 'Vy', 'Pz'].forEach((c) => convertById(`sf-${k}-${c}`, KN_TO_KIP));
            ['Mx', 'My'].forEach((c) => convertById(`sf-${k}-${c}`, KNM_TO_KIPFT));
        });

        // Clear displayed results so stale unit values are not mixed after switching.
        const wrapper = document.getElementById('sf-result-table-wrapper');
        const area = document.getElementById('sf-result-area');
        if (wrapper) wrapper.innerHTML = '';
        if (area) area.style.display = 'none';
    }

    window.__sfUnitSystem = selected;
}

function getSfPayload() {
    const unitSystem = (document.querySelector('input[name="sf-unit-system"]:checked') || {}).value || 'metric';
    const bearingMethod = (document.getElementById('sf-bearing-method') || {}).value || 'Vesic1973';
    const defaultGamma = unitSystem === 'metric' ? 18.6 : 118.0;
    const defaultLoads = unitSystem === 'metric'
        ? {
            D: { Vx: 98.1, Vy: 49.0, Pz: 294.2, Mx: 19.6, My: 39.2 },
            L: { Vx: 58.8, Vy: 39.2, Pz: 205.9, Mx: 19.6, My: 42.2 }
        }
        : {
            D: { Vx: 22.0, Vy: 11.0, Pz: 66.1, Mx: 14.5, My: 28.9 },
            L: { Vx: 13.2, Vy: 8.8, Pz: 46.3, Mx: 14.5, My: 31.1 }
        };
    const layers = [];
    document.querySelectorAll('#sf-layers-body tr').forEach(tr => {
        const zTop = parseFloat(tr.querySelector('.sf-z-top')?.value || 0) || 0;
        const zBot = parseFloat(tr.querySelector('.sf-z-bot')?.value || (zTop + 1)) || (zTop + 1);
        const gamma = parseFloat(tr.querySelector('.sf-gamma-t')?.value || defaultGamma) || defaultGamma;
        const soil = (tr.querySelector('.sf-soil')?.value || 'SM').trim().toUpperCase();
        const drainageType = (tr.querySelector('.sf-drainage-type')?.value || 'D').toUpperCase();
        const su = parseFloat(tr.querySelector('.sf-su')?.value || 0) || 0;
        const c = parseFloat(tr.querySelector('.sf-c-prime')?.value || 0) || 0;
        const phi = parseFloat(tr.querySelector('.sf-phi-prime')?.value || 0) || 0;
        layers.push({
            z_top: zTop,
            z_bot: zBot,
            gamma_t: gamma,
            soil: soil,
            drainage_type: drainageType,
            Su: su,
            c_prime: c,
            phi_prime: phi,
        });
    });
    return {
        bearing_method: bearingMethod,
        Df: parseFloat(document.getElementById('sf-Df')?.value) || 2.2,
        Lx: parseFloat(document.getElementById('sf-Lx')?.value) || 3.2,
        Ly: parseFloat(document.getElementById('sf-Ly')?.value) || 2.5,
        cx: parseFloat(document.getElementById('sf-cx')?.value) || 0,
        cy: parseFloat(document.getElementById('sf-cy')?.value) || 0,
        ecx: parseFloat(document.getElementById('sf-ecx')?.value) || 0.1,
        ecy: parseFloat(document.getElementById('sf-ecy')?.value) || 0.3,
        Dw: parseFloat(document.getElementById('sf-Dw')?.value) || 1.2,
        FSb1: parseFloat(document.getElementById('sf-FSb1')?.value) || 3,
        FSb2: parseFloat(document.getElementById('sf-FSb2')?.value) || 2,
        FSb3: parseFloat(document.getElementById('sf-FSb3')?.value) || 1.1,
        layers,
        load_D: { Vx: parseFloat(document.getElementById('sf-D-Vx')?.value)||defaultLoads.D.Vx, Vy: parseFloat(document.getElementById('sf-D-Vy')?.value)||defaultLoads.D.Vy, Pz: parseFloat(document.getElementById('sf-D-Pz')?.value)||defaultLoads.D.Pz, Mx: parseFloat(document.getElementById('sf-D-Mx')?.value)||defaultLoads.D.Mx, My: parseFloat(document.getElementById('sf-D-My')?.value)||defaultLoads.D.My },
        load_L: { Vx: parseFloat(document.getElementById('sf-L-Vx')?.value)||defaultLoads.L.Vx, Vy: parseFloat(document.getElementById('sf-L-Vy')?.value)||defaultLoads.L.Vy, Pz: parseFloat(document.getElementById('sf-L-Pz')?.value)||defaultLoads.L.Pz, Mx: parseFloat(document.getElementById('sf-L-Mx')?.value)||defaultLoads.L.Mx, My: parseFloat(document.getElementById('sf-L-My')?.value)||defaultLoads.L.My },
        load_W: { Vx: parseFloat(document.getElementById('sf-W-Vx')?.value)||0, Vy: parseFloat(document.getElementById('sf-W-Vy')?.value)||0, Pz: parseFloat(document.getElementById('sf-W-Pz')?.value)||0, Mx: parseFloat(document.getElementById('sf-W-Mx')?.value)||0, My: parseFloat(document.getElementById('sf-W-My')?.value)||0 },
        load_E: { Vx: parseFloat(document.getElementById('sf-E-Vx')?.value)||0, Vy: parseFloat(document.getElementById('sf-E-Vy')?.value)||0, Pz: parseFloat(document.getElementById('sf-E-Pz')?.value)||0, Mx: parseFloat(document.getElementById('sf-E-Mx')?.value)||0, My: parseFloat(document.getElementById('sf-E-My')?.value)||0 },
        load_combinations: [
            { id: 'LC1', description: '1.0D + 1.0L', factors: { D: 1, L: 1, W: 0, E: 0 } },
            { id: 'LC2', description: '1.0D + 1.0L + 1.0W', factors: { D: 1, L: 1, W: 1, E: 0 } },
            { id: 'LC3', description: '1.0D + 1.0L - 1.0W', factors: { D: 1, L: 1, W: -1, E: 0 } },
            { id: 'LC4', description: '1.0D + 1.0L + 1.0E', factors: { D: 1, L: 1, W: 0, E: 1 } },
            { id: 'LC5', description: '1.0D + 1.0L - 1.0E', factors: { D: 1, L: 1, W: 0, E: -1 } },
        ],
        unit_system: unitSystem,
    };
}

function updateSfDrainageRow(row) {
    if (!row) return;
    const drainageType = (row.querySelector('.sf-drainage-type')?.value || 'D').toUpperCase();
    const suInput = row.querySelector('.sf-su');
    const cInput = row.querySelector('.sf-c-prime');
    const phiInput = row.querySelector('.sf-phi-prime');
    if (!suInput || !cInput || !phiInput) return;

    if (drainageType === 'U') {
        suInput.disabled = false;
        cInput.disabled = true;
        phiInput.disabled = true;
        cInput.value = '0';
        phiInput.value = '0';
    } else {
        suInput.disabled = true;
        suInput.value = '0';
        cInput.disabled = false;
        phiInput.disabled = false;
    }
}

function removeSfLayer(btn) {
    const row = btn && btn.closest ? btn.closest('tr') : null;
    if (row) row.remove();
}

function addSfLayer() {
    const tbody = document.getElementById('sf-layers-body');
    if (!tbody) return;
    const unitSystem = (document.querySelector('input[name="sf-unit-system"]:checked') || {}).value || 'metric';
    const isMetric = unitSystem === 'metric';
    const last = tbody.querySelector('tr:last-child');
    let zTop = 0, zBot = 1;
    if (last) {
        zTop = parseFloat(last.querySelector('.sf-z-bot')?.value || 0) || 0;
        zBot = zTop + 1;
    }
    const defaultGamma = isMetric ? 18.6 : 118.0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="number" class="sf-z-top" value="${zTop.toFixed(3)}" step="0.1"></td><td><input type="number" class="sf-z-bot" value="${zBot.toFixed(3)}" step="0.1"></td><td><input type="number" class="sf-gamma-t" value="${defaultGamma.toFixed(3)}" step="0.01"></td><td><input type="text" class="sf-soil" value="SM" placeholder="SM"></td><td><select class="sf-drainage-type" onchange="updateSfDrainageRow(this.closest('tr'))"><option value="D" selected>D</option><option value="U">U</option></select></td><td><input type="number" class="sf-su" value="0" step="0.1"></td><td><input type="number" class="sf-c-prime" value="0" step="0.1"></td><td><input type="number" class="sf-phi-prime" value="30" step="1"></td><td><button type="button" onclick="removeSfLayer(this)">×</button></td>`;
    tbody.appendChild(tr);
    updateSfDrainageRow(tr);
}

function closeSfAnalysisSummaryModal() {
    const modal = document.getElementById('sf-analysis-summary-modal');
    if (modal) modal.style.display = 'none';
}

function showSfAnalysisSummaryModal(payload, bearingRows) {
    const modal = document.getElementById('sf-analysis-summary-modal');
    const body = document.getElementById('sf-analysis-summary-body');
    if (!modal || !body) return;

    const isMetric = (payload?.unit_system || 'metric') === 'metric';
    const lengthUnit = isMetric ? 'm' : 'ft';
    const stressUnit = isMetric ? 'kPa' : 'ksf';
    const forceUnit = isMetric ? 'kN' : 'kip';

    const validRows = (Array.isArray(bearingRows) ? bearingRows : []).filter(r => !r.error);
    const toNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const rangeText = (rows, key, digits = 2) => {
        const nums = rows.map(r => toNum(r[key])).filter(v => v !== null);
        if (!nums.length) return '—';
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        if (Math.abs(max - min) < 1e-9) return min.toFixed(digits);
        return `${min.toFixed(digits)} ~ ${max.toFixed(digits)}`;
    };

    const qufRange = rangeText(validRows, 'quf');
    const qa1Range = rangeText(validRows, 'qa1');
    const pa1Range = rangeText(validRows, 'Pa1');
    const qa2Range = rangeText(validRows, 'qa2');
    const pa2Range = rangeText(validRows, 'Pa2');
    const qa3Range = rangeText(validRows, 'qa3');
    const pa3Range = rangeText(validRows, 'Pa3');

    body.innerHTML = `
        <div class="sf-params-box">
            <div style="font-weight: 600; color: #334155; margin-bottom: 8px;">Foundation Specifications</div>
            <div>Foundation Type: Isolated Footing</div>
            <div>Dimensions: L<sub>x</sub> × L<sub>y</sub> = ${Number(payload.Lx || 0).toFixed(2)} (${lengthUnit}) × ${Number(payload.Ly || 0).toFixed(2)} (${lengthUnit})</div>
        </div>
        <div style="margin-top: 20px;">
            <div style="font-weight: 600; color: #334155; margin-bottom: 10px; font-size: 14px;">Bearing Capacity Summary</div>
            <table>
                <thead><tr>
                    <th style="text-align: left;">Item</th>
                    <th style="text-align: right;">(${stressUnit})</th>
                    <th style="text-align: right;">(${forceUnit})</th>
                </tr></thead>
                <tbody>
                    <tr><td>Ultimate bearing capacity q<sub>uf</sub></td><td style="text-align: right;">${qufRange}</td><td style="text-align: right;">—</td></tr>
                    <tr><td>Long-term allowable q<sub>a1</sub> / P<sub>a1</sub></td><td style="text-align: right;">${qa1Range}</td><td style="text-align: right;">${pa1Range}</td></tr>
                    <tr><td>Short-term allowable q<sub>a2</sub> / P<sub>a2</sub></td><td style="text-align: right;">${qa2Range}</td><td style="text-align: right;">${pa2Range}</td></tr>
                    <tr><td>Ultimate limit state q<sub>a3</sub> / P<sub>a3</sub></td><td style="text-align: right;">${qa3Range}</td><td style="text-align: right;">${pa3Range}</td></tr>
                </tbody>
            </table>
        </div>
    `;

    modal.style.display = 'flex';
}

async function runShallowFoundationAnalysis() {
    const payload = getSfPayload();
    const area = document.getElementById('sf-result-area');
    const wrapper = document.getElementById('sf-result-table-wrapper');
    try {
        const resp = await fetch('/api/shallow-foundation/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await resp.json();
        if (data.status !== 'success') {
            alert(data.message || 'Calculation failed');
            return;
        }
        const serviceRows = data.service_combinations || [];
        const bearingRows = data.bearing_rows || data.rows || [];
        showSfAnalysisSummaryModal(payload, bearingRows);

        if (area && wrapper) {
            let html = '';

            const methodLabelMap = {
                Vesic1973: 'Vesic (1973)',
                Hansen1970: 'Hansen (1970)',
                Meyerhof1963: 'Meyerhof (1963)',
                Terzaghi1943: 'Terzaghi (1943)',
            };
            const methodLabel = (data?.metadata?.bearing_method_display) || methodLabelMap[payload.bearing_method] || String(payload.bearing_method || '');

            const firstOk = Array.isArray(bearingRows) ? bearingRows.find(r => r && !r.error) : null;
            const Nc = firstOk?.Nc;
            const Nq = firstOk?.Nq;
            const Ngamma = firstOk?.Ngamma;

            html += `
                <div style="padding: 12px 14px; margin: 0 0 14px 0; border: 1px solid rgba(184, 169, 201, 0.35); background: rgba(184, 169, 201, 0.08); border-radius: 10px;">
                    <div style="font-weight: 700; margin-bottom: 6px;">Selected Method: ${escapeHtml(methodLabel)}</div>
                    <div style="display:flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary);">
                        <div><strong style="color: var(--text-primary);">N<sub>c</sub></strong> = ${Nc != null ? Nc : '—'}</div>
                        <div><strong style="color: var(--text-primary);">N<sub>q</sub></strong> = ${Nq != null ? Nq : '—'}</div>
                        <div><strong style="color: var(--text-primary);">N<sub>γ</sub></strong> = ${Ngamma != null ? Ngamma : '—'}</div>
                    </div>
                </div>
            `;

            // Service load combinations
            html += '<h4 style=\"margin: 0 0 8px 0;\">Service Load Combinations</h4>';
            html += '<table style=\"width:100%; font-size:12px; border-collapse:collapse; margin-bottom: 14px;\"><thead><tr>';
            ['Load Case', 'Vsx', 'Vsy', 'Psz', 'Msx', 'Msy', 'Combination Description'].forEach(c => {
                html += '<th style=\"padding:6px; border:1px solid #ccc; background:#4A90D9; color:#fff;\">' + c + '</th>';
            });
            html += '</tr></thead><tbody>';
            serviceRows.forEach(r => {
                html += '<tr>';
                [r.load_case, r.Vsx, r.Vsy, r.Psz, r.Msx, r.Msy, r.description].forEach(v => {
                    html += '<td style=\"padding:6px; border:1px solid #ccc;\">' + (v != null ? v : '-') + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';

            // Bearing capacity - upper table
            html += '<h4 style=\"margin: 0 0 8px 0;\">Bearing Capacity (Upper Table)</h4>';
            const upperCols = ['Load Case', 'cf', 'φf', 'γ1', 'γ2', 'Nc', 'Nq', 'Nγ', 'Lx', 'Ly', 'ex', 'ey', 'B\'', 'L\'', 'βx', 'βy'];
            html += '<table style=\"width:100%; font-size:12px; border-collapse:collapse; margin-bottom: 14px;\"><thead><tr>';
            upperCols.forEach(c => { html += '<th style=\"padding:6px; border:1px solid #ccc; background:#4A90D9; color:#fff;\">' + c + '</th>'; });
            html += '</tr></thead><tbody>';
            bearingRows.forEach(r => {
                if (r.error) {
                    html += '<tr><td colspan=\"' + upperCols.length + '\" style=\"padding:6px; border:1px solid #ccc; color:#b00;\">' + (r.description || r.combo_note || r.load_case || '') + ': ' + r.error + '</td></tr>';
                    return;
                }
                html += '<tr>';
                [r.load_case || r.lc_id, r.cf, r.phi_f, r.gamma1, r.gamma2, r.Nc, r.Nq, r.Ngamma, r.Lx, r.Ly, r.ex, r.ey, r.Bprime, r.Lprime, r.beta_x, r.beta_y].forEach(v => {
                    html += '<td style=\"padding:6px; border:1px solid #ccc;\">' + (v != null ? v : '-') + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';

            // Bearing capacity - lower table
            html += '<h4 style=\"margin: 0 0 8px 0;\">Bearing Capacity (Lower Table)</h4>';
            const lowerCols = ['Load Case', 'Fcs', 'Fcd', 'Fci', 'Fqs', 'Fqd', 'Fqi', 'Fγs', 'Fγd', 'Fγi', 'quf', 'qa1', 'qa2', 'qa3', 'Pa1', 'Pa2', 'Pa3'];
            html += '<table style=\"width:100%; font-size:12px; border-collapse:collapse;\"><thead><tr>';
            lowerCols.forEach(c => { html += '<th style=\"padding:6px; border:1px solid #ccc; background:#4A90D9; color:#fff;\">' + c + '</th>'; });
            html += '</tr></thead><tbody>';
            bearingRows.forEach(r => {
                if (r.error) return;
                html += '<tr>';
                [r.load_case || r.lc_id, r.Fcs, r.Fcd, r.Fci, r.Fqs, r.Fqd, r.Fqi, r.Fgs, r.Fgd, r.Fgi, r.quf, r.qa1, r.qa2, r.qa3, r.Pa1, r.Pa2, r.Pa3].forEach(v => {
                    html += '<td style=\"padding:6px; border:1px solid #ccc;\">' + (v != null ? v : '-') + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';

            wrapper.innerHTML = html;
            area.style.display = 'block';
            area.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    } catch (e) {
        alert('Error: ' + (e.message || String(e)));
    }
}

async function exportShallowFoundationExcel() {
    const payload = getSfPayload();
    try {
        const resp = await fetch('/api/shallow-foundation/export-excel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!resp.ok) {
            const j = await resp.json().catch(() => ({}));
            alert(j.message || 'Export failed');
            return;
        }
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'Shallow_Foundation_Bearing_Capacity.xlsx';
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        alert('Error: ' + (e.message || String(e)));
    }
}

// 
document.addEventListener('DOMContentLoaded', function() {
    // 
    const diaphragmNumLayers = document.getElementById('diaphragm-num-layers');
    if (diaphragmNumLayers) {
        diaphragmNumLayers.addEventListener('change', updateDiaphragmStratigraphicTable);
        // 
        updateDiaphragmStratigraphicTable();
    }
    updateDiaphragmSurchargeInputs();
    const subTbody = document.getElementById('diaphragm-sub-table-body');
    if (subTbody && subTbody.children.length === 0) {
        addDiaphragmSubRow({ Z: 2.0, A: 2.0, B: 6.0, Q: 10.0 });
    }
    
    const cantileverNumLayers = document.getElementById('cantilever-num-layers');
    if (cantileverNumLayers) {
        cantileverNumLayers.addEventListener('change', updateCantileverStratigraphicTable);
        // 
        updateCantileverStratigraphicTable();
    }
    
    // 
    const diaphragmInputs = ['diaphragm-dw-ret', 'diaphragm-dw-exc', 'diaphragm-de', 'diaphragm-dl', 'diaphragm-ds'];
    diaphragmInputs.forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', updateDiaphragmInteractiveProfile);
        }
    });
    
    const cantileverInputs = ['cantilever-dw-ret', 'cantilever-dw-exc', 'cantilever-de', 'cantilever-dl'];
    cantileverInputs.forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', updateCantileverInteractiveProfile);
        }
    });

    // Initialize shallow foundation drainage row states
    document.querySelectorAll('#sf-layers-body tr').forEach(tr => updateSfDrainageRow(tr));
    // Initialize shallow foundation unit labels and baseline unit state
    changeSfUnitSystem();
});
