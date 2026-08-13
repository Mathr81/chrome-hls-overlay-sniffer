/* ============================================================
   HLS Sniffer Pro — Popup
   ============================================================ */

let currentTab = null;
let storageKey = null;
let latestStreams = [];
let latestStats = null;
let refreshTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  currentTab = tab;
  storageKey = tab.id.toString();

  document.getElementById('clear-btn').addEventListener('click', () => {
    chrome.storage.local.remove(storageKey, () => {
      chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {});
      latestStreams = [];
      displayStreams([]);
    });
  });

  document.getElementById('json-btn').addEventListener('click', (e) => {
    const payload = {
      page: tab.url,
      exportedAt: new Date().toISOString(),
      player: latestStats,
      streams: latestStreams
    };
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    flash(e.currentTarget, '✓ Copié');
  });

  // Lecteur ouvert dans une page d'extension (HLS Player, Native HLS…)
  if (tab.url && tab.url.startsWith('chrome-extension://')) {
    setText('player-status', 'Page d\'extension : lecture des stats restreinte.');
    if (tab.url.includes('#http')) {
      await fetchAndDisplayManual(tab.url.split('#')[1]);
      return;
    }
  }

  await refresh();
  refreshTimer = setInterval(refresh, 1000);
  window.addEventListener('unload', () => clearInterval(refreshTimer));
});

/* ------------------------------------------------------------
   Rafraîchissement
   ------------------------------------------------------------ */

async function refresh() {
  const [stats, net, stored] = await Promise.all([
    readPlayerStats(),
    readNetStats(),
    chrome.storage.local.get([storageKey])
  ]);

  latestStats = stats;
  latestStreams = stored[storageKey] || [];

  renderPlayer(stats, net);
  displayStreams(latestStreams);
}

// Le content script expose __hlsSnifferGetStats dans le même monde isolé :
// on récupère ainsi les deltas déjà lissés (bitrate décodé, FPS…).
async function readPlayerStats() {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: () => {
        if (typeof window.__hlsSnifferGetStats === 'function') return window.__hlsSnifferGetStats();
        const v = document.querySelector('video');
        return v && v.videoWidth > 0 ? { width: v.videoWidth, height: v.videoHeight, playing: !v.paused } : null;
      }
    });

    const found = results.map((r) => r.result).filter((r) => r && r.width > 0);
    if (!found.length) return null;
    found.sort((a, b) => ((b.playing ? 1e9 : 0) + b.width * b.height) - ((a.playing ? 1e9 : 0) + a.width * a.height));
    return found[0];
  } catch (e) {
    return null;
  }
}

function readNetStats() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getNetStats', tabId: currentTab.id }, (res) => {
      resolve(chrome.runtime.lastError ? null : res);
    });
  });
}

/* ------------------------------------------------------------
   Rendu du bloc lecteur
   ------------------------------------------------------------ */

function renderPlayer(stats, net) {
  const bps = playbackBps(stats, net);
  const { value, unit } = splitBitrate(bps);
  setText('bitrate-val', value);
  setText('bitrate-unit', unit);
  document.getElementById('bitrate-val').style.color =
    bps >= 8e6 ? '#00E676' : bps >= 3e6 ? '#8BC34A' : bps > 0 ? '#FFC107' : '#555';

  if (!stats) {
    setText('player-status', 'Pas de lecture active');
    setText('player-res', '--');
    setText('player-fps', '--');
    setText('player-buffer', '--');
  } else {
    setText('player-res', `${stats.width}×${stats.height}`);
    setText('player-fps', stats.fps ? String(stats.fps) : '--');
    setText('player-buffer', Number.isFinite(stats.buffer) ? `${stats.buffer.toFixed(1)}s` : '--');

    let label = 'SD';
    if (stats.width >= 3800 || stats.height >= 2100) label = '4K UHD';
    else if (stats.width >= 1900 || stats.height >= 1000) label = 'Full HD 1080p';
    else if (stats.width >= 1200 || stats.height >= 700) label = 'HD 720p';

    const parts = [`Rendu réel (${label})`];
    if (stats.videoBps !== null && stats.videoBps !== undefined) {
      parts.push(`vidéo ${formatBitrate(stats.videoBps)} · audio ${formatBitrate(stats.audioBps)}`);
    }
    if (stats.totalFrames) {
      const pct = ((stats.droppedFrames / stats.totalFrames) * 100).toFixed(2);
      parts.push(`${stats.droppedFrames} images perdues (${pct}%)`);
    }
    setText('player-status', parts.join(' · '));
  }

  setText('player-net', net && net.bps ? formatBitrate(net.bps).replace(' ', '') : '--');
}

function playbackBps(stats, net) {
  if (stats && stats.videoBps !== null && stats.videoBps !== undefined) {
    return stats.videoBps + (stats.audioBps || 0);
  }
  return net ? net.bps : 0;
}

/* ------------------------------------------------------------
   Rendu de la liste des flux
   ------------------------------------------------------------ */

function displayStreams(streams) {
  const container = document.getElementById('content');

  if (!streams || streams.length === 0) {
    container.innerHTML = '<div class="no-stream">Aucun flux détecté.<br>Lancez la vidéo.</div>';
    return;
  }

  container.innerHTML = '';
  [...streams].reverse().forEach((stream, index) => {
    container.appendChild(createStreamCard(stream, streams.length - index, index === 0));
  });
}

function matchedLevel(stream) {
  if (!latestStats || !Array.isArray(stream.levels)) return null;
  return stream.levels.find((l) => l.width === latestStats.width && l.height === latestStats.height)
      || stream.levels.find((l) => l.height === latestStats.height)
      || null;
}

