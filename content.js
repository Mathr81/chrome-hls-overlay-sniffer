let overlay = null;
let currentStreams = []; 
let lastVideoStats = null;

const ICON_COPY = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const ICON_TERMINAL = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;

function createOverlay() {
    if (document.getElementById('hls-stats-overlay')) return;

    // Only create overlay in top frame OR if we are in fullscreen
    if (window.self !== window.top && !document.fullscreenElement && !document.webkitFullscreenElement) {
        return;
    }

    const div = document.createElement('div');
    div.id = 'hls-stats-overlay';
    div.innerHTML = `
        <div id="hls-stats-header">
            <span>⚡ HLS MONITOR PRO</span>
            <span id="hls-close-btn" style="cursor:pointer; font-size:14px; padding:0 5px;">&times;</span>
        </div>
        <div id="hls-stats-content">
            <div class="hls-grid">
                <div>
                    <div class="hls-label">Rendu</div>
                    <div class="hls-value" id="hls-source-val">--</div>
                </div>
                <div>
                    <div class="hls-label">Écran (Phy)</div>
                    <div class="hls-value" id="hls-screen-val">--</div>
                </div>
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
    
    document.getElementById('hls-close-btn').onclick = () => setVisible(false);
    document.getElementById('hls-toggle-history').onclick = () => {
        const list = document.getElementById('hls-history-list');
        const btn = document.getElementById('hls-toggle-history');
        if(list.style.display === 'none') {
            list.style.display = 'block';
            btn.innerText = "Masquer l'historique";
        } else {
            list.style.display = 'none';
            btn.innerText = "Voir l'historique";
        }
    };
}

function injectOverlay(element) {
    const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsElement) {
        fsElement.appendChild(element);
    } else if (window.self === window.top) {
        document.body.appendChild(element);
    }
}

function setVisible(visible) {
    const el = document.getElementById('hls-stats-overlay');
    if (!el && visible) {
        createOverlay();
    }
    const targetEl = document.getElementById('hls-stats-overlay');
    if (targetEl) {
        targetEl.style.display = visible ? 'block' : 'none';
        if (visible) {
            updateStatsUI();
        }
    }
}

function updateStatsUI(stats) {
    const sourceVal = document.getElementById('hls-source-val');
    const screenVal = document.getElementById('hls-screen-val');
    if (!sourceVal || !screenVal) return;

    const currentStats = stats || lastVideoStats;

    if (currentStats && currentStats.width > 0) {
        sourceVal.innerText = `${currentStats.width} x ${currentStats.height}`;
        sourceVal.style.color = currentStats.width >= 1900 ? '#00E676' : '#fff';
    } else {
        sourceVal.innerText = "N/A";
    }

    const ratio = window.devicePixelRatio || 1;
    screenVal.innerText = `${Math.round(window.innerWidth * ratio)} x ${Math.round(window.innerHeight * ratio)}`;
    
    renderStreams();
}

function renderStreams() {
    const activeDiv = document.getElementById('hls-active-stream');
    const histDiv = document.getElementById('hls-history-list');
    const histCount = document.getElementById('hls-hist-count');
    
    if (!activeDiv || !currentStreams || currentStreams.length === 0) return;

    const streamsCopy = [...currentStreams];
    const activeStream = streamsCopy.pop();
    const historyStreams = streamsCopy.reverse();

    activeDiv.innerHTML = '';
    activeDiv.appendChild(createStreamCard(activeStream, true));

    histDiv.innerHTML = '';
    historyStreams.forEach(s => histDiv.appendChild(createStreamCard(s, false)));
    histCount.innerText = `(${historyStreams.length})`;
}

function createStreamCard(stream, isActive) {
    const div = document.createElement('div');
    div.className = isActive ? 'hls-stream-card active' : 'hls-stream-card';
    
    let badges = '';
    if (stream.features && stream.features.drm) badges += `<span class="hls-badge drm">🔒 DRM</span>`;
    if (stream.features && stream.features.audio) badges += `<span class="hls-badge audio">🔊 MULTI-AUDIO</span>`;
    
    stream.levels.slice(0, 3).forEach(l => {
        let color = '#444';
        if(l.resolution.includes('1080') || l.resolution.includes('1920')) color = '#2e7d32';
        badges += `<span class="hls-badge" style="background:${color}">${l.resolution}</span>`;
    });

    const ffmpegCmd = `ffmpeg -i "${stream.url}" -c copy output.mp4`;

    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="font-weight:bold; color:${isActive ? '#fff' : '#aaa'}; font-size:11px;">
                ${isActive ? '🔴 SIGNAL EN DIRECT' : 'Flux archivé'}
            </div>
            <div style="display:flex; gap:5px;">
                <button class="hls-icon-btn copy-url" title="Copier l'URL du flux">${ICON_COPY}</button>
                <button class="hls-icon-btn copy-ffmpeg" title="Copier commande FFmpeg">${ICON_TERMINAL}</button>
            </div>
        </div>
        <div class="hls-url">${stream.url.substring(0, 40)}...</div>
        <div style="margin-top:5px">${badges}</div>
    `;

    div.querySelector('.copy-url').onclick = (e) => {
        navigator.clipboard.writeText(stream.url);
        showFeedback(e.currentTarget);
    };

    div.querySelector('.copy-ffmpeg').onclick = (e) => {
        navigator.clipboard.writeText(ffmpegCmd);
        showFeedback(e.currentTarget);
    };

    return div;
}

function showFeedback(btn) {
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<span style="color:#00E676; font-size:9px;">OK</span>';
    setTimeout(() => btn.innerHTML = originalContent, 1000);
}

// DRAG logic
function setupDrag(elmnt) {
    const header = document.getElementById("hls-stats-header");
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.onmousedown = (e) => {
        if(e.target.id === 'hls-close-btn') return;
        e.preventDefault(); e.stopPropagation();
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = elmnt.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        header.style.cursor = 'grabbing';
    };

    function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        elmnt.style.left = (initialLeft + dx) + "px";
        elmnt.style.top = (initialTop + dy) + "px";
    }

    function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        header.style.cursor = 'grab';
    }
}

// Video detection & reporting
function reportVideoStats() {
    const video = document.querySelector('video');
    if (video) {
        const stats = {
            width: video.videoWidth,
            height: video.videoHeight,
            playing: !video.paused && !video.ended
        };
        chrome.runtime.sendMessage({ action: "reportVideoStats", stats });
    }
}

// Periodic reporting
setInterval(reportVideoStats, 2000);

// Listeners
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "setVisibility") {
        if (request.streams) currentStreams = request.streams;
        if (request.videoStats) lastVideoStats = request.videoStats;
        setVisible(request.visible);
    }
    if (request.action === "updateStreams") {
        if (request.streams) {
            currentStreams = request.streams;
            if (overlay && overlay.style.display === 'block') renderStreams();
        }
    }
    if (request.action === "updateVideoStats") {
        lastVideoStats = request.videoStats;
        if (overlay && overlay.style.display === 'block') updateStatsUI(request.videoStats);
    }
});

// Fullscreen & cleanup
["fullscreenchange", "webkitfullscreenchange"].forEach(evt => 
    document.addEventListener(evt, () => {
        const el = document.getElementById('hls-stats-overlay');
        const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
        
        if (el) {
            injectOverlay(el);
        } else if (isFS) {
            // If we go fullscreen in a frame that didn't have the overlay, maybe it needs it
            // but we check if background says it should be visible
            chrome.runtime.sendMessage({ action: "getOverlayState" }, (response) => {
                if (response && response.visible) {
                    createOverlay();
                    setVisible(true);
                }
            });
        }
    })
);