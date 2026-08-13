/* ============================================================
   HLS Sniffer Pro — Service Worker
   - Interception des manifests HLS (.m3u8) et parsing enrichi
   - Mesure du débit réseau réel (segments) par onglet
   - Etat de l'overlay persisté (survit à la mise en veille du SW)
   ============================================================ */

const NET_WINDOW_MS = 8000;   // fenêtre glissante pour le débit réseau
const MANIFEST_TTL = 30000;   // délai mini avant de re-télécharger un manifest
const MAX_STREAMS = 20;       // taille max de l'historique par onglet
const BROADCAST_MS = 800;     // anti-spam des broadcasts vers le content script
const DEFAULT_SPAN_MS = 500;  // durée de transfert supposée si le début est inconnu

const tabStates = {};          // tabId -> { overlayVisible, videoStats, lastBroadcast }
const netTrack = {};           // tabId -> { samples, startedAt, totalBytes, peakBps }
const manifestSeen = new Map(); // url -> timestamp du dernier fetch

/* ------------------------------------------------------------
   Etat par onglet
   ------------------------------------------------------------ */

function state(tabId) {
  if (!tabStates[tabId]) {
    tabStates[tabId] = { overlayVisible: false, videoStats: null, lastBroadcast: 0 };
  }
  return tabStates[tabId];
}

function track(tabId) {
  if (!netTrack[tabId]) {
    netTrack[tabId] = { samples: [], totalBytes: 0, peakBps: 0 };
  }
  return netTrack[tabId];
}

function resetTab(tabId) {
  delete tabStates[tabId];
  delete netTrack[tabId];
}

// La visibilité de l'overlay est persistée : un service worker MV3 est
// arrêté après ~30s d'inactivité, ce qui désynchronisait le toggle Alt+S.
const visKey = (tabId) => `vis_${tabId}`;

async function setOverlayVisible(tabId, visible) {
  state(tabId).overlayVisible = visible;
  try { await chrome.storage.session.set({ [visKey(tabId)]: visible }); } catch (e) { /* noop */ }
}

async function getOverlayVisible(tabId) {
  try {
    const res = await chrome.storage.session.get(visKey(tabId));
    if (typeof res[visKey(tabId)] === 'boolean') state(tabId).overlayVisible = res[visKey(tabId)];
  } catch (e) { /* noop */ }
  return state(tabId).overlayVisible;
}

/* ------------------------------------------------------------
   Cycle de vie
   ------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.clear();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(tabId.toString());
  chrome.storage.session.remove(visKey(tabId)).catch(() => {});
  resetTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.local.remove(tabId.toString());
    const visible = state(tabId).overlayVisible;
    resetTab(tabId);
    state(tabId).overlayVisible = visible; // on garde l'overlay ouvert d'une page à l'autre
  }
});

/* ------------------------------------------------------------
   Détection des manifests
   ------------------------------------------------------------ */

const MANIFEST_RE = /\.(m3u8|mpd)(?:[?#]|$)/i;
const SEGMENT_EXT_RE = /\.(ts|m4s|m4v|m4a|mp4|mp4a|aac|ac3|ec3|fmp4|cmfv|cmfa|webm)(?:[?#]|$)/i;

const pendingRequests = new Map(); // requestId -> début du transfert

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId === -1) return;
    if (!details.url.includes('.m3u8')) return;

    const last = manifestSeen.get(details.url);
    if (last && Date.now() - last < MANIFEST_TTL) return; // live playlist rafraîchie en boucle
    manifestSeen.set(details.url, Date.now());
    if (manifestSeen.size > 300) manifestSeen.clear();

    fetchAndParseM3U8(details.url, details.tabId);
  },
  { urls: ['<all_urls>'] }
);

// Repère du début de transfert du corps : c'est l'intervalle
// onResponseStarted → onCompleted qui porte les octets, pas la phase
// DNS/TLS/TTFB qui précède.
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId === -1) return;
    pendingRequests.set(details.requestId, details.timeStamp);
    if (pendingRequests.size > 500) {
      pendingRequests.delete(pendingRequests.keys().next().value);
    }
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => pendingRequests.delete(details.requestId),
  { urls: ['<all_urls>'] }
);

/* ------------------------------------------------------------
   Mesure du débit réseau réel (segments média)
   ------------------------------------------------------------ */