function createStreamCard(stream, index, isTop) {
  const div = document.createElement('div');
  div.className = isTop ? 'stream-container top' : 'stream-container';

  const levels = Array.isArray(stream.levels) ? stream.levels : [];
  const active = isTop ? matchedLevel(stream) : null;

  let badges = '';
  if (stream.features && stream.features.drm) badges += '<span class="badge drm">🔒 DRM</span>';
  else if (stream.features && stream.features.encrypted) badges += '<span class="badge enc">🔑 AES-128</span>';
  if (stream.live === true) badges += '<span class="badge live">🔴 LIVE</span>';
  if (stream.live === false) badges += `<span class="badge vod">VOD ${formatDuration(stream.duration)}</span>`;
  if (stream.audioTracks && stream.audioTracks.length) {
    const langs = stream.audioTracks.map((t) => t.language || t.name).filter(Boolean).slice(0, 3).join(', ');
    badges += `<span class="badge audio">🔊 ${stream.audioTracks.length}${langs ? ' · ' + langs : ''}</span>`;
  }
  if (stream.subtitleTracks && stream.subtitleTracks.length) {
    badges += `<span class="badge subs">💬 ${stream.subtitleTracks.length} ST</span>`;
  }
  if (levels.length > 1) badges += `<span class="badge">${levels.length} variantes</span>`;

  let levelsHtml = '';
  levels.forEach((l, i) => {
    const isCurrent = active && l === active;
    const rate = l.bandwidth ? formatBitrate(l.avgBandwidth || l.bandwidth) : '';
    const codec = l.codecLabel ? ` · ${l.codecLabel}` : '';
    levelsHtml += `<div class="level${isCurrent ? ' current' : ''}" data-level="${i}" title="${l.uri || ''}">
        <span>${isCurrent ? '▶ ' : ''}${l.resolution}${l.frameRate ? ` @${Math.round(l.frameRate)}` : ''}${codec}</span>
        <span class="l-rate">${rate}</span>
      </div>`;
  });

  let estimate = '';
  const best = levels.find((l) => l.bandwidth);
  if (stream.duration && best && best.bandwidth) {
    estimate = `<div class="estimate">Téléchargement complet ≈ ${formatBytes((stream.duration * best.bandwidth) / 8)} au meilleur débit</div>`;
  }

  div.innerHTML = `
    <div class="card-head">
      <strong>Flux #${index} <span style="color:#666;font-weight:400">${stream.type || ''}</span></strong>
      <button class="copy-btn">Copier</button>
    </div>
    <div class="url" title="${stream.url}">${stream.url.substring(0, 52)}${stream.url.length > 52 ? '…' : ''}</div>
    <div class="badges">${badges}</div>
    <div class="levels">${levelsHtml}</div>
    ${estimate}
  `;

  div.querySelector('.copy-btn').addEventListener('click', (e) => {
    navigator.clipboard.writeText(stream.url).catch(() => {});
    flash(e.currentTarget, '✓');
  });

  div.querySelectorAll('.level').forEach((el) => {
    el.addEventListener('click', () => {
      const l = levels[parseInt(el.dataset.level, 10)];
      if (!l || !l.uri) return;
      navigator.clipboard.writeText(l.uri).catch(() => {});
      const rate = el.querySelector('.l-rate');
      const original = rate.innerText;
      rate.innerText = '✓ URL copiée';
      setTimeout(() => { rate.innerText = original; }, 1000);
    });
  });

  return div;
}

/* ------------------------------------------------------------
   Mode "lien direct" (page d'extension)
   ------------------------------------------------------------ */

async function fetchAndDisplayManual(url) {
  const container = document.getElementById('content');
  container.innerHTML = '<div class="no-stream">Analyse du lien dans l\'URL…</div>';

  try {
    const response = await fetch(url);
    const text = await response.text();
    const levels = parseM3U8Levels(text, url);
    container.innerHTML = '';
    container.appendChild(createStreamCard({ url, levels, type: 'Manuel' }, 1, true));
  } catch (e) {
    container.innerHTML = `<div class="no-stream">Lien trouvé mais illisible (CORS/Auth).<br>${url.substring(0, 40)}…</div>`;
  }
}

function parseM3U8Levels(content, baseUrl) {
  const lines = content.split('\n').map((l) => l.trim());
  const levels = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const line = lines[i];
    const res = (line.match(/RESOLUTION=(\d+x\d+)/) || [])[1] || null;
    const bw = parseInt((line.match(/BANDWIDTH=(\d+)/) || [])[1], 10);
    const avg = parseInt((line.match(/AVERAGE-BANDWIDTH=(\d+)/) || [])[1], 10);
    const uri = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : null;
    const [w, h] = res ? res.split('x').map(Number) : [null, null];

    levels.push({
      resolution: res || 'Audio seul',
      width: w, height: h,
      bandwidth: Number.isFinite(bw) ? bw : null,
      avgBandwidth: Number.isFinite(avg) ? avg : null,
      uri: uri ? new URL(uri, baseUrl).href : null
    });
  }

  if (levels.length) return levels.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  if (content.includes('#EXTINF')) return [{ resolution: 'Playlist média', uri: baseUrl }];
  return [{ resolution: 'Inconnu', uri: baseUrl }];
}

/* ------------------------------------------------------------
   Utilitaires
   ------------------------------------------------------------ */

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}

function flash(btn, text) {
  const original = btn.innerText;
  btn.innerText = text;
  setTimeout(() => { btn.innerText = original; }, 1000);
}

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
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
               : `${m}:${String(s).padStart(2, '0')}`;
}
