# Prompt — Weelspin (roue de la fortune configurable)

## Contexte

Je veux un **front statique pur** : une roue de la fortune (wheel spin) configurable,
utilisable par moi et partagée à des collègues. Elle sera déposée par simple
glisser-déposer dans un dossier servi par **nginx**. Aucun backend, aucun compte,
aucune base de données.

La configuration (les segments) vit dans le **localStorage** du navigateur, avec
**export / import JSON**.

**Le plus important : il faut un MAXIMUM DE JUICE et un MAXIMUM D'EFFETS
VISUELS.** Ce n'est pas un utilitaire sobre, c'est un objet spectaculaire qui doit
donner envie de relancer. Voir la section « Le juice » plus bas : c'est le cœur
du travail, pas une finition optionnelle.

## Livrables attendus

```
weelspin/
├── src/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── favicon.svg
├── build.bat          # crée weelspin-dist.zip à partir de src/
└── README.md          # 15 lignes max : lancer en local, déployer sur nginx
```

- `build.bat` (Windows, via PowerShell `Compress-Archive`) produit
  `weelspin-dist.zip` contenant **le contenu de `src/`** (pas le dossier `src`
  lui-même), prêt à être décompressé dans `/var/www/<quelque-chose>/`.
- **Aucune étape de build n'est nécessaire pour que ça marche** : `src/` est
  directement déployable tel quel. Le `.bat` ne fait que zipper.

## Contraintes techniques (non négociables)

- **Vanilla JS** (ES2020+), aucun framework, aucun bundler, aucun `npm install`.
- **Zéro dépendance externe** : pas de CDN, pas de Google Fonts, pas de requête
  réseau au runtime. L'app doit fonctionner **hors ligne**, et aussi en `file://`
  (double-clic sur `index.html`).
- **Zéro asset binaire** : sons générés à la volée en **Web Audio API**, confettis
  dessinés en canvas, icônes en **SVG inline**, polices = stacks système
  (`system-ui, -apple-system, Segoe UI, Roboto, sans-serif`).
- **Chemins relatifs uniquement** (`./styles.css`), pour que ça marche aussi dans
  un sous-dossier (`https://serveur/outils/weelspin/`).
- Rendu de la roue en **Canvas 2D**, avec gestion du `devicePixelRatio` (net sur
  écran Retina **et** sur TV 4K).
- Navigateurs cibles : Chrome / Edge / Firefox / Safari récents, desktop + mobile.
- Interface en **français**.
- Code commenté sobrement, lisible, découpé en sections claires.

## Modèle de données

Un seul objet persisté, **rien d'autre** :

```json
{
  "app": "weelspin",
  "version": 1,
  "segments": [
    { "id": "s1", "label": "Alice",   "color": "#e4572e", "weight": 1 },
    { "id": "s2", "label": "Bob",     "color": "#17bebb", "weight": 3 },
    { "id": "s3", "label": "Charlie", "color": "#ffc914", "weight": 1 }
  ]
}
```

- `label` : texte libre (peut contenir des emojis).
- `color` : couleur hex du segment.
- `weight` : nombre > 0. **L'angle du segment est proportionnel au poids** :
  `angle = weight / somme(weights) × 360°`. Poids plus élevé = part plus grande =
  plus de chances. Le pourcentage réel est affiché à côté de chaque segment dans
  l'éditeur.
- Clé localStorage : `weelspin.segments.v1`. **Le localStorage ne stocke que ça** :
  pas d'historique, pas de préférences UI (sauf éventuellement l'état « muet » du
  son, dans une clé séparée, si tu juges ça utile).
- Le champ `version` sert à la compatibilité future : à l'import, si la version est
  inconnue, refuser proprement avec un message clair.

## Fonctionnalités

### La roue

- Occupe la place maximale disponible, toujours ronde, jamais coupée.
- Chaque segment : couleur de fond, libellé lisible (texte radial, taille
  auto-ajustée, ellipse `…` si trop long, couleur de texte noir/blanc calculée
  automatiquement selon le contraste du fond).
- Curseur / pointeur fixe **en haut**.
- Moyeu central cliquable (« SPIN »).
- **Pas de maximum de segments** : ça doit rester correct avec 2 comme avec 200
  (au-delà d'un certain seuil, masquer les libellés devenus trop petits plutôt que
  de produire une bouillie illisible).
- 0 segment → état vide élégant avec appel à l'action.

