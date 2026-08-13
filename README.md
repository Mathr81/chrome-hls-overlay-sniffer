# 🕵️‍♂️ HLS Quality Sniffer & Overlay

Une extension Chrome puissante pour les développeurs et les curieux du streaming. Elle intercepte les flux HLS (`.m3u8`), analyse la qualité vidéo réelle affichée par le navigateur et propose un mode "Stats for Nerds" en surimpression.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## ✨ Fonctionnalités

### 📊 Mesure du bitrate (3 sources croisées)

| Mesure | Source | Ce qu'elle dit |
|---|---|---|
| **Bitrate lu** | Compteurs du décodeur Blink (`webkitVideoDecodedByteCount` / `webkitAudioDecodedByteCount`) | Le débit réel du média en cours de décodage, vidéo et audio séparés. Indépendant du réseau. |
| **Débit réseau** | `webRequest`, taille des segments sur une fenêtre glissante de 8 s | Ce qui transite réellement sur le fil, octets répartis sur la durée réelle de chaque transfert. |
| **Débit déclaré** | `BANDWIDTH` / `AVERAGE-BANDWIDTH` du manifest | Ce que le serveur annonce pour la variante actuellement lue. |

L'overlay affiche le bitrate lu en grand, avec un **graphe glissant sur 60 secondes**, et retombe automatiquement sur la mesure réseau quand les compteurs du décodeur sont indisponibles (contenu DRM/EME).

### 🔍 Analyse des flux

*   **Sniffer réseau :** détecte automatiquement les liens `.m3u8` (Master & Media Playlists).
*   **Variantes détaillées :** résolution, bitrate, FPS déclaré et codecs de chaque qualité, triées par débit. La variante réellement lue est repérée par un `▶` et surlignée.
*   **Codecs lisibles :** `avc1.640028` devient `H.264 High@L4.0`, `hvc1…` devient `HEVC`, `ec-3` devient `Dolby Digital+` (AV1, VP9, Dolby Vision, Opus, FLAC… également reconnus).
*   **Live vs VOD :** détection via `#EXT-X-ENDLIST` / `#EXT-X-PLAYLIST-TYPE`, avec durée totale et **estimation du poids** d'un téléchargement complet.
*   **Chiffrement :** distingue le vrai **DRM** (Widevine / FairPlay / PlayReady) du simple **AES-128** à clé en clair.
*   **Pistes audio & sous-titres :** nombre de pistes et langues déclarées.

### 🎛️ Stats de lecture

*   Résolution rendue par le décodeur + résolution physique de l'écran (DPI scaling Retina/HiDPI).
*   **FPS mesuré** et **images perdues** (`getVideoPlaybackQuality`), colorées en rouge au-delà de 1 %.
*   **Santé du buffer** en secondes d'avance, colorée selon le risque de coupure.
*   Volume total téléchargé sur l'onglet.

### 🖥️ Overlay "Stats for Nerds"

*   Compatible **plein écran** (s'injecte dynamiquement dans le contexte fullscreen).
*   **Déplaçable**, avec mémorisation de la position et du mode réduit d'une session à l'autre.
*   Mode **compact** (bouton `–`) qui ne garde que le bitrate et son graphe.
*   Sélection intelligente de la vidéo : privilégie celle en lecture, puis la plus grande, sur toutes les frames (iframes, embeds).

### 📋 Export

*   **Copie rapide** : URL du flux, commande **FFmpeg** ou commande **yt-dlp** (avec le `Referer` de la page, indispensable sur la plupart des CDN).
*   **Clic sur une variante** dans le popup : copie l'URL directe de cette qualité précise.
*   **Export JSON** de tous les flux détectés et de l'état du lecteur.
*   **Historique** des flux détectés précédemment sur la page.

## 🚀 Installation

1.  Clonez ce dépôt ou téléchargez le ZIP.
2.  Ouvrez Chrome et allez sur `chrome://extensions/`.
3.  Activez le **Mode développeur** (en haut à droite).
4.  Cliquez sur **Charger l'extension non empaquetée**.
5.  Sélectionnez le dossier du projet.

## 🎮 Utilisation

### Via l'Overlay (Raccourci)
*   Appuyez sur **`Alt + S`** (Option + S sur Mac) à tout moment.
*   Une fenêtre translucide apparaîtra par-dessus la vidéo (même en plein écran).
*   **Icônes d'action** :
    *   📋 : Copie l'URL directe du flux `.m3u8`.
    *   💻 : Copie la commande `ffmpeg` pour enregistrer le flux.
    *   ⬇️ : Copie la commande `yt-dlp` équivalente.
*   **Rendu** : Affiche la résolution de sortie réelle de la vidéo.
*   **Écran** : Affiche la résolution logique multipliée par le ratio de pixel de l'écran.
*   Glissez l'en-tête pour déplacer la fenêtre, `–` pour la réduire au seul bitrate.

### Lire les mesures

Sur un flux HLS qui se comporte normalement, les trois bitrates convergent : le player
ne télécharge qu'au fur et à mesure, donc **débit réseau ≈ bitrate lu ≈ débit déclaré**.
Les écarts sont informatifs :

*   **Réseau ≫ lu** : le player remplit son buffer en avance, ou la page télécharge autre chose.
*   **Lu ≪ déclaré** : le player est descendu sur une variante inférieure (bande passante ou CPU).
*   **Buffer qui fond + images perdues** : la connexion ou le décodeur ne suit pas.

## 🛠️ Stack Technique

*   **Manifest V3** (Standard actuel de Chrome).
*   **Service Workers** (`background.js`) pour l'interception réseau et la mesure du débit.
*   **Content Scripts** (`content.js`) pour l'injection DOM et l'échantillonnage du player `<video>`.
*   **Injection directe** pour l'overlay, `<canvas>` pour le graphe de bitrate.
*   Communication asynchrone via `chrome.runtime.sendMessage`.
*   `chrome.storage.session` pour que l'état de l'overlay survive à la mise en veille du service worker.

### Notes d'implémentation

*   Le débit réseau répartit les octets de chaque requête sur sa **durée réelle de transfert**
    (`onResponseStarted` → `onCompleted`) au lieu de les compter d'un bloc à l'arrivée : sans ça,
    un gros segment produit un pic de plusieurs centaines de Mb/s.
*   Le dénominateur est toujours la fenêtre complète de 8 s. La mesure monte donc
    progressivement pendant les 8 premières secondes plutôt que d'afficher un pic irréaliste.
*   Les manifests ne sont re-téléchargés qu'une fois toutes les 30 s : une playlist live est
    rafraîchie en boucle par le player, et la re-parser à chaque fois était inutile.
*   Le popup réutilise l'échantillonneur du content script via `window.__hlsSnifferGetStats`
    (`chrome.scripting.executeScript` s'exécute dans le même monde isolé), ce qui évite de
    recalculer des deltas à part.

## ⚠️ Avertissement

Cet outil est destiné à des fins éducatives et de débogage pour analyser les flux vidéo. L'auteur n'est pas responsable de l'utilisation faite sur des contenus protégés par des droits d'auteur.