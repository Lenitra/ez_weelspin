# WeelSpin 🛰️

Roue de la fortune 100 % statique (personnes, récompenses, choix… tout ce qui se tire au sort) :
vanilla JS, zéro dépendance, zéro requête réseau. Segments dans le localStorage, export / import JSON.

## Lancer en local

Double-cliquez sur `src/index.html` — ça marche directement en `file://`.

## Construire

Lancez `build.bat`. Il produit deux choses :

- **`builds/weelspin.html`** — un **fichier HTML unique** (~109 Ko) : CSS, JS et favicon inclus.
  Copiez-le où vous voulez, envoyez-le par mail, ouvrez-le d'un double-clic. Rien d'autre à côté.
- `weelspin-dist.zip` — le contenu de `src/`, si vous préférez déployer les fichiers séparés.

## Déployer sur nginx

Déposez `builds/weelspin.html` dans le dossier servi (ex. `/var/www/weelspin/index.html`),
ou décompressez le zip dedans. Aucune configuration particulière.

Raccourcis : **Espace** pour lancer, ⛶ pour le mode présentation (TV).
