import * as THREE from 'three';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/controls/OrbitControls.js';

const STAC_COLLECTION = 'ch.swisstopo.swissalti3d';
const STAC_ITEMS = `https://data.geo.admin.ch/api/stac/v1/collections/${STAC_COLLECTION}/items`;
const MAX_TILES = 1600;
const MAX_STAC_PAGES = 120;
const TILE_CONCURRENCY = 6;
const REQUEST_RETRIES = 3;
const RETRY_BASE_MS = 450;

const $ = (id) => document.getElementById(id);
const els = {
  generateBtn: $('generateBtn'), downloadBtn: $('downloadBtn'), clearBtn: $('clearBtn'), resetViewBtn: $('resetViewBtn'),
  sourceResolution: $('sourceResolution'), modelWidth: $('modelWidth'), baseThickness: $('baseThickness'),
  zExaggeration: $('zExaggeration'), gridSize: $('gridSize'), smoothMissing: $('smoothMissing'),
  selectionInfo: $('selectionInfo'), metrics: $('metrics'), statusText: $('statusText'), statusPct: $('statusPct'),
  progress: $('progress'), preview: $('preview'), resultInfo: $('resultInfo'), debug: $('debug')
};

let selectedBounds = null;
let selectedLayer = null;
let terrain = null;
let lastStlBlob = null;
let renderer, scene, camera, controls, terrainGroup;

// CH1903+ / LV95 (EPSG:2056). proj4 contains the transformation logic; definition is explicit for portability.
proj4.defs('EPSG:2056', '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');

const map = L.map('map', { zoomControl: true }).setView([46.82, 8.23], 8);
L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
  maxZoom: 19,
  attribution: '© swisstopo'
}).addTo(map);

const drawnItems = new L.FeatureGroup().addTo(map);
const drawControl = new L.Control.Draw({
  draw: { polygon: false, polyline: false, circle: false, circlemarker: false, marker: false, rectangle: { shapeOptions: { color: '#b82025', weight: 2 } } },
  edit: { featureGroup: drawnItems, edit: false, remove: false }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  drawnItems.clearLayers();
  selectedLayer = e.layer;
  drawnItems.addLayer(selectedLayer);
  selectedBounds = selectedLayer.getBounds();
  terrain = null;
  lastStlBlob = null;
  els.downloadBtn.disabled = true;
  updateSelectionUI();
});

els.clearBtn.addEventListener('click', () => {
  drawnItems.clearLayers();
  selectedBounds = null;
  selectedLayer = null;
  terrain = null;
  lastStlBlob = null;
  els.generateBtn.disabled = true;
  els.downloadBtn.disabled = true;
  els.selectionInfo.textContent = 'Noch kein Gebiet gewählt.';
  els.resultInfo.textContent = '';
  updateMetrics();
  clearPreview();
});

['input','change'].forEach(evt => {
  [els.modelWidth, els.baseThickness, els.zExaggeration, els.gridSize, els.sourceResolution].forEach(el => el.addEventListener(evt, () => {
    updateMetrics();
    if (lastStlBlob) {
      lastStlBlob = null;
      els.downloadBtn.disabled = true;
      els.resultInfo.textContent = 'Einstellungen geändert – Relief bitte neu erzeugen.';
    }
  }));
});

els.generateBtn.addEventListener('click', generateTerrain);
els.downloadBtn.addEventListener('click', downloadStl);
els.resetViewBtn.addEventListener('click', resetCamera);
window.addEventListener('resize', resizePreview);

function lv95FromLonLat(lon, lat) {
  return proj4('EPSG:4326', 'EPSG:2056', [lon, lat]);
}

function projectedExtent(bounds) {
  const corners = [
    [bounds.getWest(), bounds.getSouth()], [bounds.getEast(), bounds.getSouth()],
    [bounds.getEast(), bounds.getNorth()], [bounds.getWest(), bounds.getNorth()]
  ].map(([lon,lat]) => lv95FromLonLat(lon,lat));
  return {
    minX: Math.min(...corners.map(p => p[0])), maxX: Math.max(...corners.map(p => p[0])),
    minY: Math.min(...corners.map(p => p[1])), maxY: Math.max(...corners.map(p => p[1]))
  };
}

