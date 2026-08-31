'use strict';
/*
 * Pont Oracle -> Linki : traduire un ciblage de V_PERSONNES en CSV que Linki
 * accepte, et le deposer dans une de ses listes.
 *
 * Un seul module pour la CLI (scripts/exporter-linki.js) et pour le bouton du
 * serveur : le CSV envoye a la main et celui envoye depuis l'ecran doivent etre
 * le meme, sinon on debogue deux fois.
 *
 * Le format cible est celui de lib/csv-import.ts cote Linki, releve le
 * 2026-08-31 : une ligne passe si elle porte au moins linkedin_url ou email.
 * Toute autre est refusee avec un message d'erreur par ligne — on filtre donc
 * ici, plutot que de laisser Linki compter les echecs.
 */

// Ordre et noms exacts attendus par l'import de Linki. Ne pas reordonner sans
// relire lib/csv-import.ts : l'en-tete est normalise (minuscules, espaces ->
// underscores) mais les noms, eux, doivent correspondre.
const COLONNES_LINKI = [
  'linkedin_url', 'sales_nav_url', 'email', 'first_name', 'last_name', 'title',
  'company', 'location', 'city', 'country', 'phone', 'headline', 'summary', 'notes',
];

const LINKI_BASE = process.env.LINKI_BASE || 'http://arx-linki:3000/linki-awB4WDkPyeqWzWdh';

/* ------------------------------------------------------------------ ciblage */

/*
 * Traduit un filtre en requete sur V_PERSONNES.
 *
 * Le filtre est ce que LISTE stocke : un critere, jamais des lignes. Le meme
 * objet doit donc pouvoir etre rejoue dans six mois et rendre l'etat du
 * referentiel a ce moment-la.
 */
function sqlCiblage(filtre = {}) {
  const w = [], b = {};

  // Sans canal, Linki refuse la ligne. Le dire en SQL evite d'exporter 70 000
  // fiches de registre pour n'en voir passer que 44.
  w.push(`(EMAIL IS NOT NULL OR LINKEDIN_URL IS NOT NULL)`);

  // B1.5 — l'opposition est le seul drapeau transverse fiable a ce stade. Il
  // est applique ici, pas en option : une exclusion facultative n'en est pas une.
  w.push(`OPT_OUT = 0`);

  if (filtre.source) {
    // « gate » vaut pour les 35 schemas de formulaire, qu'on ne va pas nommer un a un.
    if (filtre.source === 'gate') w.push(`SOURCE LIKE 'gate:%'`);
    else { w.push(`SOURCE = :source`); b.source = filtre.source; }
  }
  if (filtre.canal === 'email')    w.push(`EMAIL IS NOT NULL`);
  if (filtre.canal === 'linkedin') w.push(`LINKEDIN_URL IS NOT NULL`);
  if (filtre.pays)  { w.push(`UPPER(COUNTRY) = UPPER(:pays)`); b.pays = filtre.pays; }
  // territoire et secteur sont les filtres de l'ecran Entreprises : un ciblage
  // pense en societes doit pouvoir partir sans etre retape en personnes.
  if (filtre.territoire) { w.push(`TERRITOIRE = :territoire`); b.territoire = filtre.territoire; }
  if (filtre.secteur)    { w.push(`SECTEUR = :secteur`); b.secteur = filtre.secteur; }
  if (filtre.ville) { w.push(`UPPER(CITY) LIKE UPPER(:ville)`); b.ville = `%${filtre.ville}%`; }
  if (filtre.titre) { w.push(`UPPER(TITLE) LIKE UPPER(:titre)`); b.titre = `%${filtre.titre}%`; }
  if (filtre.q) {
    w.push(`(UPPER(FIRST_NAME || ' ' || LAST_NAME) LIKE :q
             OR UPPER(NVL(COMPANY, ' ')) LIKE :q
             OR UPPER(NVL(TITLE, ' ')) LIKE :q)`);
    b.q = `%${String(filtre.q).toUpperCase()}%`;
  }

  // Un e-mail vaut mieux qu'un profil LinkedIn : c'est le canal ouvert en
  // premier, et la limite tronque toujours par le bas.
  const sql = `SELECT PERSON_KEY, SOURCE, FIRST_NAME, LAST_NAME, EMAIL, LINKEDIN_URL,
                      TITLE, COMPANY, CITY, COUNTRY, PHONE, SOURCE_DETAIL, STATUT_SOURCE,
                      ENTREPRISE_ID, TERRITOIRE, SECTEUR
                 FROM V_PERSONNES
                WHERE ${w.join('\n                  AND ')}
                ORDER BY CASE WHEN EMAIL IS NOT NULL THEN 0 ELSE 1 END,
                         NVL(COMPANY, ' '), LAST_NAME`
    + (filtre.limite ? `\n                FETCH FIRST ${Number(filtre.limite)} ROWS ONLY` : '');

  return { sql, binds: b };
}

/* --------------------------------------------------------------- exclusions */

/*
 * B1.5 — ce que Linki sait deja.
 *
 * « Deja en campagne » et « a repondu » ne vivent pas dans Oracle avant B2.1 :
 * la seule source honnete aujourd'hui est l'instance Linki elle-meme. On lui
 * demande ses cibles et on ecarte celles qui ont deja recu quelque chose ou
 * repondu. Une cible simplement presente, jamais sollicitee, n'est pas exclue :
 * l'import de Linki est un upsert, la reimporter ne cree pas de doublon.
 */