### Le tirage

- Déclenchement : clic sur la roue / le moyeu, bouton « Lancer », touche `Espace`.
- Tirage **honnête** : on tire d'abord le gagnant au hasard, pondéré par les poids
  (`crypto.getRandomValues`), puis on calcule l'angle final pour que le pointeur
  tombe dessus, avec un offset aléatoire à l'intérieur du segment (pas pile au
  centre). Pas de mode « résultat forcé », pas de triche.
- Durée et easing **fixes, non configurables** par l'utilisateur : ~5–6 s,
  démarrage sec, longue décélération type `easeOutQuint`, plusieurs tours.
- Pendant le spin, tout est verrouillé : pas de double lancement, pas d'édition.
- Le gagnant **reste dans la roue** : pas d'élimination, pas d'anti-répétition,
  pas d'historique.

### Le « juice » — LE POINT LE PLUS IMPORTANT DU PROJET

> **IL FAUT UN MAXIMUM DE JUICE ET UN MAXIMUM D'EFFETS VISUELS.**
> C'est le critère numéro un. Une roue qui tourne correctement mais qui est fade
> est un échec. Si tu dois arbitrer entre « sobre et propre » et « spectaculaire »,
> choisis **toujours** spectaculaire. N'auto-censure pas tes idées d'effets : mieux
> vaut trop que pas assez, j'enlèverai si c'est excessif.

Objectif : **un maximum de dopamine**, que ça donne envie de relancer en boucle.
La liste ci-dessous est un **plancher, pas un plafond** — ajoute tout ce qui te
passe par la tête en plus. Seule limite : rester à 60 fps.

**Effets visuels attendus (minimum) :**

- Fond animé vivant : dégradé qui respire, lueurs qui dérivent, vignettage,
  particules d'ambiance en arrière-plan même à l'arrêt.
- La roue **n'est jamais statique** : au repos elle flotte, respire, ses reflets
  glissent, le moyeu pulse doucement pour appeler le clic.
- Reflets et matière sur la roue : dégradés par segment, biseaux, ombre portée
  profonde, anneau métallique/néon autour, spéculaire qui suit la rotation.
- Traînée / motion blur pendant la vitesse maximale, étincelles projetées par le
  pointeur à chaque tick.
- Le pointeur **claque** (rotation élastique) à chaque passage de segment, avec
  une petite onde de choc.
- **Suspense en fin de course** : ralentissement très marqué sur les derniers
  degrés, halo qui pulse de plus en plus fort, flash sur chaque segment survolé,
  léger zoom caméra vers la roue, assombrissement progressif du décor.
- À l'arrivée, tout part en fanfare : **screen shake**, **flash plein écran**,
  **explosion de confettis** (plusieurs vagues, formes variées, gravité et
  rotation réalistes), onde de choc circulaire, rayons lumineux qui partent du
  segment gagnant, particules dorées qui retombent.
- Le segment gagnant est **glorifié** : sur-brillance, zoom, contour lumineux
  animé, le reste de la roue s'assombrit et se désature.
- Modale / bandeau de résultat : entrée en `scale + bounce` élastique, texte avec
  effet de brillance qui balaie, bordure animée, bouton « Relancer » qui appelle
  le clic.
