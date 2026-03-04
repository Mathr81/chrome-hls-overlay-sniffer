document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  
  const key = tab.id.toString();
  const resElement = document.getElementById('player-res');
  const statusElement = document.getElementById('player-status');
  const container = document.getElementById('content');

  // ---------------------------------------------------------
  // GESTION DU BOUTON NETTOYER
  // ---------------------------------------------------------
  document.getElementById('clear-btn').addEventListener('click', () => {
      chrome.storage.local.remove(key, () => {
          location.reload(); 
          chrome.action.setBadgeText({ text: "", tabId: tab.id });
      });
  });

  // ---------------------------------------------------------
  // CAS SPÉCIAL : LECTEUR EXTENSION (HLS Player, Native HLS...)
  // ---------------------------------------------------------
  if (tab.url.startsWith('chrome-extension://')) {
      resElement.innerText = "Mode Extension";
      resElement.style.fontSize = "16px";
      statusElement.innerText = "Lecture de la résolution écran bloquée par sécurité.";
      
      // On essaie de récupérer le lien m3u8 depuis l'URL (après le #)
      if (tab.url.includes('#http')) {
          const directLink = tab.url.split('#')[1];
          // On affiche directement ce lien sans passer par le background
          fetchAndDisplayManual(directLink, container);
          return; // On arrête ici pour ce mode
      }
  } 
  
  // ---------------------------------------------------------
  // CAS STANDARD : SITE WEB NORMAL
  // ---------------------------------------------------------
  else {
      // 1. Tenter de lire la résolution réelle
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: () => {
            const v = document.querySelector('video');
            return v && v.videoWidth > 0 ? { found: true, w: v.videoWidth, h: v.videoHeight } : { found: false };
          }
        });

        const videoData = results.find(r => r.result && r.result.found)?.result;

        if (videoData) {
            const { w, h } = videoData;
            resElement.innerText = `${w} x ${h}`;
            
            let label = "SD";
            if (w >= 3800 || h >= 2100) { label = "4K UHD"; resElement.style.color = "#9C27B0"; } 
            else if (w >= 1900 || h >= 1000) { label = "Full HD 1080p"; resElement.style.color = "#2e7d32"; }
            else if (w >= 1200 || h >= 700) { label = "HD 720p"; resElement.style.color = "#1976D2"; }
            
            statusElement.innerText = `Rendu réel (${label})`;
        } else {
            resElement.innerText = "-";
            statusElement.innerText = "Pas de lecture active";
        }
      } catch (e) {
        statusElement.innerText = "Accès à la vidéo restreint";
      }

      // 2. Afficher les flux réseaux détectés par background.js
      chrome.storage.local.get([key], (result) => {
        const streams = result[key];
        displayStreams(streams, container);
      });
  }
});

// --- Fonctions utilitaires ---

// Affiche la liste des streams stockés
function displayStreams(streams, container) {
    container.innerHTML = '';
    if (!streams || streams.length === 0) {
      container.innerHTML = '<div class="no-stream">Aucun flux détecté.<br>Lancez la vidéo.</div>';
      return;
    }

    const reversedStreams = [...streams].reverse();
    reversedStreams.forEach((stream, index) => {
      createStreamCard(stream, streams.length - index, container);
    });
    
    setupCopyButtons();
}

// Pour le mode extension : Fetch manuel du lien dans l'URL
async function fetchAndDisplayManual(url, container) {
    container.innerHTML = '<div class="no-stream">Analyse du lien dans l\'URL...</div>';
    
    try {
        const response = await fetch(url);
        const text = await response.text();
        const levels = parseM3U8Content(text);
        
        container.innerHTML = '';
        createStreamCard({ url: url, levels: levels }, 1, container);
        setupCopyButtons();
        
    } catch (e) {
        container.innerHTML = '<div class="no-stream">Lien trouvé mais illisible (CORS/Auth).<br>' + url.substring(0,30) + '...</div>';
    }
}

// Création HTML d'une carte
function createStreamCard(stream, index, container) {
    const div = document.createElement('div');
    div.className = 'stream-container';

    let qualitiesHtml = '';
    stream.levels.forEach(level => {
        let color = '#555';
        if (level.resolution.includes('Direct')) color = '#E91E63';
        else if (level.resolution.includes('1920') || level.resolution.includes('1080')) color = '#2e7d32';
        
        qualitiesHtml += `<span class="badge" style="background:${color}">${level.resolution}</span> `;
    });

    div.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <strong style="color:#333;">Flux #${index}</strong>
        <button class="copy-btn" data-url="${stream.url}">Copier</button>
    </div>
    <div class="url" title="${stream.url}">${stream.url.substring(0, 40)}...</div>
    <div style="margin-top:4px;">${qualitiesHtml}</div>
    `;
    container.appendChild(div);
}

// Parsing du texte M3U8 (dupliqué ici pour être autonome dans le popup)
function parseM3U8Content(content) {
    const lines = content.split('\n');
    const qualities = [];
    let isMasterPlaylist = false;

    lines.forEach(line => {
        if (line.includes('#EXT-X-STREAM-INF')) {
            isMasterPlaylist = true;
            const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
            if (resMatch) qualities.push({ resolution: resMatch[1] });
        }
    });

    if (isMasterPlaylist && qualities.length > 0) {
        return qualities.sort((a, b) => parseInt(b.resolution.split('x')[0]) - parseInt(a.resolution.split('x')[0]));
    }
    if (content.includes("#EXTINF")) {
        return [{ resolution: "Flux Direct (Media Playlist)" }];
    }
    return [{ resolution: "Inconnu" }];
}

function setupCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        navigator.clipboard.writeText(e.target.dataset.url);
        const originalText = e.target.innerText;
        e.target.innerText = "✓";
        setTimeout(() => e.target.innerText = originalText, 1000);
      });
    });
}