async function exclusionsLinki(base = LINKI_BASE) {
  const emails = new Set(), profils = new Set();
  let page = 0, vus = 0, total = null;

  // La pagination est bornee : sans plafond, une instance a 50 000 cibles
  // ferait tourner cette boucle pendant l'affichage d'un ecran.
  while (page < 100) {
    const r = await fetch(`${base}/api/targets?limit=500&page=${page}`);
    if (!r.ok) throw new Error(`Linki /api/targets a repondu ${r.status}`);
    const data = await r.json();

    // Linki repond { contacts, total }. Une version qui renommerait ce champ
    // rendrait un ensemble d'exclusions vide, et l'export redemarcherait des
    // gens deja sollicites sans qu'aucune erreur ne soit levee. On refuse
    // plutot que d'exclure zero personne en silence.
    const lignes = data.contacts ?? data.targets ?? data.rows
      ?? (Array.isArray(data) ? data : null);
    if (!Array.isArray(lignes)) {
      throw new Error(`reponse /api/targets non reconnue (cles : ${Object.keys(data).join(', ')})`);
    }
    if (total === null) total = data.total ?? lignes.length;
    if (!lignes.length) break;
    for (const t of lignes) {
      const demarche = t.message_sent_at || t.connection_requested_at || t.last_replied_at;
      if (!demarche) continue;
      if (t.email) emails.add(String(t.email).toLowerCase());
      if (t.linkedin_url) profils.add(cleLinkedin(t.linkedin_url));
    }
    vus += lignes.length;
    page++;
    if (total !== null && vus >= total) break;
  }
  return { emails, profils, cibles_vues: vus };
}

// Deux URL du meme profil different par le protocole, le www, la barre finale
// ou une querystring de tracking. Comparees telles quelles, elles ne
// s'excluraient pas l'une l'autre.
function cleLinkedin(url) {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : String(url).toLowerCase();
}

/* --------------------------------------------------------------------- csv */

// RFC 4180 : guillemets doubles, et on n'entoure que ce qui l'exige. Le pont ne
// merite pas une dependance de plus.
function champ(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/*
 * Une ligne de V_PERSONNES devient une ligne Linki.
 *
 * notes porte la provenance : dans Linki, c'est la seule colonne qui dira d'ou
 * vient la fiche le jour ou quelqu'un se demande pourquoi il la demarche.
 */
function versLigneLinki(r) {
  const localisation = [r.CITY, r.COUNTRY].filter(Boolean).join(', ') || null;
  return {
    linkedin_url: r.LINKEDIN_URL,
    sales_nav_url: null,
    email: r.EMAIL,
    first_name: r.FIRST_NAME,
    last_name: r.LAST_NAME,
    title: r.TITLE,
    company: r.COMPANY,
    location: localisation,
    city: r.CITY,
    country: r.COUNTRY,
    phone: r.PHONE,
    headline: null,
    summary: null,
    notes: [r.SOURCE, r.SOURCE_DETAIL].filter(Boolean).join(' — ') || null,
  };
}

function versCsv(lignes) {
  return [COLONNES_LINKI.join(',')]
    .concat(lignes.map(l => COLONNES_LINKI.map(c => champ(l[c])).join(',')))
    .join('\r\n');
}

/* ------------------------------------------------------------------ export */

/*
 * Construit le CSV d'un ciblage, exclusions comprises.
 *
 * `q` est la fonction de requete Oracle du contexte appelant (serveur ou CLI) :
 * le module ne cree pas de connexion, il n'y en a que 21 pour tout le parc.
 */
async function construireCsv(q, filtre, { exclusions = null } = {}) {
  const { sql, binds } = sqlCiblage(filtre);
  const r = await q(sql, binds);

  let ecartes_demarches = 0;
  const retenues = [];
  for (const row of r.rows) {
    if (exclusions) {
      const parEmail = row.EMAIL && exclusions.emails.has(row.EMAIL.toLowerCase());
      const parProfil = row.LINKEDIN_URL && exclusions.profils.has(cleLinkedin(row.LINKEDIN_URL));
      if (parEmail || parProfil) { ecartes_demarches++; continue; }
    }
    retenues.push(versLigneLinki(row));
  }

  return {
    csv: versCsv(retenues),
    lignes: retenues.length,
    candidats: r.rows.length,
    ecartes_demarches,
    cles: r.rows.map(x => x.PERSON_KEY),
  };
}

/* ------------------------------------------------------------------ poussee */

/*
 * Depose le CSV dans une liste Linki, creee si elle n'existe pas.
 *
 * Le nom fait la cle : une liste Oracle et une liste Linki qui portent le meme
 * nom sont la meme liste. Sans cela, un second envoi creerait un doublon et la
 * campagne demarcherait deux fois.
 */
async function pousserVersLinki(nomListe, csv, base = LINKI_BASE) {
  const rl = await fetch(`${base}/api/lists`);
  if (!rl.ok) throw new Error(`Linki /api/lists a repondu ${rl.status}`);
  const listes = await rl.json();

  let liste = listes.find(l => l.name === nomListe);
  if (!liste) {
    const rc = await fetch(`${base}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nomListe, description: 'Ciblage arx-prospects' }),
    });
    if (!rc.ok) throw new Error(`creation de la liste refusee (${rc.status})`);
    liste = await rc.json();
  }

  const ri = await fetch(`${base}/api/lists/${liste.id}/import-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  if (!ri.ok) throw new Error(`import refuse (${ri.status}) : ${(await ri.text()).slice(0, 200)}`);
  return { liste_id: liste.id, nom: liste.name, ...(await ri.json()) };
}

module.exports = {
  COLONNES_LINKI, LINKI_BASE,
  sqlCiblage, exclusionsLinki, construireCsv, versCsv, versLigneLinki,
  pousserVersLinki, cleLinkedin,
};