function modelDimensions() {
  if (!selectedBounds) return null;
  const ext = projectedExtent(selectedBounds);
  const groundW = ext.maxX - ext.minX;
  const groundH = ext.maxY - ext.minY;
  const widthMm = Math.max(1, Number(els.modelWidth.value) || 220);
  const depthMm = widthMm * groundH / groundW;
  return { ...ext, groundW, groundH, widthMm, depthMm, mmPerMeter: widthMm / groundW };
}

function updateSelectionUI() {
  if (!selectedBounds) return;
  const d = modelDimensions();
  const areaKm2 = d.groundW * d.groundH / 1e6;
  els.selectionInfo.textContent = `${(d.groundW/1000).toFixed(2)} × ${(d.groundH/1000).toFixed(2)} km · ca. ${areaKm2.toFixed(1)} km²`;
  els.generateBtn.disabled = false;
  updateMetrics();
}

function updateMetrics() {
  const rows = els.metrics.querySelectorAll('b');
  if (!selectedBounds) { rows.forEach(x => x.textContent = '–'); return; }
  const d = modelDimensions();
  const maxN = Number(els.gridSize.value);
  const cols = d.groundW >= d.groundH ? maxN : Math.max(2, Math.round(maxN * d.groundW / d.groundH));
  const rowsN = d.groundH >= d.groundW ? maxN : Math.max(2, Math.round(maxN * d.groundH / d.groundW));
  const spacing = d.widthMm / Math.max(1, cols - 1);
  const tri = 2 * (cols - 1) * (rowsN - 1) + 2 * ((cols - 1) + (rowsN - 1)) + 2;
  rows[0].textContent = `${d.widthMm.toFixed(0)} × ${d.depthMm.toFixed(1)} mm`;
  rows[1].textContent = `1 : ${Math.round(d.groundW * 1000 / d.widthMm).toLocaleString('de-CH')}`;
  rows[2].textContent = `${spacing.toFixed(3)} mm`;
  rows[3].textContent = `${(tri/1e6).toFixed(2)} Mio.`;
}

function setStatus(text, pct = null) {
  els.statusText.textContent = text;
  if (pct == null) { els.statusPct.textContent = ''; return; }
  const v = Math.max(0, Math.min(100, pct));
  els.progress.value = v;
  els.statusPct.textContent = `${Math.round(v)} %`;
}

function debug(text) {
  els.debug.textContent += `${text}\n`;
  els.debug.scrollTop = els.debug.scrollHeight;
}

function stacBbox(bounds) {
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map(v => v.toFixed(8)).join(',');
}

async function fetchStacItems(bounds) {
  let url = `${STAC_ITEMS}?bbox=${encodeURIComponent(stacBbox(bounds))}&limit=100`;
  const all = [];
  let page = 0;
  while (url && page < MAX_STAC_PAGES) {
    page++;
    setStatus(`STAC-Katalog abfragen · Seite ${page}`, Math.min(12, page));
    const r = await fetchWithRetry(url, { cache: 'no-cache' });
    const json = await r.json();
    all.push(...(json.features || []));
    if (all.length > 12000) throw new Error('Zu viele STAC-Einträge. Bitte einen kleineren Ausschnitt wählen.');
    const next = (json.links || []).find(l => l.rel === 'next');
    url = next?.href ? new URL(next.href, STAC_ITEMS).href : null;
  }
  if (page >= MAX_STAC_PAGES && url) throw new Error('Sehr grosser Ausschnitt: STAC-Seitenlimit erreicht. Bitte Gebiet verkleinern.');
  return all;
}

function tileKey(item) {
  const m = String(item.id || '').match(/(\d{4}-\d{4})$/);
  if (m) return m[1];
  const b = item.bbox || [];
  return b.length >= 4 ? b.map(v => Number(v).toFixed(5)).join('/') : item.id;
}

function itemYear(item) {
  const dt = item.properties?.datetime || item.properties?.start_datetime || '';
  const y = Number(String(dt).slice(0,4));
  if (Number.isFinite(y)) return y;
  const m = String(item.id || '').match(/_(\d{4})_/);
  return m ? Number(m[1]) : 0;
}

