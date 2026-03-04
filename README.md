# 🕵️‍♂️ HLS Quality Sniffer & Overlay

Une extension Chrome puissante pour les développeurs et les curieux du streaming. Elle intercepte les flux HLS (`.m3u8`), analyse la qualité vidéo réelle affichée par le navigateur et propose un mode "Stats for Nerds" en surimpression.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## ✨ Fonctionnalités

*   **Sniffer Réseau :** Détecte automatiquement les liens `.m3u8` (Master & Media Playlists).
*   **Analyseur de Qualité :** Affiche les variantes de résolutions disponibles (1080p, 720p, 4K...) et la bande passante.
*   **Détection Réelle Multi-Frames :** Analyse toutes les frames (iframes, embeds) pour extraire la résolution réelle du décodeur vidéo HTML5 (`<video>`).
*   **Overlay "Stats for Nerds" :**
    *   Compatible **Plein Écran** (s'injecte dynamiquement dans le contexte fullscreen).
    *   Draggable (déplaçable) avec mémorisation de l'état.
    *   Mise à jour en temps réel (détection automatique du changement de source).
    *   Calcul du DPI Scaling (pour les écrans Retina/HiDPI).
*   **Interface Intuitive :**
    *   **Copie Rapide** : Icônes dédiées pour copier l'URL du flux ou la commande FFmpeg.
    *   **Historique** : Garde une trace des flux détectés précédemment sur la page.

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
*   **Rendu** : Affiche la résolution de sortie réelle de la vidéo.
*   **Écran** : Affiche la résolution logique multipliée par le ratio de pixel de l'écran.

## 🛠️ Stack Technique

*   **Manifest V3** (Standard actuel de Chrome).
*   **Service Workers** (`background.js`) pour l'interception réseau.
*   **Content Scripts** (`content.js`) pour l'injection DOM et l'analyse du player `<video>`.
*   **Shadow DOM / Injection Directe** pour l'overlay.
*   Communication asynchrone via `chrome.runtime.sendMessage`.

## ⚠️ Avertissement

Cet outil est destiné à des fins éducatives et de débogage pour analyser les flux vidéo. L'auteur n'est pas responsable de l'utilisation faite sur des contenus protégés par des droits d'auteur.