function headerValue(headers, name) {
  if (!headers) return null;
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

function isMediaSegment(details, headers) {
  const url = details.url;
  if (MANIFEST_RE.test(url)) return false;

  const ct = (headerValue(headers, 'content-type') || '').toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('dash+xml') || ct.startsWith('text/')) return false;

  if (SEGMENT_EXT_RE.test(url)) return true;
  if (details.type === 'media') return true;
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return true;
  if (ct.includes('mp2t') || ct.includes('iso.segment')) return true;
  return false;
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const start = pendingRequests.get(details.requestId);
    pendingRequests.delete(details.requestId);

    if (details.tabId === -1 || details.fromCache) return;
    if (!isMediaSegment(details, details.responseHeaders)) return;

    const len = parseInt(headerValue(details.responseHeaders, 'content-length'), 10);
    if (!Number.isFinite(len) || len <= 0) return;

    // Un service worker MV3 endormi peut rater le début d'une requête : dans ce
    // cas on étale les octets sur une durée par défaut plutôt que de perdre
    // l'échantillon (sinon le débit tombe à zéro).
    const end = details.timeStamp;
    const t = track(details.tabId);
    t.samples.push({
      start: Number.isFinite(start) && start < end ? start : end - DEFAULT_SPAN_MS,
      end,
      bytes: len
    });
    t.totalBytes += len;
    pruneSamples(t);

    const bps = computeNetBps(details.tabId);
    if (bps > t.peakBps) t.peakBps = bps;

    maybeBroadcast(details.tabId);
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

function pruneSamples(t) {
  const cutoff = Date.now() - NET_WINDOW_MS;
  while (t.samples.length && t.samples[0].end < cutoff) t.samples.shift();
}

function computeNetBps(tabId) {
  const t = netTrack[tabId];
  if (!t) return 0;
  pruneSamples(t);
  if (!t.samples.length) return 0;

  const now = Date.now();
  const winStart = now - NET_WINDOW_MS;

  // Les octets d'une requête sont répartis sur sa durée réelle de transfert :
  // sans ça, un gros segment arrivant en fin de fenêtre produit un pic aberrant.
  let bits = 0;
  for (const s of t.samples) {
    const span = Math.max(50, s.end - s.start);
    const overlap = Math.min(s.end, now) - Math.max(s.start, winStart);
    if (overlap <= 0) continue;
    bits += s.bytes * 8 * Math.min(1, overlap / span);
  }

  // Dénominateur = fenêtre complète, toujours. Un dénominateur qui « rampe » au
  // démarrage produirait des pics à plusieurs centaines de Mb/s sur le premier
  // segment ; ici la mesure monte progressivement pendant 8 s puis est exacte.
  return bits / (NET_WINDOW_MS / 1000);
}

function netSnapshot(tabId) {
  const t = netTrack[tabId];
  if (!t) return { bps: 0, totalBytes: 0, peakBps: 0, segments: 0 };
  return {
    bps: computeNetBps(tabId),
    totalBytes: t.totalBytes,
    peakBps: t.peakBps,
    segments: t.samples.length
  };
}

/* ------------------------------------------------------------
   Récupération + parsing du manifest
   ------------------------------------------------------------ */

async function fetchAndParseM3U8(url, tabId) {
  const key = tabId.toString();

  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error('Auth/Network');
    const text = await response.text();

    const parsed = parseM3U8(text, url);

    updateStorage(key, {
      url,
      levels: parsed.levels,
      type: parsed.isMaster ? 'Master' : 'Stream',
      timestamp: Date.now(),
      live: parsed.live,
      duration: parsed.duration,
      segmentCount: parsed.segmentCount,
      targetDuration: parsed.targetDuration,
      audioTracks: parsed.audioTracks,
      subtitleTracks: parsed.subtitleTracks,
      features: {
        drm: parsed.drm,
        encrypted: parsed.encrypted,
        audio: parsed.audioTracks.length > 0,
        subtitles: parsed.subtitleTracks.length > 0
      }
    }, tabId);
  } catch (error) {
    updateStorage(key, {
      url,
      levels: [{ resolution: 'Protégé / Inconnu', bandwidth: null }],
      type: 'Unknown',
      timestamp: Date.now(),
      live: null,
      audioTracks: [],
      subtitleTracks: [],
      features: { drm: true, encrypted: true, audio: false, subtitles: false }
    }, tabId);
  }
}

