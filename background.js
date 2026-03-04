// Stockage temporaire
let detectedStreams = {};

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.local.remove(tabId.toString()));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') chrome.storage.local.remove(tabId.toString());
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // On ignore les requêtes qui ne sont pas des m3u8
    if (details.url.includes(".m3u8")) {
      fetchAndParseM3U8(details.url, details.tabId);
    }
  },
  { urls: ["<all_urls>"] }
);

async function fetchAndParseM3U8(url, tabId) {
  if (tabId === -1) return;

  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error("Network/Auth error");
    const text = await response.text();
    const levels = parseM3U8(text);
    
    const streamData = { url: url, levels: levels };
    const key = tabId.toString();

    chrome.storage.local.get([key], (result) => {
      let streams = result[key] || [];
      
      if (!streams.find(s => s.url === url)) {
        streams.push(streamData);
        chrome.storage.local.set({ [key]: streams });
        
        chrome.action.setBadgeText({ text: streams.length.toString(), tabId: tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#FF0000", tabId: tabId });

        // === NOUVEAU : ENVOI DIRECT À L'OVERLAY ===
        // On prévient l'onglet qu'il y a une nouveauté pour qu'il l'affiche tout de suite
        chrome.tabs.sendMessage(tabId, { 
            action: "updateStreams", 
            streams: streams 
        }).catch(() => { /* Ignorer si l'onglet n'est pas prêt */ });
      }
    });

  } catch (error) {
    // En cas d'erreur (flux protégé), on sauvegarde quand même
    saveFallbackStream(url, tabId);
  }
}

function saveFallbackStream(url, tabId) {
  const key = tabId.toString();
  chrome.storage.local.get([key], (result) => {
    let streams = result[key] || [];
    if (!streams.find(s => s.url === url)) {
      streams.push({
        url: url,
        levels: [{ resolution: "Flux détecté (Protégé)", bandwidth: "N/A" }]
      });
      chrome.storage.local.set({ [key]: streams });
      chrome.action.setBadgeText({ text: "!", tabId: tabId });
      
      // Envoi direct
      chrome.tabs.sendMessage(tabId, { action: "updateStreams", streams: streams }).catch(()=>{});
    }
  });
}

function parseM3U8(content) {
  const lines = content.split('\n');
  const qualities = [];
  let isMasterPlaylist = false;

  lines.forEach(line => {
    if (line.includes('#EXT-X-STREAM-INF')) {
      isMasterPlaylist = true;
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      const bandMatch = line.match(/BANDWIDTH=(\d+)/);
      
      if (resMatch) {
        qualities.push({
          resolution: resMatch[1],
          bandwidth: bandMatch ? `${Math.round(bandMatch[1] / 1024)} kbps` : ''
        });
      }
    }
  });

  // Si on a trouvé des qualités, on les retourne triées
  if (isMasterPlaylist && qualities.length > 0) {
    return qualities.sort((a, b) => {
      const hA = parseInt(a.resolution.split('x')[1]);
      const hB = parseInt(b.resolution.split('x')[1]);
      return hB - hA;
    });
  }

  // Si c'est un Master mais sans RESOLUTION explicite (rare mais possible)
  if (isMasterPlaylist && qualities.length === 0) {
     return [{ resolution: "Master Playlist (Info manquante)", bandwidth: "Auto" }];
  }

  // Si on voit #EXTINF, c'est une "Media Playlist" (flux direct .ts)
  // Le fichier m3u8 contient directement les morceaux de vidéo, pas les résolutions.
  if (content.includes("#EXTINF")) {
    return [{ resolution: "Flux Direct (Qualité Unique)", bandwidth: "Media Playlist" }];
  }

  return [{ resolution: "Format inconnu", bandwidth: "?" }];
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-overlay") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs[0];
      if (!currentTab) return;
      
      const tabId = currentTab.id.toString();

      // On récupère les streams pour les envoyer à l'ouverture
      chrome.storage.local.get([tabId], (result) => {
        const streams = result[tabId] || [];
        chrome.tabs.sendMessage(currentTab.id, { 
          action: "toggleOverlay", 
          streams: streams 
        });
      });
    });
  }
});