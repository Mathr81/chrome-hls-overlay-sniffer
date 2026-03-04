let tabStates = {}; // { tabId: { overlayVisible: false, videoStats: { width, height } } }

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.clear();
});

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove(tabId.toString());
    delete tabStates[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
      chrome.storage.local.remove(tabId.toString());
      tabStates[tabId] = { overlayVisible: false, videoStats: null };
  }
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
    const fallbackData = {
        url: url,
        levels: [{ resolution: "Protégé / Inconnu", bandwidth: "N/A" }],
        type: 'Unknown',
        timestamp: Date.now(),
        features: { drm: true, audio: false }
    };
    updateStorage(key, fallbackData, tabId);
  }
}

function updateStorage(key, newData, tabId) {
    chrome.storage.local.get([key], (result) => {
        let streams = result[key] || [];
        const existingIndex = streams.findIndex(s => s.url === newData.url);
        
        if (existingIndex !== -1) {
            streams[existingIndex] = { ...streams[existingIndex], ...newData };
            const item = streams.splice(existingIndex, 1)[0];
            streams.push(item);
        } else {
            streams.push(newData);
        }

        chrome.storage.local.set({ [key]: streams });
        chrome.action.setBadgeText({ text: streams.length.toString(), tabId: tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#FF0000", tabId: tabId });

        chrome.tabs.sendMessage(tabId, { action: "updateStreams", streams: streams }).catch(()=>{});
    });
}

function parseM3U8(content) {
  const lines = content.split('\n');
  const qualities = [];
  let isMaster = false;
  let hasEncryption = content.includes("#EXT-X-KEY");
  let hasAudio = content.includes("#EXT-X-MEDIA:TYPE=AUDIO");
  
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

  if (content.includes("#EXTINF")) {
      return { 
          levels: [{ resolution: "Flux Direct (Qualité Unique)", bandwidth: "Direct" }],
          isMaster: false, hasEncryption, hasAudio
      };
  }

  return { levels: [{ resolution: "Inconnu", bandwidth: "" }], isMaster: false, hasEncryption, hasAudio };
}

// Global state management
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-overlay") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if(tabs[0]) {
          const tabId = tabs[0].id;
          if (!tabStates[tabId]) tabStates[tabId] = { overlayVisible: false, videoStats: null };
          
          tabStates[tabId].overlayVisible = !tabStates[tabId].overlayVisible;
          
          chrome.storage.local.get([tabId.toString()], (res) => {
            chrome.tabs.sendMessage(tabId, { 
                action: "setVisibility", 
                visible: tabStates[tabId].overlayVisible,
                streams: res[tabId.toString()] || [],
                videoStats: tabStates[tabId].videoStats
            });
          });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "reportVideoStats") {
        const tabId = sender.tab.id;
        if (!tabStates[tabId]) tabStates[tabId] = { overlayVisible: false, videoStats: null };
        
        // Prioritize playing videos or larger videos
        if (!tabStates[tabId].videoStats || request.stats.playing || (request.stats.width * request.stats.height > tabStates[tabId].videoStats.width * tabStates[tabId].videoStats.height)) {
            tabStates[tabId].videoStats = request.stats;
            
            // Broadcast update if overlay is visible
            if (tabStates[tabId].overlayVisible) {
                chrome.tabs.sendMessage(tabId, { 
                    action: "updateVideoStats", 
                    videoStats: request.stats 
                }).catch(()=>{});
            }
        }
    }
    if (request.action === "getOverlayState") {
        const tabId = sender.tab.id;
        sendResponse({ 
            visible: tabStates[tabId] ? tabStates[tabId].overlayVisible : false,
            videoStats: tabStates[tabId] ? tabStates[tabId].videoStats : null
        });
    }
    return true; // Allow async sendResponse
});