function updateStorage(key, newData, tabId) {
  chrome.storage.local.get([key], (result) => {
    let streams = result[key] || [];
    const existingIndex = streams.findIndex((s) => s.url === newData.url);

    if (existingIndex !== -1) {
      const merged = { ...streams[existingIndex], ...newData };
      streams.splice(existingIndex, 1);
      streams.push(merged);
    } else {
      streams.push(newData);
    }

    if (streams.length > MAX_STREAMS) streams = streams.slice(-MAX_STREAMS);

    chrome.storage.local.set({ [key]: streams });
    chrome.action.setBadgeText({ text: streams.length.toString(), tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#FF0000', tabId }).catch(() => {});
    refreshTitle(tabId, streams.length);

    chrome.tabs.sendMessage(tabId, { action: 'updateStreams', streams }).catch(() => {});
  });
}

function refreshTitle(tabId, streamCount) {
  const bps = computeNetBps(tabId);
  const rate = bps > 0 ? ` · ${formatBitrate(bps)}` : '';
  chrome.action.setTitle({ tabId, title: `HLS Sniffer Pro — ${streamCount} flux${rate}` }).catch(() => {});
}

function formatBitrate(bps) {
  if (!bps || bps <= 0) return '--';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mb/s`;
  return `${Math.round(bps / 1e3)} kb/s`;
}

/* ------------------------------------------------------------
   Parser M3U8
   ------------------------------------------------------------ */

function attr(line, name) {
  // Gère les valeurs entre guillemets et les valeurs nues
  const re = new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]+))`);
  const m = line.match(re);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

function absolute(uri, base) {
  try { return new URL(uri, base).href; } catch (e) { return uri; }
}

function parseM3U8(content, baseUrl) {
  const lines = content.split('\n').map((l) => l.trim());
  const levels = [];
  const audioTracks = [];
  const subtitleTracks = [];

  let isMaster = false;
  let encrypted = false;
  let drm = false;
  let duration = 0;
  let segmentCount = 0;
  let targetDuration = null;
  let hasEndList = content.includes('#EXT-X-ENDLIST');
  let playlistType = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      const resolution = attr(line, 'RESOLUTION');
      const bandwidth = parseInt(attr(line, 'BANDWIDTH'), 10);
      const avgBandwidth = parseInt(attr(line, 'AVERAGE-BANDWIDTH'), 10);
      const frameRate = parseFloat(attr(line, 'FRAME-RATE'));
      const codecs = attr(line, 'CODECS');

      // La ligne suivante non commentée porte l'URI de la variante
      let uri = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) { uri = lines[j]; break; }
        if (lines[j].startsWith('#EXT-X-STREAM-INF')) break;
      }

      const [w, h] = resolution ? resolution.split('x').map(Number) : [null, null];

      levels.push({
        resolution: resolution || 'Audio seul',
        width: w,
        height: h,
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
        avgBandwidth: Number.isFinite(avgBandwidth) ? avgBandwidth : null,
        frameRate: Number.isFinite(frameRate) ? frameRate : null,
        codecs: codecs || null,
        codecLabel: codecLabel(codecs),
        uri: uri ? absolute(uri, baseUrl) : null
      });
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA')) {
      const type = attr(line, 'TYPE');
      const entry = {
        name: attr(line, 'NAME'),
        language: attr(line, 'LANGUAGE'),
        channels: attr(line, 'CHANNELS'),
        default: /DEFAULT=YES/.test(line)
      };
      if (type === 'AUDIO') audioTracks.push(entry);
      else if (type === 'SUBTITLES' || type === 'CLOSED-CAPTIONS') subtitleTracks.push(entry);
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const method = attr(line, 'METHOD');
      if (method && method !== 'NONE') {
        encrypted = true;
        const keyFormat = attr(line, 'KEYFORMAT') || '';
        // AES-128 avec une clé en clair n'est pas du DRM ; SAMPLE-AES + KEYFORMAT
        // propriétaire (Widevine / FairPlay / PlayReady) l'est.
        if (method.startsWith('SAMPLE-AES') || /urn:uuid|com\.apple\.streamingkeydelivery|com\.microsoft\.playready/i.test(keyFormat)) {
          drm = true;
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION')) {
      targetDuration = parseFloat(line.split(':')[1]);
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      playlistType = (line.split(':')[1] || '').trim();
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      segmentCount++;
      const d = parseFloat((line.split(':')[1] || '').split(',')[0]);
      if (Number.isFinite(d)) duration += d;
      continue;
    }
  }

  if (isMaster && levels.length > 0) {
    levels.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return {
      levels, isMaster: true, encrypted, drm, audioTracks, subtitleTracks,
      live: null, duration: null, segmentCount: 0, targetDuration
    };
  }

  const live = segmentCount > 0 ? (!hasEndList && playlistType !== 'VOD') : null;

  if (segmentCount > 0) {
    return {
      levels: [{
        resolution: live ? 'Flux direct (live)' : 'Playlist média (VOD)',
        width: null, height: null, bandwidth: null, avgBandwidth: null,
        frameRate: null, codecs: null, codecLabel: null, uri: baseUrl
      }],
      isMaster: false, encrypted, drm, audioTracks, subtitleTracks,
      live, duration, segmentCount, targetDuration
    };
  }

  return {
    levels: [{ resolution: 'Inconnu', width: null, height: null, bandwidth: null, avgBandwidth: null, frameRate: null, codecs: null, codecLabel: null, uri: baseUrl }],
    isMaster: false, encrypted, drm, audioTracks, subtitleTracks,
    live: null, duration: null, segmentCount: 0, targetDuration
  };
}