function findGeoTiffAsset(item, resolution) {
  const assets = Object.values(item.assets || {});
  const candidates = assets.filter(a => {
    const href = String(a.href || '');
    const type = String(a.type || '').toLowerCase();
    const gsd = Number(a['eo:gsd']);
    const isTif = /\.tiff?(?:$|\?)/i.test(href) || type.includes('geotiff') || type.includes('image/tiff');
    return isTif && Math.abs(gsd - resolution) < 1e-9;
  });
  if (candidates.length) return candidates[0];
  // Fallback for older metadata where eo:gsd may be absent.
  const token = resolution === 0.5 ? '_0.5_' : '_2_';
  return assets.find(a => /\.tiff?(?:$|\?)/i.test(String(a.href || '')) && String(a.href).includes(token)) || null;
}

function groupTileCandidates(items) {
  const groups = new Map();
  for (const item of items) {
    const key = tileKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const arr of groups.values()) arr.sort((a, b) => itemYear(b) - itemYear(a));
  return groups;
}

function makeTilePlans(items, preferredResolution) {
  const groups = groupTileCandidates(items);
  const fallbackResolution = preferredResolution === 0.5 ? 2 : 0.5;
  const plans = [];
  for (const [key, versions] of groups) {
    const candidates = [];
    // First try newest versions in the requested/automatic resolution.
    for (const item of versions) {
      const asset = findGeoTiffAsset(item, preferredResolution);
      if (asset) candidates.push({ item, asset, resolution: preferredResolution });
    }
    // If that fails, prefer 2 m as a compact and very robust fallback.
    // For a forced 2 m request we only add 0.5 m after all 2 m versions.
    for (const item of versions) {
      const asset = findGeoTiffAsset(item, fallbackResolution);
      if (asset) candidates.push({ item, asset, resolution: fallbackResolution });
    }
    if (candidates.length) plans.push({ key, candidates });
  }
  return plans;
}

function chooseAutomaticResolution(d, grid) {
  const sx = d.groundW / Math.max(1, grid.cols - 1);
  const sy = d.groundH / Math.max(1, grid.rows - 1);
  const meshGroundSpacing = Math.max(sx, sy);
  // 2 m source is still comfortably finer than a mesh with >= 4 m spacing.
  // This reduces a typical tile from ~26 MB to ~1 MB without reducing STL detail.
  return meshGroundSpacing >= 4 ? 2 : 0.5;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchWithRetry(url, options = {}, retries = REQUEST_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, options);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < retries) await sleep(RETRY_BASE_MS * (2 ** attempt));
    }
  }
  throw lastErr || new Error('Download fehlgeschlagen');
}

function outputGrid(d) {
  const maxN = Number(els.gridSize.value);
  let cols, rows;
  if (d.groundW >= d.groundH) {
    cols = maxN;
    rows = Math.max(2, Math.round(maxN * d.groundH / d.groundW));
  } else {
    rows = maxN;
    cols = Math.max(2, Math.round(maxN * d.groundW / d.groundH));
  }
  return { cols, rows, values: new Float32Array(cols * rows).fill(NaN) };
}

function indexRangeForTile(tileBox, d, grid) {
  const overlap = {
    minX: Math.max(tileBox[0], d.minX), minY: Math.max(tileBox[1], d.minY),
    maxX: Math.min(tileBox[2], d.maxX), maxY: Math.min(tileBox[3], d.maxY)
  };
  if (overlap.maxX <= overlap.minX || overlap.maxY <= overlap.minY) return null;
  const fx = (x) => (x - d.minX) / d.groundW * (grid.cols - 1);
  // Output row 0 represents north/maxY.
  const fy = (y) => (d.maxY - y) / d.groundH * (grid.rows - 1);
  const c0 = Math.max(0, Math.floor(fx(overlap.minX)));
  const c1 = Math.min(grid.cols - 1, Math.ceil(fx(overlap.maxX)));
  const r0 = Math.max(0, Math.floor(fy(overlap.maxY)));
  const r1 = Math.min(grid.rows - 1, Math.ceil(fy(overlap.minY)));
  return { c0, c1, r0, r1 };
}

