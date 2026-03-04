let overlay = null;
let currentStreams = []; 
let updateInterval = null;

function createOverlay() {
    if (document.getElementById('hls-stats-overlay')) return;

    const div = document.createElement('div');
    div.id = 'hls-stats-overlay';
    div.innerHTML = `
        <div id="hls-stats-header">
            <span>⚡ HLS MONITOR PRO</span>
            <span id="hls-close-btn" style="cursor:pointer; font-size:14px; padding:0 5px;">&times;</span>
        </div>
        <div id="hls-stats-content">
            <!-- Section Stats Écran -->
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

            <!-- Section Flux Actif -->
            <div class="hls-section-title">LECTURE EN COURS 🟢</div>
            <div id="hls-active-stream" class="hls-empty">Aucun flux actif</div>

            <!-- Section Historique -->
            <div class="hls-section-title" style="margin-top:10px; opacity:0.7">HISTORIQUE <span id="hls-hist-count">(0)</span></div>
            <div id="hls-history-list" style="display:none;"></div>
            <button id="hls-toggle-history">Voir l'historique</button>
        </div>
    `;

    injectOverlay(div);
    overlay = div;
    setupDrag(div);
    
    // Events
    document.getElementById('hls-close-btn').onclick = toggleOverlayVisibility;
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
    if (fsElement) fsElement.appendChild(element);
    else document.body.appendChild(element);
}

// Correction du bug "Double Clic"
function toggleOverlayVisibility() {
    const el = document.getElementById('hls-stats-overlay');
    if (!el) return;

    // On vérifie si c'est explicitement block, sinon on affiche
    if (el.style.display === 'block') {
        el.style.display = 'none';
        clearInterval(updateInterval);
    } else {
        el.style.display = 'block';
        updateStats();
        updateInterval = setInterval(updateStats, 1000);
    }
}

function updateStats() {
    const video = document.querySelector('video');
    const sourceVal = document.getElementById('hls-source-val');
    const screenVal = document.getElementById('hls-screen-val');

    if (video && video.videoWidth > 0) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        sourceVal.innerText = `${w} x ${h}`;
        sourceVal.style.color = w >= 1900 ? '#00E676' : '#fff';
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
    
    if (!currentStreams || currentStreams.length === 0) return;

    // Le dernier élément du tableau est le plus récent (Actif)
    const streamsCopy = [...currentStreams];
    const activeStream = streamsCopy.pop(); // Enlève et récupère le dernier
    const historyStreams = streamsCopy.reverse(); // Le reste est l'historique

    // Rendu Actif
    activeDiv.innerHTML = '';
    activeDiv.appendChild(createStreamCard(activeStream, true));

    // Rendu Historique
    histDiv.innerHTML = '';
    historyStreams.forEach(s => histDiv.appendChild(createStreamCard(s, false)));
    histCount.innerText = `(${historyStreams.length})`;
}

function createStreamCard(stream, isActive) {
    const div = document.createElement('div');
    div.className = isActive ? 'hls-stream-card active' : 'hls-stream-card';
    
    let badges = '';
    // DRM Badge
    if (stream.features && stream.features.drm) badges += `<span class="hls-badge drm">🔒 DRM</span>`;
    // Audio Badge
    if (stream.features && stream.features.audio) badges += `<span class="hls-badge audio">🔊 MULTI-AUDIO</span>`;
    
    // Qualities
    stream.levels.slice(0, 3).forEach(l => { // Max 3 badges
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
            <button class="hls-copy-btn" title="Copier FFmpeg cmd">CMD</button>
        </div>
        <div class="hls-url">${stream.url.substring(0, 40)}...</div>
        <div style="margin-top:5px">${badges}</div>
    `;

    // Event Copie FFmpeg
    const btn = div.querySelector('.hls-copy-btn');
    btn.onclick = (e) => {
        navigator.clipboard.writeText(ffmpegCmd);
        e.target.innerText = "OK";
        setTimeout(() => e.target.innerText = "CMD", 1000);
    };

    return div;
}

// SETUP DRAG (Version stable)
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

// Listeners
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggleOverlay") {
        createOverlay();
        if(request.streams) currentStreams = request.streams;
        toggleOverlayVisibility();
    }
    if (request.action === "updateStreams") {
        if (request.streams) {
            currentStreams = request.streams;
            renderStreams();
        }
    }
});

// Fullscreen Listeners
["fullscreenchange", "webkitfullscreenchange"].forEach(evt => 
    document.addEventListener(evt, () => {
        const el = document.getElementById('hls-stats-overlay');
        if (el) injectOverlay(el);
    })
);