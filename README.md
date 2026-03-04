# 🕵️‍♂️ HLS Quality Sniffer & Overlay

Une extension Chrome puissante pour les développeurs et les curieux du streaming. Elle intercepte les flux HLS (`.m3u8`), analyse la qualité vidéo réelle affichée par le navigateur et propose un mode "Stats for Nerds" en surimpression.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## ✨ Fonctionnalités

*   **Sniffer Réseau :** Détecte automatiquement les liens `.m3u8` (Master & Media Playlists).
*   **Analyseur de Qualité :** Affiche les variantes de résolutions disponibles (1080p, 720p, 4K...) et la bande passante.
*   **Détection Réelle :** Injecte un script pour lire la résolution de décodage du lecteur HTML5 (`<video>`) afin de vérifier si vous regardez vraiment du 1080p ou un flux upscalé.
*   **Overlay "Stats for Nerds" :**
    *   Compatible **Plein Écran** (s'injecte dans le contexte fullscreen).
    *   Draggable (déplaçable).
    *   Mise à jour en temps réel.
    *   Calcul du DPI Scaling (pour les écrans Retina/HiDPI).
*   **Support Iframes :** Scanne toutes les frames de la page pour trouver les lecteurs cachés (ex: embeds de streaming).

## 🚀 Installation

Cette extension n'est pas encore sur le Chrome Web Store. Pour l'installer :

1.  Clonez ce dépôt ou téléchargez le ZIP.
2.  Ouvrez Chrome et allez sur `chrome://extensions/`.
3.  Activez le **Mode développeur** (en haut à droite).
4.  Cliquez sur **Charger l'extension non empaquetée**.
5.  Sélectionnez le dossier du projet.

## 🎮 Utilisation

### Via le Popup
Cliquez sur l'icône de l'extension pour voir :
*   La résolution affichée à l'écran.
*   La liste des flux `.m3u8` capturés.
*   Copier les liens en un clic.

### Via l'Overlay (Raccourci)
*   Appuyez sur **`Alt + S`** (Option + S sur Mac) à tout moment.
*   Une fenêtre translucide apparaîtra par-dessus la vidéo (même en plein écran).
*   Elle affiche les stats techniques et la liste des flux en direct.

## 🛠️ Stack Technique

*   **Manifest V3** (Standard actuel de Chrome).
*   **Service Workers** (`background.js`) pour l'interception réseau.
*   **Content Scripts** (`content.js`) pour l'injection DOM et l'analyse du player `<video>`.
*   **Shadow DOM / Injection Directe** pour l'overlay.
*   Communication asynchrone via `chrome.runtime.sendMessage`.

## ⚠️ Avertissement

Cet outil est destiné à des fins éducatives et de débogage pour analyser les flux vidéo. L'auteur n'est pas responsable de l'utilisation faite sur des contenus protégés par des droits d'auteur.