async function sampleTile(url, d, grid, resolution = 2) {
  let tiff;
  // 2 m COGs are only about 1 MB/tile. One complete request is both faster and
  // more reliable than many HTTP range requests. 0.5 m COGs are ~26 MB/tile,
  // so they continue to use range access.
  if (resolution >= 2) {
    const response = await fetchWithRetry(url, { cache: 'force-cache' });
    const buffer = await response.arrayBuffer();
    tiff = await GeoTIFF.fromArrayBuffer(buffer);
  } else {
    let lastErr;
    for (let attempt = 0; attempt < REQUEST_RETRIES; attempt++) {
      try {
        tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false, cacheSize: 64 * 1024 * 1024 });
        break;
      } catch (err) {
        lastErr = err;
        if (attempt + 1 < REQUEST_RETRIES) await sleep(RETRY_BASE_MS * (2 ** attempt));
      }
    }
    if (!tiff) throw lastErr || new Error('GeoTIFF konnte nicht geöffnet werden');
  }

  try {
    const image = await tiff.getImage();
    const box = image.getBoundingBox(); // [minX,minY,maxX,maxY]
    const ir = indexRangeForTile(box, d, grid);
    if (!ir) return 0;

    const imgW = image.getWidth(), imgH = image.getHeight();
    const resX = (box[2] - box[0]) / imgW;
    const resY = (box[3] - box[1]) / imgH;

    const xMin = d.minX + ir.c0 / (grid.cols - 1) * d.groundW;
    const xMax = d.minX + ir.c1 / (grid.cols - 1) * d.groundW;
    const yMax = d.maxY - ir.r0 / (grid.rows - 1) * d.groundH;
    const yMin = d.maxY - ir.r1 / (grid.rows - 1) * d.groundH;

    const wx0 = Math.max(0, Math.floor((xMin - box[0]) / resX));
    const wx1 = Math.min(imgW, Math.ceil((xMax - box[0]) / resX) + 1);
    const wy0 = Math.max(0, Math.floor((box[3] - yMax) / resY));
    const wy1 = Math.min(imgH, Math.ceil((box[3] - yMin) / resY) + 1);
    if (wx1 <= wx0 || wy1 <= wy0) return 0;

    const outW = ir.c1 - ir.c0 + 1;
    const outH = ir.r1 - ir.r0 + 1;
    const data = await image.readRasters({
      window: [wx0, wy0, wx1, wy1], width: outW, height: outH,
      samples: [0], interleave: true, resampleMethod: 'bilinear'
    });
    const noDataRaw = image.getGDALNoData();
    const noData = noDataRaw == null ? null : Number(noDataRaw);
    let written = 0;
    for (let rr = 0; rr < outH; rr++) {
      for (let cc = 0; cc < outW; cc++) {
        const v = Number(data[rr * outW + cc]);
        if (!Number.isFinite(v) || (noData != null && Math.abs(v - noData) < 1e-6) || v < -1000) continue;
        grid.values[(ir.r0 + rr) * grid.cols + ir.c0 + cc] = v;
        written++;
      }
    }
    return written;
  } finally {
    if (typeof tiff?.close === 'function') tiff.close();
  }
}

async function loadTilePlan(plan, d, grid) {
  const errors = [];
  for (const candidate of plan.candidates) {
    try {
      const written = await sampleTile(candidate.asset.href, d, grid, candidate.resolution);
      if (written > 0) return { written, candidate, errors };
      errors.push(`${candidate.item.id} (${candidate.resolution} m): kein Überlappungsbereich`);
    } catch (err) {
      errors.push(`${candidate.item.id} (${candidate.resolution} m): ${err.message}`);
    }
  }
  return { written: 0, candidate: null, errors };
}

async function loadPlansConcurrent(plans, d, grid, progressCb) {
  let next = 0, done = 0, totalWritten = 0;
  const failed = [];
  const fallbackUsed = [];

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= plans.length) return;
      const plan = plans[i];
      const result = await loadTilePlan(plan, d, grid);
      totalWritten += result.written;
      if (!result.candidate) failed.push({ plan, errors: result.errors });
      else if (result.candidate !== plan.candidates[0]) fallbackUsed.push(result.candidate);
      done++;
      progressCb(done, plans.length);
      if (done % 12 === 0) await sleep(0);
    }
  }

  const workers = Array.from({ length: Math.min(TILE_CONCURRENCY, plans.length) }, () => worker());
  await Promise.all(workers);
  return { totalWritten, failed, fallbackUsed };
}

