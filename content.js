let overlay = null;
let currentStreams = []; 
let updateInterval = null;

// Création HTML
function createOverlay() {
    if (document.getElementById('hls-stats-overlay')) return;

    const div = document.createElement('div');
    div.id = 'hls-stats-overlay';
    div.innerHTML = `
        <div id="hls-stats-header">
            <span style="font-weight:bold;">📊 STATS NERDS</span>
            <span id="hls-close-btn" style="cursor:pointer; opacity:0.7">✖</span>
        </div>
        <div id="hls-stats-content">
            <!-- Section Vidéo -->
            <div class="hls-stat-row">
                <span class="hls-label">Source Vidéo</span>
                <span class="hls-value" id="hls-source-val">--</span>
            </div>
            <div class="hls-stat-row">
                <span class="hls-label">Viewport (Navigateur)</span>
                <span class="hls-value" id="hls-view-val">--</span>
            </div>
             <div class="hls-stat-row">
                <span class="hls-label">Écran Physique</span>
                <span class="hls-value" id="hls-screen-val" style="color:#00E5FF">--</span>
            </div>
            
            <hr class="hls-separator">
            
            <!-- Section Flux -->
            <div style="font-size:10px; color:#888; margin-bottom:5px;">FLUX RÉSEAU DÉTECTÉS :</div>
            <div id="hls-streams-list"></div>
        </div>
    `;

    injectOverlay(div);
    overlay = div;
    setupDrag(div);
    
    document.getElementById('hls-close-btn').addEventListener('click', toggleOverlayVisibility);
}

// Injection intelligente (Compatible Plein Écran)
function injectOverlay(element) {
    const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsElement) {
        fsElement.appendChild(element);
    } else {
        document.body.appendChild(element);
    }
}

// Surveiller les changements de plein écran pour "téléporter" l'overlay
const fsEvents = ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange"];
fsEvents.forEach(evt => document.addEventListener(evt, () => {
    const el = document.getElementById('hls-stats-overlay');
    if (el) injectOverlay(el);
}));

// Système de Drag & Drop Amélioré
function setupDrag(elmnt) {
    const header = document.getElementById("hls-stats-header");
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.onmousedown = (e) => {
        e.preventDefault(); // Empêche la sélection de texte
        e.stopPropagation(); // Empêche le clic de traverser vers la vidéo

        isDragging = true;
        
        // On calcule la position initiale de la souris par rapport au coin de l'élément
        startX = e.clientX;
        startY = e.clientY;
        
        // On récupère la position actuelle de la div
        const rect = elmnt.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        // On écoute le mouvement sur tout le document (pour ne pas décrocher si la souris va trop vite)
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        
        header.style.cursor = 'grabbing';
    };

    function onMouseMove(e) {
        if (!isDragging) return;
        e.preventDefault();

        // Calcul du déplacement
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // Nouvelle position
        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // --- LIMITES DE L'ÉCRAN (Pour ne pas perdre la fenêtre) ---
        const maxLeft = window.innerWidth - elmnt.offsetWidth;
        const maxTop = window.innerHeight - elmnt.offsetHeight;

        // On borne les valeurs (0 minimum, maxScreen maximum)
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        elmnt.style.left = newLeft + "px";
        elmnt.style.top = newTop + "px";
    }

    function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        header.style.cursor = 'grab';
    }
}

// --- COEUR DE LA MISE A JOUR ---
function updateStats() {
    const video = document.querySelector('video');
    const sourceVal = document.getElementById('hls-source-val');
    const viewVal = document.getElementById('hls-view-val');
    const screenVal = document.getElementById('hls-screen-val');

    // 1. Infos Vidéo et Écran
    if (video && video.videoWidth > 0) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        sourceVal.innerText = `${w} x ${h}`;
        sourceVal.style.color = w >= 1900 ? '#4CAF50' : '#fff';
    } else {
        sourceVal.innerText = "Aucun décodage";
    }

    // Calcul de la résolution réelle (correction du DPI Scaling)
    const ratio = window.devicePixelRatio || 1;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const physicalW = Math.round(viewW * ratio);
    const physicalH = Math.round(viewH * ratio);

    viewVal.innerText = `${viewW} x ${viewH} (CSS)`;
    screenVal.innerText = `${physicalW} x ${physicalH} (Px Réels)`;

    // 2. Affichage des flux (Mise à jour DOM)
    renderStreamsList();
}

function renderStreamsList() {
    const listDiv = document.getElementById('hls-streams-list');
    if (!listDiv) return;
    
    listDiv.innerHTML = '';
    
    if (!currentStreams || currentStreams.length === 0) {
        listDiv.innerHTML = '<div style="color:#666; font-style:italic; padding:5px;">Recherche de flux...</div>';
        return;
    }

    // Affichage inversé (plus récent en haut)
    [...currentStreams].reverse().forEach((stream, idx) => {
        const div = document.createElement('div');
        div.className = 'hls-stream-item';
        
        let badges = '';
        stream.levels.forEach(l => {
            let color = '#444';
            if(l.resolution.includes('1080') || l.resolution.includes('1920')) color = '#2e7d32'; // Vert
            else if(l.resolution.includes('Flux') || l.resolution.includes('Direct')) color = '#9C27B0'; // Violet
            badges += `<span class="hls-badge" style="background:${color}">${l.resolution}</span>`;
        });

        div.innerHTML = `
            <div style="display:flex; justify-content:space-between;">
                <span style="font-weight:bold; color:#ddd;">Source #${currentStreams.length - idx}</span>
            </div>
            <div style="font-size:9px; color:#aaa; margin:2px 0; word-break:break-all;">${stream.url.substring(0, 35)}...</div>
            <div style="margin-top:2px">${badges}</div>
        `;
        listDiv.appendChild(div);
    });
}

function toggleOverlayVisibility() {
    const el = document.getElementById('hls-stats-overlay');
    if (!el) return;

    if (el.style.display === 'none') {
        el.style.display = 'block';
        updateStats();
        // Rafraîchir les stats vidéo (viewport, dimension) toutes les secondes
        updateInterval = setInterval(updateStats, 1000);
    } else {
        el.style.display = 'none';
        clearInterval(updateInterval);
    }
}

// GESTIONNAIRE DE MESSAGES
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // Cas 1 : Ouverture via Alt+S
    if (request.action === "toggleOverlay") {
        createOverlay();
        // On met à jour la liste avec celle reçue du background
        if (request.streams) currentStreams = request.streams;
        toggleOverlayVisibility();
    }

    // Cas 2 : Mise à jour LIVE (nouveau flux détecté pendant que c'est ouvert)
    if (request.action === "updateStreams") {
        if (request.streams) {
            currentStreams = request.streams;
            // Si l'overlay est ouvert, on rafraîchit la liste immédiatement
            const el = document.getElementById('hls-stats-overlay');
            if (el && el.style.display !== 'none') {
                renderStreamsList();
            }
        }
    }
});