let detectedStreams = {}; // { tabId: [stream1, stream2] }

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.clear();
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.local.remove(tabId.toString()));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') chrome.storage.local.remove(tabId.toString());
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes(".m3u8")) {
      fetchAndParseM3U8(details.url, details.tabId);
    }
  },
  { urls: ["<all_urls>"] }
);

async function fetchAndParseM3U8(url, tabId) {
  if (tabId === -1) return;
  const key = tabId.toString();

  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error("Auth/Network");
    const text = await response.text();
    
    // Analyse approfondie
    const { levels, isMaster, hasEncryption, hasAudio } = parseM3U8(text);
    
    const streamData = {
      url: url,
      levels: levels,
      type: isMaster ? 'Master' : 'Stream',
      timestamp: Date.now(),
      features: { drm: hasEncryption, audio: hasAudio }
    };

    updateStorage(key, streamData, tabId);

  } catch (error) {
    // En cas d'échec (protection), on ajoute quand même l'entrée
    const fallbackData = {
        url: url,
        levels: [{ resolution: "Protégé / Inconnu", bandwidth: "N/A" }],
        type: 'Unknown',
        timestamp: Date.now(),
        features: { drm: true, audio: false } // On suppose DRM si échec lecture
    };
    updateStorage(key, fallbackData, tabId);
  }
}

function updateStorage(key, newData, tabId) {
    chrome.storage.local.get([key], (result) => {
        let streams = result[key] || [];
        
        // --- ANTI DOUBLON ---
        const existingIndex = streams.findIndex(s => s.url === newData.url);
        
        if (existingIndex !== -1) {
            // Mise à jour : on remplace l'ancien seulement si le nouveau a des infos
            // Ou on met à jour le timestamp pour dire "c'est le dernier vu"
            streams[existingIndex] = { ...streams[existingIndex], ...newData };
            
            // On le déplace à la fin (le plus récent)
            const item = streams.splice(existingIndex, 1)[0];
            streams.push(item);
        } else {
            streams.push(newData);
        }

        chrome.storage.local.set({ [key]: streams });
        chrome.action.setBadgeText({ text: streams.length.toString(), tabId: tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#FF0000", tabId: tabId });

        // Update Live
        chrome.tabs.sendMessage(tabId, { action: "updateStreams", streams: streams }).catch(()=>{});
    });
}

function parseM3U8(content) {
  const lines = content.split('\n');
  const qualities = [];
  let isMaster = false;
  let hasEncryption = content.includes("#EXT-X-KEY"); // Détection DRM
  let hasAudio = content.includes("#EXT-X-MEDIA:TYPE=AUDIO"); // Pistes Audio
  
  lines.forEach(line => {
    if (line.includes('#EXT-X-STREAM-INF')) {
      isMaster = true;
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

  if (isMaster && qualities.length > 0) {
    return { 
        levels: qualities.sort((a, b) => parseInt(b.resolution.split('x')[0]) - parseInt(a.resolution.split('x')[0])),
        isMaster: true, hasEncryption, hasAudio
    };
  }

  // Si pas de master playlist, c'est un flux direct
  if (content.includes("#EXTINF")) {
      return { 
          levels: [{ resolution: "Flux Direct (Qualité Unique)", bandwidth: "Direct" }],
          isMaster: false, hasEncryption, hasAudio
      };
  }

  return { levels: [{ resolution: "Inconnu", bandwidth: "" }], isMaster: false, hasEncryption, hasAudio };
}

// Raccourci Clavier
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-overlay") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if(tabs[0]) {
          chrome.storage.local.get([tabs[0].id.toString()], (res) => {
            chrome.tabs.sendMessage(tabs[0].id, { 
                action: "toggleOverlay", 
                streams: res[tabs[0].id.toString()] || [] 
            });
          });
      }
    });
  }
});