function fillSmallGaps(grid, passes = 12) {
  const { cols, rows } = grid;
  let src = grid.values;
  let totalChanged = 0;
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    const dst = new Float32Array(src);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (Number.isFinite(src[i])) continue;
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const v = src[rr * cols + cc];
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      if (n >= 4) { dst[i] = sum / n; changed++; }
    }
    src = dst;
    totalChanged += changed;
    if (!changed) break;
  }
  grid.values = src;
  return totalChanged;
}

function terrainStats(grid) {
  let min = Infinity, max = -Infinity, missing = 0;
  for (const v of grid.values) {
    if (!Number.isFinite(v)) { missing++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, missing, total: grid.values.length };
}

async function generateTerrain() {
  if (!selectedBounds) return;
  els.generateBtn.disabled = true;
  els.downloadBtn.disabled = true;
  els.debug.textContent = '';
  els.resultInfo.textContent = '';
  lastStlBlob = null;
  try {
    const d = modelDimensions();
    if (d.groundW > 80000 || d.groundH > 80000) throw new Error('Version 1 ist auf Ausschnitte bis etwa 80 × 80 km begrenzt. Bitte ein kleineres Gebiet wählen.');

    const grid = outputGrid(d);
    const sourceSetting = els.sourceResolution.value;
    const sourceRes = sourceSetting === 'auto' ? chooseAutomaticResolution(d, grid) : Number(sourceSetting);
    const meshSpacingM = Math.max(d.groundW / Math.max(1, grid.cols - 1), d.groundH / Math.max(1, grid.rows - 1));

    debug(`STAC: ${STAC_ITEMS}`);
    debug(`BBOX: ${stacBbox(selectedBounds)}`);
    debug(`Mesh-Bodenabstand: ${meshSpacingM.toFixed(2)} m · gewählte Quelle: ${sourceRes} m${sourceSetting === 'auto' ? ' (automatisch)' : ''}`);
    const items = await fetchStacItems(selectedBounds);
    debug(`${items.length} STAC-Items gefunden.`);
    const plans = makeTilePlans(items, sourceRes);
    debug(`${plans.length} räumliche 1-km-Kacheln geplant; Fallback-Jahrgänge und Alternativauflösung verfügbar.`);
    if (!plans.length) throw new Error(`Keine swissALTI³D-GeoTIFFs für diesen Ausschnitt gefunden.`);
    if (plans.length > MAX_TILES) throw new Error(`${plans.length} Kacheln wären nötig. Bitte einen kleineren Ausschnitt wählen.`);

    const loadResult = await loadPlansConcurrent(plans, d, grid, (done, total) => {
      const pct = 12 + 68 * (done / total);
      setStatus(`Höhendaten ${done}/${total} · ${TILE_CONCURRENCY} parallele Downloads`, pct);
    });
    if (loadResult.fallbackUsed.length) debug(`${loadResult.fallbackUsed.length} Kacheln erfolgreich über Fallback geladen.`);
    if (loadResult.failed.length) {
      debug(`${loadResult.failed.length} Kacheln nach allen Versuchen nicht geladen:`);
      for (const f of loadResult.failed.slice(0, 30)) debug(`  ${f.plan.key}: ${f.errors.slice(-2).join(' | ')}`);
      if (loadResult.failed.length > 30) debug(`  … ${loadResult.failed.length - 30} weitere`);
    }

    setStatus('Raster prüfen und Restlücken interpolieren', 82);
    let filled = 0;
    if (els.smoothMissing.checked) filled = fillSmallGaps(grid);
    const stats = terrainStats(grid);
    const missingPct = stats.missing / stats.total * 100;
    debug(`Raster: ${grid.cols} × ${grid.rows}; geschrieben: ${loadResult.totalWritten}; interpoliert: ${filled}; Restlücken: ${missingPct.toFixed(4)} %`);
    if (!Number.isFinite(stats.min)) throw new Error('Keine gültigen Höhenwerte geladen.');
    // Critical invariant: never export a terrain with NaN / missing elevations.
    // A failed generation is preferable to a rectangular crater in the print.
    if (stats.missing > 0) {
      throw new Error(`Relief nicht erzeugt: ${stats.missing.toLocaleString('de-CH')} Höhenpunkte (${missingPct.toFixed(3)} %) fehlen noch. Es wird bewusst KEINE fehlerhafte STL mit Löchern erzeugt. Bitte erneut versuchen; die App nutzt automatisch Fallback-Kacheln.`);
    }

    terrain = { grid, dims: d, stats };
    setStatus('3D-Vorschau erzeugen', 88);
    renderTerrainPreview(terrain);
    await new Promise(r => setTimeout(r, 20));

    setStatus('STL vorbereiten', 93);
    lastStlBlob = buildBinaryStl(terrain);
    const stlMb = lastStlBlob.size / 1024 / 1024;
    const elevRange = stats.max - stats.min;
    const modelReliefHeight = elevRange * d.mmPerMeter * Number(els.zExaggeration.value);
    els.resultInfo.textContent = `Höhen: ${stats.min.toFixed(1)}–${stats.max.toFixed(1)} m · Reliefhöhe: ${modelReliefHeight.toFixed(1)} mm + Basis · STL: ${stlMb.toFixed(1)} MB`;
    els.downloadBtn.disabled = false;
    setStatus('Fertig', 100);
  } catch (err) {
    console.error(err);
    setStatus('Fehler', 0);
    els.statusText.textContent = err.message || String(err);
    debug(err.stack || String(err));
  } finally {
    els.generateBtn.disabled = !selectedBounds;
  }
}

function zMm(elev, terrainObj) {
  const base = Number(els.baseThickness.value);
  const exag = Number(els.zExaggeration.value);
  return base + (elev - terrainObj.stats.min) * terrainObj.dims.mmPerMeter * exag;
}

function buildBinaryStl(t) {
  const { cols, rows, values } = t.grid;
  const w = t.dims.widthMm, h = t.dims.depthMm;
  const topTriangles = 2 * (cols - 1) * (rows - 1);
  // Two walls per axis side, two triangles per wall segment = 4× perimeter segments.
  const sideTriangles = 4 * ((cols - 1) + (rows - 1));
  const triCount = topTriangles + sideTriangles + 2;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode('Swiss Relief STL Generator · swissALTI3D · swisstopo');
  new Uint8Array(buffer, 0, Math.min(80, header.length)).set(header.slice(0,80));
  view.setUint32(80, triCount, true);
  let off = 84;

  const point = (r, c) => {
    const x = c / (cols - 1) * w - w/2;
    const y = h/2 - r / (rows - 1) * h;
    const z = zMm(values[r * cols + c], t);
    return [x,y,z];
  };
  const bottom = (r,c) => {
    const p = point(r,c); p[2] = 0; return p;
  };
  const tri = (a,b,c) => {
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const len=Math.hypot(nx,ny,nz)||1; nx/=len; ny/=len; nz/=len;
    for (const n of [nx,ny,nz]) { view.setFloat32(off,n,true); off+=4; }
    for (const p of [a,b,c]) for (const n of p) { view.setFloat32(off,n,true); off+=4; }
    view.setUint16(off,0,true); off+=2;
  };

  // Top surface, counter-clockwise when viewed from above.
  for (let r=0;r<rows-1;r++) for (let c=0;c<cols-1;c++) {
    const p00=point(r,c), p10=point(r,c+1), p01=point(r+1,c), p11=point(r+1,c+1);
    tri(p00,p01,p10); tri(p10,p01,p11);
  }
  // North and south walls.
  for (let c=0;c<cols-1;c++) {
    let a=point(0,c), b=point(0,c+1), ba=bottom(0,c), bb=bottom(0,c+1);
    tri(a,b,ba); tri(b,bb,ba);
    a=point(rows-1,c); b=point(rows-1,c+1); ba=bottom(rows-1,c); bb=bottom(rows-1,c+1);
    tri(a,ba,b); tri(b,ba,bb);
  }
  // West and east walls.
  for (let r=0;r<rows-1;r++) {
    let a=point(r,0), b=point(r+1,0), ba=bottom(r,0), bb=bottom(r+1,0);
    tri(a,ba,b); tri(b,ba,bb);
    a=point(r,cols-1); b=point(r+1,cols-1); ba=bottom(r,cols-1); bb=bottom(r+1,cols-1);
    tri(a,b,ba); tri(b,bb,ba);
  }
  // Flat bottom: 2 triangles only.
  const sw=[-w/2,-h/2,0], se=[w/2,-h/2,0], nw=[-w/2,h/2,0], ne=[w/2,h/2,0];
  tri(sw,nw,se); tri(se,nw,ne);

  return new Blob([buffer], {type:'model/stl'});
}

function fileName() {
  const d = modelDimensions();
  return `swiss-relief_${(d.groundW/1000).toFixed(1)}x${(d.groundH/1000).toFixed(1)}km_${Math.round(d.widthMm)}mm.stl`.replace(/\./g,'-').replace('-stl','.stl');
}

function downloadStl() {
  if (!lastStlBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastStlBlob);
  a.download = fileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function initPreview() {
  if (renderer) return;
  els.preview.querySelector('.preview-placeholder')?.remove();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  els.preview.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .08;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.7));
  const light = new THREE.DirectionalLight(0xffffff, 2.2); light.position.set(-2,3,4); scene.add(light);
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera); };
  animate();
  resizePreview();
}

