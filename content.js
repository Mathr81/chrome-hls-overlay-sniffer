/* ============================================================
   HLS Sniffer Pro — Content script
   - Echantillonne le <video> (bitrate décodé, FPS, buffer, frames perdues)
   - Dessine l'overlay "stats for nerds" + graphe de bitrate
   ============================================================ */

let overlay = null;
let currentStreams = [];
let lastVideoStats = null;
let lastNetStats = null;
let bitrateHistory = [];            // [{ t, bps }] sur 60 s
let sampleTimer = null;
const HISTORY_MS = 60000;
const SAMPLE_MS = 1000;

const ICON_COPY = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const ICON_TERMINAL = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;
const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

/* ------------------------------------------------------------
   Formatage
   ------------------------------------------------------------ */

function formatBitrate(bps) {
  if (!bps || bps <= 0) return '--';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mb/s`;
  return `${Math.round(bps / 1e3)} kb/s`;
}

function splitBitrate(bps) {
  if (!bps || bps <= 0) return { value: '--', unit: '' };
  if (bps >= 1e6) return { value: (bps / 1e6).toFixed(2), unit: 'Mb/s' };
  return { value: String(Math.round(bps / 1e3)), unit: 'kb/s' };
}

function formatBytes(bytes) {
  if (!bytes) return '--';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.round(bytes / 1024)} Ko`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
               : `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------
   Echantillonnage du <video>
   ------------------------------------------------------------ */

let sampler = { el: null, t: 0, vBytes: null, aBytes: null, frames: null, videoBps: 0, audioBps: 0, fps: 0 };

function pickVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (!videos.length) return null;
  // Priorité : vidéo en lecture, puis la plus grande
  let best = null, bestScore = -1;
  for (const v of videos) {
    const area = (v.videoWidth || 0) * (v.videoHeight || 0);
    const score = area + (!v.paused && !v.ended ? 1e9 : 0);
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

function bufferAhead(v) {
  try {
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.25 && v.currentTime <= v.buffered.end(i)) {
        return v.buffered.end(i) - v.currentTime;
      }
    }
  } catch (e) { /* noop */ }
  return 0;
}

function collectVideoStats() {
  const v = pickVideo();
  if (!v) return null;

  const now = performance.now();
  const playing = !v.paused && !v.ended && v.readyState >= 2;

  // Compteurs Blink : octets réellement décodés depuis le début de la lecture.
  // C'est la mesure la plus fidèle du bitrate du média (indépendante du réseau).
  const vBytes = typeof v.webkitVideoDecodedByteCount === 'number' ? v.webkitVideoDecodedByteCount : null;
  const aBytes = typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null;

  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  const totalFrames = q ? q.totalVideoFrames : null;
  const droppedFrames = q ? q.droppedVideoFrames : null;

  if (sampler.el !== v) {
    sampler = { el: v, t: now, vBytes, aBytes, frames: totalFrames, videoBps: 0, audioBps: 0, fps: 0 };
  } else {
    const dt = (now - sampler.t) / 1000;
    if (dt >= 0.3) {
      // Lissage exponentiel léger : les compteurs avancent par paliers (segments).
      const ema = (prev, next) => (prev > 0 ? prev * 0.55 + next * 0.45 : next);

      if (vBytes !== null && sampler.vBytes !== null) {
        const d = vBytes - sampler.vBytes;
        sampler.videoBps = d >= 0 ? ema(sampler.videoBps, (d * 8) / dt) : 0;
      }
      if (aBytes !== null && sampler.aBytes !== null) {
        const d = aBytes - sampler.aBytes;
        sampler.audioBps = d >= 0 ? ema(sampler.audioBps, (d * 8) / dt) : 0;
      }
      if (totalFrames !== null && sampler.frames !== null) {
        const d = totalFrames - sampler.frames;
        sampler.fps = d >= 0 ? ema(sampler.fps, d / dt) : 0;
      }
      sampler.t = now;
      sampler.vBytes = vBytes;
      sampler.aBytes = aBytes;
      sampler.frames = totalFrames;
    }
  }

  if (!playing) { sampler.videoBps = 0; sampler.audioBps = 0; sampler.fps = 0; }

  const hasDecodedCounters = vBytes !== null;

  return {
    width: v.videoWidth,
    height: v.videoHeight,
    playing,
    videoBps: hasDecodedCounters ? Math.round(sampler.videoBps) : null,
    audioBps: aBytes !== null ? Math.round(sampler.audioBps) : null,
    fps: sampler.fps > 0 ? Math.round(sampler.fps * 10) / 10 : null,
    droppedFrames,
    totalFrames,
    buffer: Math.round(bufferAhead(v) * 10) / 10,
    currentTime: v.currentTime,
    duration: Number.isFinite(v.duration) ? v.duration : null,
    muted: v.muted,
    ts: Date.now()
  };
}

// Partagé avec le popup : chrome.scripting.executeScript s'exécute dans le
// même monde isolé que ce content script, il peut donc réutiliser le sampler.
window.__hlsSnifferGetStats = () => collectVideoStats();

/* ------------------------------------------------------------
   Accès à l'API chrome (résistant au rechargement de l'extension)
   ------------------------------------------------------------ */

// Recharger / mettre à jour / désactiver l'extension laisse les anciens content
// scripts vivants dans la page, avec un chrome.runtime mort. Sans garde, le
// timer d'échantillonnage lève « Extension context invalidated » chaque seconde.
function contextAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

let torn = false;

function teardown() {
  if (torn) return;
  torn = true;
  clearInterval(sampleTimer);
  ['play', 'playing', 'loadedmetadata', 'resize'].forEach((evt) =>
    document.removeEventListener(evt, reportVideoStats, true)
  );
  // L'overlay orphelin afficherait des chiffres figés : mieux vaut le retirer,
  // la page doit être rechargée pour retrouver un content script vivant.
  const el = document.getElementById('hls-stats-overlay');
  if (el) el.remove();
  overlay = null;
}

// Le contexte peut aussi mourir entre l'envoi et la réponse : lire lastError
// depuis le callback lèverait à son tour, d'où le try/catch interne.
function guardedCallback(callback) {
  return (res) => {
    try {
      if (chrome.runtime.lastError) return; // récepteur absent : sans conséquence
      if (callback) callback(res);
    } catch (e) {
      teardown();
    }
  };
}

function sendMessage(payload, callback) {
  if (!contextAlive()) { teardown(); return; }
  try {
    chrome.runtime.sendMessage(payload, guardedCallback(callback));
  } catch (e) {
    teardown();
  }
}

function storageGet(keys, callback) {
  if (!contextAlive()) { teardown(); return; }
  try {
    chrome.storage.local.get(keys, guardedCallback(callback));
  } catch (e) {
    teardown();
  }
}

function storageSet(items) {
  if (!contextAlive()) { teardown(); return; }
  try {
    chrome.storage.local.set(items, guardedCallback(null));
  } catch (e) {
    teardown();
  }
}

function reportVideoStats() {
  const stats = collectVideoStats();
  if (!stats) return;
  sendMessage({ action: 'reportVideoStats', stats }, (res) => {
    if (!res) return;
    // Le frame porteur de l'overlay récupère aussi le débit réseau de l'onglet
    if (res.net) lastNetStats = res.net;
    if (res.videoStats) lastVideoStats = res.videoStats;
    if (isOverlayVisible()) { pushHistory(); updateStatsUI(); }
  });
}

sampleTimer = setInterval(reportVideoStats, SAMPLE_MS);
['play', 'playing', 'loadedmetadata', 'resize'].forEach((evt) =>
  document.addEventListener(evt, reportVideoStats, true)
);

/* ------------------------------------------------------------
   Bitrate consolidé + historique
   ------------------------------------------------------------ */

function playbackBps() {
  const s = lastVideoStats;
  // Les compteurs du décodeur font foi dès qu'ils existent, même à 0 (pause) :
  // alterner avec le débit réseau ferait osciller l'affichage entre deux mesures.
  if (s && s.videoBps !== null && s.videoBps !== undefined) {
    return s.videoBps + (s.audioBps || 0);
  }
  // Pas de compteurs décodeur (EME/DRM, MSE exotique) : on retombe sur le réseau
  return lastNetStats ? lastNetStats.bps : 0;
}

function pushHistory() {
  const now = Date.now();
  const bps = playbackBps();
  if (bitrateHistory.length && now - bitrateHistory[bitrateHistory.length - 1].t < 400) return;
  bitrateHistory.push({ t: now, bps });
  const cutoff = now - HISTORY_MS;
  while (bitrateHistory.length && bitrateHistory[0].t < cutoff) bitrateHistory.shift();
}

/* ------------------------------------------------------------
   Overlay
   ------------------------------------------------------------ */

function isOverlayVisible() {
  const el = document.getElementById('hls-stats-overlay');
  return !!el && el.style.display !== 'none';
}

function createOverlay() {
  if (document.getElementById('hls-stats-overlay')) return;

  // Overlay dans le frame principal, ou dans le frame plein écran
  if (window.self !== window.top && !document.fullscreenElement && !document.webkitFullscreenElement) {
    return;
  }

  const div = document.createElement('div');
  div.id = 'hls-stats-overlay';
  div.innerHTML = `
    <div id="hls-stats-header">
      <span>⚡ HLS MONITOR PRO</span>
      <span class="hls-hdr-actions">
        <span id="hls-collapse-btn" title="Réduire / agrandir">–</span>
        <span id="hls-close-btn" title="Fermer">&times;</span>
      </span>
    </div>
    <div id="hls-stats-content">

      <div class="hls-hero">
        <div class="hls-label">Bitrate lu (vidéo + audio)</div>
        <div class="hls-hero-row">
          <span class="hls-hero-value" id="hls-bitrate-val">--</span>
          <span class="hls-hero-unit" id="hls-bitrate-unit"></span>
        </div>
        <canvas id="hls-graph"></canvas>
        <div class="hls-graph-axis">
          <span id="hls-graph-max">--</span>
          <span>60 s</span>
        </div>
      </div>

      <div class="hls-grid">
        <div><div class="hls-label">Rendu</div><div class="hls-value" id="hls-source-val">--</div></div>
        <div><div class="hls-label">Écran (Phy)</div><div class="hls-value" id="hls-screen-val">--</div></div>
        <div><div class="hls-label">FPS</div><div class="hls-value" id="hls-fps-val">--</div></div>
        <div><div class="hls-label">Buffer</div><div class="hls-value" id="hls-buffer-val">--</div></div>
      </div>

      <div class="hls-kv-list">
        <div class="hls-kv"><span>Débit réseau</span><b id="hls-net-val">--</b></div>
        <div class="hls-kv"><span>Vidéo / Audio</span><b id="hls-av-val">--</b></div>
        <div class="hls-kv"><span>Déclaré (variante)</span><b id="hls-declared-val">--</b></div>
        <div class="hls-kv"><span>Codecs</span><b id="hls-codec-val">--</b></div>
        <div class="hls-kv"><span>Images perdues</span><b id="hls-drop-val">--</b></div>
        <div class="hls-kv"><span>Téléchargé</span><b id="hls-total-val">--</b></div>
      </div>

      <hr class="hls-separator">

      <div class="hls-section-title">LECTURE EN COURS 🟢</div>
      <div id="hls-active-stream" class="hls-empty">Aucun flux actif</div>

      <div class="hls-section-title" style="margin-top:10px; opacity:0.7">HISTORIQUE <span id="hls-hist-count">(0)</span></div>
      <div id="hls-history-list" style="display:none;"></div>
      <button id="hls-toggle-history">Voir l'historique</button>
    </div>
  `;

  injectOverlay(div);
  overlay = div;
  setupDrag(div);
  restorePosition(div);

  div.querySelector('#hls-close-btn').onclick = () => {
    setVisible(false);
    sendMessage({ action: 'setOverlayVisible', visible: false });
  };

  div.querySelector('#hls-collapse-btn').onclick = () => {
    const collapsed = div.classList.toggle('hls-collapsed');
    div.querySelector('#hls-collapse-btn').innerText = collapsed ? '+' : '–';
    storageSet({ hls_overlay_collapsed: collapsed });
  };

  div.querySelector('#hls-toggle-history').onclick = () => {
    const list = div.querySelector('#hls-history-list');
    const btn = div.querySelector('#hls-toggle-history');
    const show = list.style.display === 'none';
    list.style.display = show ? 'block' : 'none';
    btn.innerText = show ? "Masquer l'historique" : "Voir l'historique";
  };

  storageGet(['hls_overlay_collapsed'], (r) => {
    if (r.hls_overlay_collapsed) {
      div.classList.add('hls-collapsed');
      div.querySelector('#hls-collapse-btn').innerText = '+';
    }
  });
}

function injectOverlay(element) {
  const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsElement) {
    fsElement.appendChild(element);
  } else if (window.self === window.top) {
    document.body.appendChild(element);
  } else {
    // Sortie de plein écran dans une iframe : l'overlay n'a plus de conteneur
    // valide ici, c'est le frame principal qui reprend la main.
    element.remove();
    if (overlay === element) overlay = null;
  }
}

function restorePosition(div) {
  storageGet(['hls_overlay_pos'], (r) => {
    const pos = r.hls_overlay_pos;
    if (!pos) return;
    const left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - 120));
    const top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 60));
    div.style.left = `${left}px`;
    div.style.top = `${top}px`;
  });
}

function setVisible(visible) {
  if (!document.getElementById('hls-stats-overlay') && visible) createOverlay();
  const el = document.getElementById('hls-stats-overlay');
  if (!el) return;
  el.style.display = visible ? 'block' : 'none';
  if (visible) { pushHistory(); updateStatsUI(); }
}

function byId(id) {
  if (!overlay || !overlay.isConnected) overlay = document.getElementById('hls-stats-overlay');
  return overlay ? overlay.querySelector('#' + id) : null;
}

/* Retrouve la variante du manifest qui correspond à la résolution rendue */
function matchedLevel() {
  const stats = lastVideoStats;
  const stream = currentStreams.length ? currentStreams[currentStreams.length - 1] : null;
  if (!stats || !stream || !Array.isArray(stream.levels)) return null;

  const exact = stream.levels.find((l) => l.width === stats.width && l.height === stats.height);
  if (exact) return exact;
  return stream.levels.find((l) => l.height === stats.height) || null;
}

function updateStatsUI() {
  if (!byId('hls-bitrate-val')) return;

  const s = lastVideoStats;
  const net = lastNetStats;

  // --- Bitrate principal
  const bps = playbackBps();
  const { value, unit } = splitBitrate(bps);
  const bitrateEl = byId('hls-bitrate-val');
  if (bitrateEl) {
    bitrateEl.innerText = value;
    bitrateEl.style.color = bps >= 8e6 ? '#00E676' : bps >= 3e6 ? '#8BC34A' : bps > 0 ? '#FFC107' : '#666';
  }
  const unitEl = byId('hls-bitrate-unit');
  if (unitEl) unitEl.innerText = unit;

  // --- Résolutions
  const sourceVal = byId('hls-source-val');
  if (sourceVal) {
    if (s && s.width > 0) {
      sourceVal.innerText = `${s.width} x ${s.height}`;
      sourceVal.style.color = s.width >= 1900 ? '#00E676' : '#fff';
    } else {
      sourceVal.innerText = 'N/A';
      sourceVal.style.color = '#fff';
    }
  }

  const ratio = window.devicePixelRatio || 1;
  const screenVal = byId('hls-screen-val');
  if (screenVal) screenVal.innerText = `${Math.round(window.innerWidth * ratio)} x ${Math.round(window.innerHeight * ratio)}`;

  // --- FPS / buffer
  const level = matchedLevel();
  const fpsEl = byId('hls-fps-val');
  if (fpsEl) {
    if (s && s.fps) fpsEl.innerText = String(s.fps);
    else if (level && level.frameRate) fpsEl.innerText = `${level.frameRate} ⓘ`;
    else fpsEl.innerText = '--';
  }

  const bufEl = byId('hls-buffer-val');
  if (bufEl) {
    if (s && Number.isFinite(s.buffer)) {
      bufEl.innerText = `${s.buffer.toFixed(1)} s`;
      bufEl.style.color = s.buffer < 2 ? '#FF5252' : s.buffer < 6 ? '#FFC107' : '#fff';
    } else bufEl.innerText = '--';
  }

  // --- Détails
  setKV('hls-net-val', net && net.bps ? formatBitrate(net.bps) : '--');
  setKV('hls-av-val', s && s.videoBps !== null
    ? `${formatBitrate(s.videoBps)} / ${formatBitrate(s.audioBps)}`
    : 'compteurs indisponibles');
  setKV('hls-declared-val', level && (level.avgBandwidth || level.bandwidth)
    ? formatBitrate(level.avgBandwidth || level.bandwidth)
    : '--');
  setKV('hls-codec-val', level && level.codecLabel ? level.codecLabel : '--');

  if (s && s.totalFrames) {
    const pct = ((s.droppedFrames / s.totalFrames) * 100).toFixed(2);
    setKV('hls-drop-val', `${s.droppedFrames} (${pct}%)`);
    const el = byId('hls-drop-val');
    if (el) el.style.color = s.droppedFrames / s.totalFrames > 0.01 ? '#FF5252' : '#ccc';
  } else {
    setKV('hls-drop-val', '--');
  }

  setKV('hls-total-val', net && net.totalBytes ? formatBytes(net.totalBytes) : '--');

  drawGraph();
  renderStreams();
}

function setKV(id, text) {
  const el = byId(id);
  if (el) el.innerText = text;
}

/* ------------------------------------------------------------
   Graphe de bitrate
   ------------------------------------------------------------ */

function drawGraph() {
  const canvas = byId('hls-graph');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 260;
  const h = canvas.clientHeight || 44;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const maxEl = byId('hls-graph-max');
  if (bitrateHistory.length < 2) {
    if (maxEl) maxEl.innerText = '--';
    return;
  }

  const peak = Math.max(...bitrateHistory.map((p) => p.bps), 1);
  const scale = peak * 1.15;
  if (maxEl) maxEl.innerText = formatBitrate(peak);

  const now = Date.now();
  const x = (t) => w - ((now - t) / HISTORY_MS) * w;
  const y = (bps) => Math.min(h - 1, Math.max(1, h - (bps / scale) * (h - 3) - 1));

  // Lignes de repère
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const gy = Math.round((h / 3) * i) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
  }

  const line = new Path2D();
  bitrateHistory.forEach((p, i) => {
    const px = x(p.t), py = y(p.bps);
    if (i === 0) line.moveTo(px, py); else line.lineTo(px, py);
  });

  // Aire dégradée : même tracé, refermé sur la ligne de base
  const area = new Path2D(line);
  const last = bitrateHistory[bitrateHistory.length - 1];
  const first = bitrateHistory[0];
  area.lineTo(x(last.t), h);
  area.lineTo(x(first.t), h);
  area.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(0, 230, 118, 0.35)');
  grad.addColorStop(1, 'rgba(0, 230, 118, 0.02)');
  ctx.fillStyle = grad;
  ctx.fill(area);

  ctx.strokeStyle = '#00E676';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke(line);
}

/* ------------------------------------------------------------
   Cartes de flux
   ------------------------------------------------------------ */

function renderStreams() {
  const activeDiv = byId('hls-active-stream');
  const histDiv = byId('hls-history-list');
  const histCount = byId('hls-hist-count');
  if (!activeDiv || !currentStreams || currentStreams.length === 0) return;

  const streamsCopy = [...currentStreams];
  const activeStream = streamsCopy.pop();
  const historyStreams = streamsCopy.reverse();

  activeDiv.innerHTML = '';
  activeDiv.appendChild(createStreamCard(activeStream, true));

  histDiv.innerHTML = '';
  historyStreams.forEach((s) => histDiv.appendChild(createStreamCard(s, false)));
  if (histCount) histCount.innerText = `(${historyStreams.length})`;
}

function createStreamCard(stream, isActive) {
  const div = document.createElement('div');
  div.className = isActive ? 'hls-stream-card active' : 'hls-stream-card';

  const levels = Array.isArray(stream.levels) ? stream.levels : [];
  const active = isActive ? matchedLevel() : null;

  let badges = '';
  if (stream.features && stream.features.drm) badges += `<span class="hls-badge drm">🔒 DRM</span>`;
  else if (stream.features && stream.features.encrypted) badges += `<span class="hls-badge enc">🔑 AES-128</span>`;
  if (stream.live === true) badges += `<span class="hls-badge live">🔴 LIVE</span>`;
  if (stream.live === false && stream.duration) badges += `<span class="hls-badge vod">VOD ${formatDuration(stream.duration)}</span>`;
  if (stream.features && stream.features.audio) badges += `<span class="hls-badge audio">🔊 ${stream.audioTracks ? stream.audioTracks.length : ''} AUDIO</span>`;
  if (stream.features && stream.features.subtitles) badges += `<span class="hls-badge subs">💬 ST</span>`;

  let levelsHtml = '';
  levels.slice(0, 6).forEach((l) => {
    const isCurrent = active && l.uri === active.uri && l.resolution === active.resolution;
    const rate = l.bandwidth ? formatBitrate(l.avgBandwidth || l.bandwidth) : '';
    levelsHtml += `<div class="hls-level${isCurrent ? ' current' : ''}">
        <span class="hls-level-res">${isCurrent ? '▶ ' : ''}${l.resolution}${l.frameRate ? ` @${Math.round(l.frameRate)}` : ''}</span>
        <span class="hls-level-rate">${rate}</span>
      </div>`;
  });
  if (levels.length > 6) levelsHtml += `<div class="hls-level-more">+ ${levels.length - 6} autres variantes</div>`;

  // Poids estimé pour un VOD : durée × bitrate déclaré
  let estimate = '';
  const topLevel = levels.find((l) => l.bandwidth);
  if (stream.duration && topLevel && topLevel.bandwidth) {
    estimate = `<div class="hls-estimate">≈ ${formatBytes((stream.duration * topLevel.bandwidth) / 8)} au meilleur débit</div>`;
  }

  div.innerHTML = `
    <div class="hls-card-head">
      <div class="hls-card-title" style="color:${isActive ? '#fff' : '#aaa'}">
        ${isActive ? '🔴 SIGNAL EN DIRECT' : 'Flux archivé'}
      </div>
      <div class="hls-card-actions">
        <button class="hls-icon-btn copy-url" title="Copier l'URL du flux">${ICON_COPY}</button>
        <button class="hls-icon-btn copy-ffmpeg" title="Copier la commande FFmpeg">${ICON_TERMINAL}</button>
        <button class="hls-icon-btn copy-ytdlp" title="Copier la commande yt-dlp">${ICON_DOWNLOAD}</button>
      </div>
    </div>
    <div class="hls-url" title="${stream.url}">${stream.url.substring(0, 46)}${stream.url.length > 46 ? '…' : ''}</div>
    <div class="hls-badges">${badges}</div>
    <div class="hls-levels">${levelsHtml}</div>
    ${estimate}
  `;

  const referer = location.href;
  const ffmpegCmd = `ffmpeg -referer "${referer}" -i "${stream.url}" -c copy -bsf:a aac_adtstoasc output.mp4`;
  const ytdlpCmd = `yt-dlp --referer "${referer}" "${stream.url}" -o "video.mp4"`;

  div.querySelector('.copy-url').onclick = (e) => copy(stream.url, e.currentTarget);
  div.querySelector('.copy-ffmpeg').onclick = (e) => copy(ffmpegCmd, e.currentTarget);
  div.querySelector('.copy-ytdlp').onclick = (e) => copy(ytdlpCmd, e.currentTarget);

  return div;
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).catch(() => {});
  const original = btn.innerHTML;
  btn.innerHTML = '<span style="color:#00E676; font-size:9px;">OK</span>';
  setTimeout(() => { btn.innerHTML = original; }, 1000);
}

/* ------------------------------------------------------------
   Drag (avec mémorisation de la position)
   ------------------------------------------------------------ */

function setupDrag(elmnt) {
  const header = elmnt.querySelector('#hls-stats-header');
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  header.onmousedown = (e) => {
    if (e.target.closest('.hls-hdr-actions')) return;
    e.preventDefault(); e.stopPropagation();
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = elmnt.getBoundingClientRect();
    initialLeft = rect.left; initialTop = rect.top;
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    header.style.cursor = 'grabbing';
  };

  function onMouseMove(e) {
    if (!isDragging) return;
    elmnt.style.left = `${initialLeft + (e.clientX - startX)}px`;
    elmnt.style.top = `${initialTop + (e.clientY - startY)}px`;
  }

  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    header.style.cursor = 'grab';
    const rect = elmnt.getBoundingClientRect();
    storageSet({ hls_overlay_pos: { left: Math.round(rect.left), top: Math.round(rect.top) } });
  }
}

/* ------------------------------------------------------------
   Messages
   ------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'setVisibility') {
    if (request.streams) currentStreams = request.streams;
    if (request.videoStats) lastVideoStats = request.videoStats;
    if (request.net) lastNetStats = request.net;
    setVisible(request.visible);
  }

  if (request.action === 'updateStreams') {
    if (request.streams) {
      currentStreams = request.streams;
      if (isOverlayVisible()) renderStreams();
    }
  }

  if (request.action === 'updateStats') {
    if (request.videoStats) lastVideoStats = request.videoStats;
    if (request.net) lastNetStats = request.net;
    if (isOverlayVisible()) { pushHistory(); updateStatsUI(); }
  }
});

/* ------------------------------------------------------------
   Plein écran
   ------------------------------------------------------------ */

['fullscreenchange', 'webkitfullscreenchange'].forEach((evt) =>
  document.addEventListener(evt, () => {
    const el = document.getElementById('hls-stats-overlay');
    const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement);

    if (el) {
      injectOverlay(el);
      drawGraph();
    } else if (isFS) {
      sendMessage({ action: 'getOverlayState' }, (response) => {
        if (!response || !response.visible) return;
        if (response.videoStats) lastVideoStats = response.videoStats;
        if (response.net) lastNetStats = response.net;
        createOverlay();
        setVisible(true);
      });
    }
  })
);
