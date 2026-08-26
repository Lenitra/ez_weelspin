# WeelSpin 🎡

Roue de la fortune 100 % statique : vanilla JS, zéro dépendance, zéro requête réseau.
Configuration (segments) dans le localStorage, avec export / import JSON.

## Lancer en local

Double-cliquez sur `src/index.html` — ça marche directement en `file://`.

## Déployer sur nginx

1. Lancez `build.bat` → génère `weelspin-dist.zip`.
2. Décompressez le zip dans le dossier servi, ex. `/var/www/weelspin/`.
3. C'est tout : aucun build, aucune config nginx particulière.

Raccourcis : **Espace** pour lancer, bouton ⛶ pour le mode présentation (TV).