function clearPreview() {
  if (terrainGroup && scene) { scene.remove(terrainGroup); terrainGroup = null; }
  if (!renderer && !els.preview.querySelector('.preview-placeholder')) {
    const p=document.createElement('div'); p.className='preview-placeholder'; p.textContent='Nach dem Laden erscheint hier das Relief.'; els.preview.appendChild(p);
  }
}

function renderTerrainPreview(t) {
  initPreview();
  if (terrainGroup) scene.remove(terrainGroup);
  terrainGroup = new THREE.Group();
  const src = t.grid;
  const maxPreview = 260;
  const step = Math.max(1, Math.ceil(Math.max(src.cols, src.rows) / maxPreview));
  const cols = Math.floor((src.cols-1)/step)+1;
  const rows = Math.floor((src.rows-1)/step)+1;
  const pos = new Float32Array(cols*rows*3);
  let k=0;
  for (let r=0;r<rows;r++) {
    const sr=Math.min(src.rows-1,r*step);
    for (let c=0;c<cols;c++) {
      const sc=Math.min(src.cols-1,c*step);
      pos[k++]=sc/(src.cols-1)*t.dims.widthMm-t.dims.widthMm/2;
      pos[k++]=t.dims.depthMm/2-sr/(src.rows-1)*t.dims.depthMm;
      pos[k++]=zMm(src.values[sr*src.cols+sc],t);
    }
  }
  const idx=[];
  for(let r=0;r<rows-1;r++) for(let c=0;c<cols-1;c++){
    const a=r*cols+c,b=a+1,d=(r+1)*cols+c,e=d+1;
    idx.push(a,d,b,b,d,e);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setIndex(idx); g.computeVertexNormals();
  const m=new THREE.MeshStandardMaterial({color:0xc8c2b7,roughness:.88,metalness:0,side:THREE.DoubleSide});
  terrainGroup.add(new THREE.Mesh(g,m));

  const baseT=Number(els.baseThickness.value);
  const baseGeo=new THREE.BoxGeometry(t.dims.widthMm,t.dims.depthMm,baseT);
  const baseMesh=new THREE.Mesh(baseGeo,new THREE.MeshStandardMaterial({color:0x88837b,roughness:1}));
  baseMesh.position.z=baseT/2; terrainGroup.add(baseMesh);
  scene.add(terrainGroup);
  resetCamera();
}

function resetCamera() {
  if (!camera || !terrain) return;
  const size=Math.max(terrain.dims.widthMm,terrain.dims.depthMm);
  const relief=(terrain.stats.max-terrain.stats.min)*terrain.dims.mmPerMeter*Number(els.zExaggeration.value)+Number(els.baseThickness.value);
  camera.position.set(size*.72,-size*.92,Math.max(size*.70,relief*3));
  controls.target.set(0,0,Math.min(relief/3,size*.15));
  controls.update();
}

function resizePreview() {
  if (!renderer || !camera) return;
  const w=els.preview.clientWidth,h=els.preview.clientHeight;
  renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix();
}

updateMetrics();
