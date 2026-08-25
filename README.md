# arx-prospects — Tissu Économique PACA

Consultation des entreprises et contacts du schéma Oracle `PROSPECTS` (ATP `arxdb01`).

- `GET /` — page, protégée par `DASH_TOKEN` (`?key=…` puis cookie d'hôte)
- `GET /api/stats` — compteurs par territoire, secteur, tranche d'effectif
- `GET /api/entreprises` — liste filtrable (`q`, `territoire`, `secteur`, `effmin`, `statut`, `tri`, `page`)
- `GET /api/entreprises/:id` — fiche + contacts rattachés + interactions
- `PATCH /api/entreprises/:id` — `{ statut, priorite, notes }`

Variables d'environnement : `ORA_USER`, `ORA_PASSWORD`, `ORA_CONNECT`, `ORA_WALLET_DIR`,
`ORA_WALLET_PASSWORD`, `ORA_WALLET_B64`, `DASH_TOKEN`, `PORT`.

Contient des données à caractère personnel : accès refusé sans jeton, réponses `no-store`,
page en `noindex`. Purge des contacts 36 mois après collecte (colonne virtuelle `PURGE_LE`).