/* Traduction des identifiants RFC 6381 en noms lisibles */
function codecLabel(codecs) {
  if (!codecs) return null;
  const parts = codecs.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];

  const video = parts.find((c) => /^(avc[13]|hvc1|hev1|av01|vp0?[89]|dvh[1e])/i.test(c));
  const audio = parts.find((c) => /^(mp4a|ac-3|ec-3|opus|vorbis|fLaC|alac)/i.test(c));

  if (video) {
    if (/^avc/i.test(video)) {
      const m = video.match(/^avc[13]\.([0-9a-f]{2})[0-9a-f]{2}([0-9a-f]{2})$/i);
      if (m) {
        const profiles = { '42': 'Baseline', '4d': 'Main', '58': 'Extended', '64': 'High' };
        const p = profiles[m[1].toLowerCase()];
        const lvl = (parseInt(m[2], 16) / 10).toFixed(1);
        out.push(`H.264${p ? ' ' + p : ''}@L${lvl}`);
      } else out.push('H.264');
    } else if (/^(hvc1|hev1)/i.test(video)) out.push('HEVC');
    else if (/^av01/i.test(video)) out.push('AV1');
    else if (/^vp0?9/i.test(video)) out.push('VP9');
    else if (/^vp0?8/i.test(video)) out.push('VP8');
    else if (/^dvh/i.test(video)) out.push('Dolby Vision');
  }

  if (audio) {
    if (/^mp4a\.40\.2/i.test(audio)) out.push('AAC-LC');
    else if (/^mp4a\.40\.5/i.test(audio)) out.push('HE-AAC');
    else if (/^mp4a\.40\.29/i.test(audio)) out.push('HE-AACv2');
    else if (/^mp4a/i.test(audio)) out.push('AAC');
    else if (/^ac-3/i.test(audio)) out.push('Dolby Digital');
    else if (/^ec-3/i.test(audio)) out.push('Dolby Digital+');
    else if (/^opus/i.test(audio)) out.push('Opus');
    else if (/^fLaC/i.test(audio)) out.push('FLAC');
  }

  return out.length ? out.join(' · ') : codecs;
}

/* ------------------------------------------------------------
   Raccourci clavier
   ------------------------------------------------------------ */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-overlay') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const visible = !(await getOverlayVisible(tab.id));
  await setOverlayVisible(tab.id, visible);

  const res = await chrome.storage.local.get([tab.id.toString()]);
  chrome.tabs.sendMessage(tab.id, {
    action: 'setVisibility',
    visible,
    streams: res[tab.id.toString()] || [],
    videoStats: state(tab.id).videoStats,
    net: netSnapshot(tab.id)
  }).catch(() => {});
});

/* ------------------------------------------------------------
   Messages
   ------------------------------------------------------------ */

function maybeBroadcast(tabId) {
  const st = state(tabId);
  if (!st.overlayVisible) return;
  const now = Date.now();
  if (now - st.lastBroadcast < BROADCAST_MS) return;
  st.lastBroadcast = now;

  chrome.tabs.sendMessage(tabId, {
    action: 'updateStats',
    videoStats: st.videoStats,
    net: netSnapshot(tabId)
  }).catch(() => {});
}

function betterStats(candidate, current) {
  if (!current) return true;
  if (candidate.playing && !current.playing) return true;
  if (!candidate.playing && current.playing) return false;
  return (candidate.width * candidate.height) >= (current.width * current.height);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (request.action === 'reportVideoStats' && tabId !== null) {
    const st = state(tabId);
    if (betterStats(request.stats, st.videoStats)) st.videoStats = request.stats;
    maybeBroadcast(tabId);
    sendResponse({ net: netSnapshot(tabId), videoStats: st.videoStats });
    return true;
  }

  if (request.action === 'getOverlayState' && tabId !== null) {
    getOverlayVisible(tabId).then((visible) => {
      sendResponse({ visible, videoStats: state(tabId).videoStats, net: netSnapshot(tabId) });
    });
    return true;
  }

  if (request.action === 'setOverlayVisible' && tabId !== null) {
    setOverlayVisible(tabId, request.visible).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Demandé par le popup (pas de sender.tab)
  if (request.action === 'getNetStats') {
    sendResponse(netSnapshot(request.tabId));
    return true;
  }

  return false;
});
