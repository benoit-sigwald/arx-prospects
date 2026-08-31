# arx-prospects — Tissu Économique PACA

Consultation des entreprises et contacts du schéma Oracle `PROSPECTS` (ATP `arxdb01`),
et pont d'envoi d'un ciblage vers le séquenceur **Linki**.

- `GET /` — page, protégée par `DASH_TOKEN` (`?key=…` puis cookie d'hôte)
- `GET /api/stats` — compteurs par territoire, secteur, tranche d'effectif
- `GET /api/entreprises` — liste filtrable (`q`, `territoire`, `secteur`, `effmin`, `statut`, `tri`, `page`)
- `GET /api/entreprises/:id` — fiche + contacts rattachés + interactions
- `PATCH /api/entreprises/:id` — `{ statut, priorite, notes }`
- `GET /api/personnes` — recherche par nom (`q`, `origine`, `territoire`, `canal`, `tri`, `page`)
- `GET /api/appels` — file d'appel

## Pont vers Linki

Le bouton « Envoyer vers Linki » des écrans Entreprises et Personnes reprend le
filtre affiché et le pousse dans une liste Linki. Rien n'est recopié à la main.

- `GET  /api/listes` — les ciblages enregistrés (table `LISTE`)
- `POST /api/listes` — `{ nom, filtre }` : enregistre un ciblage
- `POST /api/listes/apercu` — `{ filtre }` : compte sans rien envoyer
- `POST /api/listes/envoyer` — `{ nom, filtre }` : construit le CSV et le dépose dans Linki

Le filtre porte sur `V_PERSONNES` : `source`, `canal`, `pays`, `ville`, `titre`,
`q`, `territoire`, `secteur`, `limite`. `LISTE` stocke le filtre, jamais les
lignes : un ciblage rejoué rend l'état du référentiel du jour, pas une photo.

Trois exclusions sont appliquées à chaque export, sans option :
opposition (`OPT_OUT`), absence de canal (Linki refuse une ligne sans e-mail ni
profil LinkedIn), et personnes déjà sollicitées ou ayant répondu — lues dans
l'instance Linki tant que `CONTACT_STATE` (étape 2) n'existe pas.

### Scripts

```
node scripts/creer-pont-linki.js [--appliquer]     GRANT + V_PERSONNES + LISTE (en ADMIN, conteneur gate)
node scripts/exporter-linki.js --source=investors --canal=email --limite=200
node scripts/exporter-linki.js --liste="Nom" --pousser
```

`creer-pont-linki.js` est rejouable : le relancer après la création d'un schéma
`GATE_*` régénère la vue avec sa branche.

## Variables d'environnement

`ORA_USER`, `ORA_PASSWORD`, `ORA_CONNECT`, `ORA_WALLET_DIR`, `ORA_WALLET_PASSWORD`,
`ORA_WALLET_B64`, `DASH_TOKEN`, `PORT`, `LINKI_BASE`
(défaut `http://arx-linki:3000/linki-awB4WDkPyeqWzWdh`).

Contient des données à caractère personnel : accès refusé sans jeton, réponses `no-store`,
page en `noindex`. Purge des contacts 36 mois après collecte (colonne virtuelle `PURGE_LE`).