- Micro-interactions partout : chaque bouton a un `hover`, un `active`, un
  ripple ; chaque ajout/suppression de segment est animé (pas d'apparition sèche) ;
  les transitions de layout sont fluides.

**Effets sonores et haptiques :**

- Son de « tick » à chaque passage de segment sous le pointeur, dont le **pitch et
  le tempo suivent la vitesse** (Web Audio : oscillateur court + enveloppe).
- Montée sonore de tension pendant le ralentissement final.
- Jingle de victoire à l'arrivée (accord arpégé Web Audio), plus un « whoosh » au
  départ du spin.
- Petits sons discrets sur les interactions de l'éditeur (ajout, suppression).
- Vibration sur mobile (`navigator.vibrate`) au tick fort et à la victoire.
- Bouton **mute** bien visible. L'`AudioContext` ne peut être créé qu'après une
  interaction utilisateur : respecte les politiques d'autoplay.

**Rythme du spin :**

- Micro-recul / anticipation avant le départ, puis accélération franche, longue
  décélération, et faux suspense sur la toute fin.

**Seul garde-fou :**

- Respecter `prefers-reduced-motion` : version dégradée sobre (spin court, pas de
  shake, pas de confettis) sans casser la fonctionnalité. C'est la **seule**
  situation où on lève le pied sur les effets.

### L'éditeur de segments

Design libre, je te fais confiance sur la forme. Ce qui doit être possible :

- Ajouter / modifier / supprimer un segment (libellé, couleur, poids).
- Poids réglable (slider et/ou champ numérique) avec **le % réel affiché en direct**.
- Couleur : palette auto-attribuée à la création (couleurs bien réparties et
  distinctes, ex. angle d'or en HSL) + override manuel via `<input type="color">`.
- **Saisie rapide en masse** : une zone de texte « un libellé par ligne » pour
  coller depuis Excel / Notepad et générer tous les segments d'un coup.
- Réordonner, dupliquer, mélanger, tout supprimer (avec confirmation).
- Sauvegarde **automatique** dans le localStorage à chaque modification (debounce).
- Au tout premier lancement : roue d'exemple pré-remplie (5–6 segments), pour que
  l'app ne soit jamais vide au premier contact.
- Panneau d'édition **masquable**, plus un **mode présentation / plein écran** où
  il ne reste que la roue (réunion, TV).

### Export / Import JSON

- **Export** : bouton qui télécharge un `.json` (Blob + `URL.createObjectURL`),
  nommé `weelspin-AAAA-MM-JJ.json`, contenant exactement le modèle ci-dessus.
- **Import** : bouton fichier **et** glisser-déposer du `.json` n'importe où sur la
  page.
- L'import **remplace** la configuration courante, avec **confirmation explicite**
  avant écrasement.
- Validation stricte : JSON invalide, structure inattendue, poids ≤ 0, couleur
  malformée → message d'erreur clair et lisible, et **aucune casse de l'état
  existant**.

### Responsive & accessibilité

- Doit être parfait sur **téléphone, tablette, PC et TV** :
  - mobile portrait : roue en haut, éditeur dans un panneau qui remonte du bas ;
  - desktop : roue au centre / à gauche, éditeur en colonne latérale ;
  - TV et très grand écran : tout grossit proportionnellement (pas d'UI minuscule
    perdue dans un coin) — le mode présentation est fait pour ça.
- Zones tactiles ≥ 44 px, aucune action qui dépende du `hover`.
- Navigation clavier complète, `focus-visible` visible, libellés `aria-*` sur les
  contrôles, résultat annoncé en `aria-live`.
- Thème sombre par défaut (plus flatteur pour les couleurs et le glow), contrastes
  conformes.

## Hors périmètre — ne le fais pas

- Pas de backend, pas d'API, pas de compte, pas d'analytics.
- Pas d'historique des tirages, pas de statistiques.
- Pas de mode élimination, pas d'anti-répétition, pas de résultat truqué.
- Pas de roues multiples / profils : **une seule roue**.
- Pas de partage par URL, pas d'impression, pas d'i18n.
- Pas de framework, pas de `package.json`, pas de TypeScript, pas de tests.

## Critères d'acceptation

- [ ] Je décompresse `weelspin-dist.zip` dans un dossier nginx, je charge la page :
      ça fonctionne, aucune erreur console, aucune requête réseau sortante.
- [ ] Double-clic sur `src/index.html` (`file://`) : ça fonctionne aussi.
- [ ] Je modifie les segments, je recharge la page (F5) : mes segments sont là.
- [ ] J'exporte, je vide tout, je réimporte : je retrouve exactement mes segments.
- [ ] Un segment de poids 3 est visiblement 3× plus large qu'un segment de poids 1,
      et son pourcentage affiché est correct.
- [ ] Sur 200 tirages, la répartition des gagnants suit les poids.
- [ ] Testé à 2 segments, à ~20 et à ~200 sans casse de mise en page.
- [ ] Le spin est fluide (60 fps) sur mobile, malgré tous les effets.
- [ ] **Rien n'est statique à l'écran** : même au repos, ça bouge et ça respire.
- [ ] Un spectateur qui regarde par-dessus mon épaule dit « wow » et veut essayer.
- [ ] Ça donne envie de relancer, encore et encore.

## Méthode

Commence par me proposer en 10 lignes ta structure de fichiers et tes choix clés
(easing, génération des sons, layout responsive), puis implémente d'un bloc.
Ne me pose des questions que si quelque chose est réellement bloquant.
