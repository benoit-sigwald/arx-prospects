'use strict';
/*
 * arx-prospects — consultation des entreprises et contacts du schéma Oracle PROSPECTS.
 *
 *   GET /                     page (protégée par DASH_TOKEN : ?key=… puis cookie)
 *   GET /api/stats            compteurs par territoire, secteur, tranche d'effectif
 *   GET /api/entreprises      liste filtrable   ?q=&territoire=&secteur=&effmin=&statut=&page=
 *   GET /api/entreprises/:id  fiche + contacts rattachés
 *   GET /api/personnes        recherche par nom ?q=&origine=&territoire=&canal=&tri=&page=
 *   PATCH /api/entreprises/:id  { statut, priorite, notes }
 *
 * La page expose des données personnelles (contacts) : l'accès est refusé sans jeton,
 * et les réponses sont marquées no-store.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

// ---------- db ----------
// Wallet et pool vivent dans lib/oracle.js : la CLI d'export vers Linki
// interroge la meme base avec la meme connexion.
const { q } = require('./lib/oracle');
const pont = require('./lib/pont-linki');
const crm = require('./lib/crm');

// ---------- auth ----------
const TOKEN = process.env.DASH_TOKEN || '';
const app = express();
app.disable('x-powered-by');
app.use(express.json());

function auth(req, res, next) {
  if (!TOKEN) return res.status(503).send('DASH_TOKEN non configuré');
  const given = req.query.key
    || (req.headers.cookie || '').match(/(?:^|;\s*)pk=([^;]+)/)?.[1]
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (given !== TOKEN) return res.status(401).send('clé requise');
  if (req.query.key) {
    // Cookie d'hôte : duckdns.org est un public suffix, pas de partage inter-sous-domaines.
    res.setHeader('Set-Cookie', `pk=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

// ---------- api ----------
app.get('/api/stats', auth, async (_req, res, next) => {
  try {
    const [terr, sect, eff, tot] = await Promise.all([
      q(`SELECT TERRITOIRE, COUNT(*) N FROM ENTREPRISES GROUP BY TERRITOIRE ORDER BY N DESC`),
      q(`SELECT NVL(SECTEUR_LIBELLE,'Non renseigné') S, COUNT(*) N FROM ENTREPRISES
         GROUP BY NVL(SECTEUR_LIBELLE,'Non renseigné') ORDER BY N DESC FETCH FIRST 14 ROWS ONLY`),
      q(`SELECT CASE WHEN EFFECTIF IS NULL THEN 'inconnu' WHEN EFFECTIF<10 THEN '1-9'
                     WHEN EFFECTIF<50 THEN '10-49' WHEN EFFECTIF<250 THEN '50-249'
                     ELSE '250+' END T, COUNT(*) N
         FROM ENTREPRISES GROUP BY CASE WHEN EFFECTIF IS NULL THEN 'inconnu' WHEN EFFECTIF<10 THEN '1-9'
                     WHEN EFFECTIF<50 THEN '10-49' WHEN EFFECTIF<250 THEN '50-249'
                     ELSE '250+' END`),
      q(`SELECT (SELECT COUNT(*) FROM ENTREPRISES) ENTREPRISES,
                (SELECT COUNT(*) FROM CONTACTS) CONTACTS,
                (SELECT COUNT(*) FROM V_CIBLES_ACTIVES) ACTIVES,
                (SELECT NVL(SUM(CA_EUR),0) FROM ENTREPRISES) CA_CUMULE,
                (SELECT COUNT(*) FROM ENTREPRISES
                  WHERE DIRIGEANT IS NOT NULL AND TRIM(DIRIGEANT) IS NOT NULL) DIRIGEANTS,
                (SELECT COUNT(ENTREPRISE_ID) FROM CONTACTS) CONTACTS_LIES,
                (SELECT COUNT(*) FROM CONTACTS WHERE LINKEDIN_URL IS NOT NULL) AVEC_LINKEDIN,
                (SELECT COUNT(*) FROM CONTACTS WHERE LINKEDIN_URL IS NULL) AU_REGISTRE,
                (SELECT COUNT(*) FROM ENTREPRISES WHERE SIREN IS NOT NULL) AVEC_SIREN,
                (SELECT COUNT(*) FROM ENTREPRISES WHERE TELEPHONE IS NOT NULL) APPELABLES,
                (SELECT COUNT(*) FROM INTERACTIONS) APPELS_FAITS,
                (SELECT COUNT(DISTINCT ENTREPRISE_ID) FROM INTERACTIONS
                  WHERE RELANCE_LE <= TRUNC(SYSDATE)) RELANCES_DUES,
                (SELECT COUNT(*) FROM ENTREPRISES WHERE SITE_WEB IS NOT NULL) AVEC_SITE
           FROM DUAL`),
    ]);
    const t = tot.rows[0];
    res.json({
      territoires: terr.rows, secteurs: sect.rows, effectifs: eff.rows,
      totaux: { ...t, PERSONNES: Number(t.DIRIGEANTS) + Number(t.CONTACTS) },
    });
  } catch (e) { next(e); }
});

app.get('/api/entreprises', auth, async (req, res, next) => {
  try {
    const w = [], b = {};
    if (req.query.q)          { w.push(`(UPPER(RAISON_SOCIALE) LIKE :q OR UPPER(NVL(VILLE,' ')) LIKE :q OR UPPER(NVL(SECTEUR_LIBELLE,' ')) LIKE :q OR UPPER(NVL(DIRIGEANT,' ')) LIKE :q)`); b.q = `%${String(req.query.q).toUpperCase()}%`; }
    if (req.query.territoire) { w.push(`TERRITOIRE = :t`); b.t = req.query.territoire; }
    if (req.query.secteur)    { w.push(`SECTEUR_LIBELLE = :s`); b.s = req.query.secteur; }
    if (req.query.statut)     { w.push(`STATUT = :st`); b.st = req.query.statut; }
    if (req.query.effmin)     { w.push(`EFFECTIF >= :e`); b.e = Number(req.query.effmin); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';

    const tri = { ca: 'CA_EUR DESC NULLS LAST', effectif: 'EFFECTIF DESC NULLS LAST',
                  nom: 'RAISON_SOCIALE', recent: 'ANNEE_SOURCE DESC NULLS LAST' }[req.query.tri] || 'CA_EUR DESC NULLS LAST';
    b.off = Number(req.query.page || 0) * 60;

    const r = await q(`SELECT ID, RAISON_SOCIALE, TERRITOIRE, VILLE, CODE_POSTAL, SECTEUR_LIBELLE,
                              DIRIGEANT, EFFECTIF, CA_EUR, RESULTAT_EUR, TELEPHONE, SITE_WEB,
                              SIREN, CODE_NAF, STATUT, PRIORITE, ANNEE_SOURCE, SOURCE,
                              DOUBLON_POTENTIEL
                       FROM ENTREPRISES ${where}
                       ORDER BY ${tri} OFFSET :off ROWS FETCH NEXT 60 ROWS ONLY`, b);
    const c = await q(`SELECT COUNT(*) N FROM ENTREPRISES ${where}`,
                      Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'off')));
    res.json({ total: c.rows[0].N, rows: r.rows });
  } catch (e) { next(e); }
});

/*
 * Recherche de personnes.
 *
 * Deux gisements coexistent et aucun ne suffit seul :
 *   - CONTACTS : 45 fiches nominatives issues d'un export LinkedIn/Waalaxy,
 *     riches en profil mais sans rattachement (ENTREPRISE_ID est vide partout) ;
 *   - ENTREPRISES.DIRIGEANT : 433 dirigeants nommes, rattaches par construction
 *     mais sans canal de contact direct.
 * On les expose sous un meme toit pour que la recherche par nom couvre les deux.
 */
const SQL_PERSONNES = `
  SELECT c.ID                                              AS PID,
         -- Trois provenances, trois niveaux de confiance : le registre est
         -- opposable, l'export LinkedIn est declaratif, la fiche entreprise
         -- est une saisie. Les confondre sous « contact » induirait en erreur.
         CASE WHEN c.LINKEDIN_URL IS NOT NULL THEN 'linkedin'
              ELSE 'registre' END                          AS ORIGINE,
         TRIM(NVL(c.PRENOM, ' ') || ' ' || NVL(c.NOM, ' ')) AS NOM_COMPLET,
         c.FONCTION                                        AS ROLE,
         -- Un contact rattache doit montrer sa societe, pas son titre LinkedIn :
         -- c'est la colonne sur laquelle on lit la table et on recherche.
         NVL(ec.RAISON_SOCIALE, c.INTITULE_POSTE)          AS DETAIL,
         NVL(c.LOCALISATION, ec.VILLE)                     AS LIEU,
         -- L'import Waalaxy a decale les colonnes sur au moins une ligne :
         -- EMAIL y contient une localisation. On ne retient que ce qui a la
         -- forme d'une adresse, sinon le filtre « avec e-mail » ment et la
         -- fiche propose un mailto: invalide.
         CASE WHEN REGEXP_LIKE(c.EMAIL, '^[^[:space:]@]+@[^[:space:]@]+\.[A-Za-z]{2,}$')
              THEN c.EMAIL END                             AS EMAIL,
         c.TELEPHONE                                       AS TELEPHONE,
         c.LINKEDIN_URL                                    AS LINKEDIN_URL,
         c.ENTREPRISE_ID                                   AS ENTREPRISE_ID,
         ec.TERRITOIRE                                     AS TERRITOIRE,
         c.SOURCE                                          AS SOURCE,
         c.OPPOSITION                                      AS OPPOSITION
  FROM CONTACTS c
  LEFT JOIN ENTREPRISES ec ON ec.ID = c.ENTREPRISE_ID
  UNION ALL
  SELECT e.ID,
         'fiche',
         e.DIRIGEANT,
         CAST('Dirigeant' AS VARCHAR2(120)),
         e.RAISON_SOCIALE,
         e.VILLE,
         CAST(NULL AS VARCHAR2(320)),
         e.TELEPHONE,
         CAST(NULL AS VARCHAR2(400)),
         e.ID,
         e.TERRITOIRE,
         e.SOURCE,
         CAST(NULL AS CHAR(1))
  FROM ENTREPRISES e
  WHERE e.DIRIGEANT IS NOT NULL AND TRIM(e.DIRIGEANT) IS NOT NULL`;

app.get('/api/personnes', auth, async (req, res, next) => {
  try {
    const w = [], b = {};
    if (req.query.q) {
      w.push(`(UPPER(NOM_COMPLET) LIKE :q OR UPPER(NVL(DETAIL,' ')) LIKE :q
               OR UPPER(NVL(ROLE,' ')) LIKE :q OR UPPER(NVL(EMAIL,' ')) LIKE :q
               OR UPPER(NVL(LIEU,' ')) LIKE :q)`);
      b.q = `%${String(req.query.q).toUpperCase()}%`;
    }
    if (req.query.origine)    { w.push(`ORIGINE = :o`); b.o = req.query.origine; }
    if (req.query.territoire) { w.push(`TERRITOIRE = :t`); b.t = req.query.territoire; }
    if (req.query.canal === 'email')    w.push(`EMAIL IS NOT NULL`);
    if (req.query.canal === 'linkedin') w.push(`LINKEDIN_URL IS NOT NULL`);
    if (req.query.canal === 'tel')      w.push(`TELEPHONE IS NOT NULL`);
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';

    // Un nom se cherche par ordre alphabetique : les contacts joignables d'abord,
    // sinon la page 1 ne montrerait que des fiches sans canal.
    const tri = { nom: 'NOM_COMPLET', joignable: 'JOIGNABLE DESC, NOM_COMPLET' }
                [req.query.tri] || 'JOIGNABLE DESC, NOM_COMPLET';
    b.off = Number(req.query.page || 0) * 60;

    const base = `SELECT p.*,
                    CASE WHEN EMAIL IS NOT NULL THEN 2
                         WHEN LINKEDIN_URL IS NOT NULL OR TELEPHONE IS NOT NULL THEN 1
                         ELSE 0 END AS JOIGNABLE
                  FROM (${SQL_PERSONNES}) p`;

    const r = await q(`SELECT * FROM (${base}) ${where}
                       ORDER BY ${tri} OFFSET :off ROWS FETCH NEXT 60 ROWS ONLY`, b);
    const c = await q(`SELECT COUNT(*) N FROM (${base}) ${where}`,
                      Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'off')));
    res.json({ total: c.rows[0].N, rows: r.rows });
  } catch (e) { next(e); }
});

/*
 * File d'appel.
 *
 * Ce gisement n'a pas d'e-mail nominatif — mesure faite, pas supposition. Le
 * seul canal direct est le telephone du siege. La file classe donc par valeur
 * (CA) ce qui est appelable, en remontant la derniere interaction pour ne pas
 * rappeler deux fois le meme jour et ne pas rater une relance due.
 */
const ETATS_OUVERTS = ['a_qualifier', 'a_verifier', 'qualifie', 'contacte', 'rdv', 'proposition'];

app.get('/api/appels', auth, async (req, res, next) => {
  try {
    const w = ['e.TELEPHONE IS NOT NULL'], b = {};
    if (req.query.q) {
      w.push(`(UPPER(e.RAISON_SOCIALE) LIKE :q OR UPPER(NVL(e.VILLE,' ')) LIKE :q)`);
      b.q = `%${String(req.query.q).toUpperCase()}%`;
    }
    if (req.query.territoire) { w.push('e.TERRITOIRE = :t'); b.t = req.query.territoire; }
    if (req.query.statut)     { w.push('e.STATUT = :st'); b.st = req.query.statut; }
    if (req.query.camin)      { w.push('e.CA_EUR >= :ca'); b.ca = Number(req.query.camin); }
    // « A faire » exclut ce qui est clos et ce qui a deja ete appele aujourd'hui.
    if (req.query.file === 'todo') {
      w.push(`e.STATUT IN (${ETATS_OUVERTS.map((_, i) => `:e${i}`).join(',')})`);
      ETATS_OUVERTS.forEach((v, i) => { b[`e${i}`] = v; });
      w.push(`NOT EXISTS (SELECT 1 FROM INTERACTIONS i
                           WHERE i.ENTREPRISE_ID = e.ID AND TRUNC(i.DATE_INTER) = TRUNC(SYSDATE))`);
    }
    if (req.query.file === 'relance') {
      w.push(`EXISTS (SELECT 1 FROM INTERACTIONS i
                       WHERE i.ENTREPRISE_ID = e.ID AND i.RELANCE_LE <= TRUNC(SYSDATE))`);
    }
    const where = 'WHERE ' + w.join(' AND ');
    b.off = Number(req.query.page || 0) * 60;

    const tri = { ca: 'e.CA_EUR DESC NULLS LAST', nom: 'e.RAISON_SOCIALE',
                  relance: 'RELANCE_LE ASC NULLS LAST, e.CA_EUR DESC' }
                [req.query.tri] || 'NVL(e.PRIORITE, 3), e.CA_EUR DESC NULLS LAST';

    const base = `SELECT e.ID, e.RAISON_SOCIALE, e.VILLE, e.TERRITOIRE, e.SECTEUR_LIBELLE,
             e.CA_EUR, e.EFFECTIF, e.TELEPHONE, e.SITE_WEB, e.SIREN,
             e.STATUT, e.PRIORITE, e.NOTES,
             (SELECT COUNT(*) FROM INTERACTIONS i WHERE i.ENTREPRISE_ID = e.ID) NB_APPELS,
             (SELECT MAX(i.DATE_INTER) FROM INTERACTIONS i WHERE i.ENTREPRISE_ID = e.ID) DERNIER,
             (SELECT MIN(i.RELANCE_LE) FROM INTERACTIONS i
               WHERE i.ENTREPRISE_ID = e.ID AND i.RELANCE_LE >= TRUNC(SYSDATE)) RELANCE_LE,
             (SELECT LISTAGG(TRIM(NVL(k.PRENOM,' ')||' '||k.NOM) || ' (' || NVL(k.FONCTION,'?') || ')', ' · ')
                       WITHIN GROUP (ORDER BY k.NOM)
                FROM CONTACTS k WHERE k.ENTREPRISE_ID = e.ID AND ROWNUM <= 4) DIRIGEANTS
        FROM ENTREPRISES e ${where}`;

    const r = await q(`SELECT * FROM (${base}) ORDER BY ${tri.replace(/e\./g, '')}
                       OFFSET :off ROWS FETCH NEXT 60 ROWS ONLY`, b);
    const c = await q(`SELECT COUNT(*) N FROM ENTREPRISES e ${where}`,
                      Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'off')));
    res.json({ total: c.rows[0].N, rows: r.rows });
  } catch (e) { next(e); }
});

app.post('/api/interactions', auth, async (req, res, next) => {
  try {
    const { entreprise_id, canal, resume, prochaine_etape, relance_le, statut } = req.body || {};
    if (!entreprise_id) return res.status(400).json({ erreur: 'entreprise_id requis' });
    await q(`INSERT INTO INTERACTIONS
               (ENTREPRISE_ID, CANAL, RESUME, PROCHAINE_ETAPE, RELANCE_LE, DATE_INTER)
             VALUES (:id, :canal, :resume, :etape, TO_DATE(:relance,'YYYY-MM-DD'), SYSDATE)`,
            { id: Number(entreprise_id), canal: canal || 'telephone',
              resume: resume || null, etape: prochaine_etape || null, relance: relance_le || null });
    // Le statut suit l'appel : le saisir ailleurs ferait diverger les deux.
    if (statut) {
      await q(`UPDATE ENTREPRISES SET STATUT = :s, UPDATED_AT = SYSTIMESTAMP WHERE ID = :id`,
              { s: statut, id: Number(entreprise_id) });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/*
 * Pont vers Linki (B1.4).
 *
 * Les ecrans Entreprises et Personnes filtrent deja ; le bouton reprend le
 * filtre affiche et l'envoie tel quel. Rien n'est recopie, donc rien ne peut
 * diverger entre ce qu'on a vu et ce qu'on demarche.
 *
 * LISTE garde le filtre, jamais les lignes : rejouer une liste dans six mois
 * doit rendre l'etat du referentiel a ce moment-la, pas une photo perimee.
 */
const CHAMPS_FILTRE = ['source', 'canal', 'pays', 'ville', 'titre', 'q', 'territoire', 'secteur'];

function filtreDeLaRequete(src = {}) {
  const f = {};
  for (const k of CHAMPS_FILTRE) if (src[k]) f[k] = String(src[k]);
  if (src.limite) f.limite = Number(src.limite);
  return f;
}

app.get('/api/listes', auth, async (_req, res, next) => {
  try {
    const r = await q(`SELECT ID, NOM, FILTRE, CANAL, LINKI_INSTANCE, LINKI_LIST_ID,
                              DERNIER_ENVOI, LIGNES_ENVOYEES, CREE_PAR, CREATED_AT, UPDATED_AT
                       FROM LISTE ORDER BY UPDATED_AT DESC`);
    res.json({ rows: r.rows.map(l => ({ ...l, FILTRE: JSON.parse(l.FILTRE) })) });
  } catch (e) { next(e); }
});

app.post('/api/listes', auth, async (req, res, next) => {
  try {
    const { nom } = req.body || {};
    if (!nom) return res.status(400).json({ erreur: 'nom requis' });
    const filtre = filtreDeLaRequete(req.body.filtre || req.body);
    // MERGE : reenregistrer un ciblage sous le meme nom le corrige au lieu
    // d'echouer sur l'unicite du nom.
    await q(`MERGE INTO LISTE l USING (SELECT :nom NOM FROM DUAL) s ON (l.NOM = s.NOM)
             WHEN MATCHED THEN UPDATE SET FILTRE = :filtre, CANAL = :canal, UPDATED_AT = SYSTIMESTAMP
             WHEN NOT MATCHED THEN INSERT (NOM, FILTRE, CANAL, CREE_PAR)
                                  VALUES (:nom, :filtre, :canal, :par)`,
            { nom, filtre: JSON.stringify(filtre), canal: filtre.canal || 'mixte', par: 'arx-prospects' });
    res.json({ ok: true, filtre });
  } catch (e) { next(e); }
});

/*
 * Apercu : ce que l'envoi ferait, sans rien envoyer.
 *
 * Le CSV n'est pas renvoye — il porte des donnees personnelles et l'ecran n'en
 * a pas besoin pour decider. Seuls les compteurs remontent.
 */
app.post('/api/listes/apercu', auth, async (req, res, next) => {
  try {
    const filtre = filtreDeLaRequete(req.body.filtre || req.body);
    let exclusions = null, avertissement = null;
    try { exclusions = await pont.exclusionsLinki(); }
    catch (e) { avertissement = `exclusions Linki indisponibles : ${e.message}`; }
    const r = await pont.construireCsv(q, filtre, { exclusions });
    res.json({ filtre, candidats: r.candidats, ecartes_demarches: r.ecartes_demarches,
               lignes: r.lignes, avertissement });
  } catch (e) { next(e); }
});

app.post('/api/listes/envoyer', auth, async (req, res, next) => {
  try {
    const { nom } = req.body || {};
    if (!nom) return res.status(400).json({ erreur: 'nom de liste requis' });

    // Un nom deja connu fait foi : on rejoue son filtre plutot que celui de
    // l'ecran, sinon deux envois de « la meme » liste viseraient deux publics.
    const dejaLa = await q(`SELECT ID, FILTRE FROM LISTE WHERE NOM = :n`, { n: nom });
    const filtre = dejaLa.rows.length
      ? JSON.parse(dejaLa.rows[0].FILTRE)
      : filtreDeLaRequete(req.body.filtre || req.body);

    let exclusions = null, avertissement = null;
    try { exclusions = await pont.exclusionsLinki(); }
    catch (e) { avertissement = `exclusions Linki indisponibles : ${e.message}`; }

    const r = await pont.construireCsv(q, filtre, { exclusions });
    if (!r.lignes) {
      return res.json({ ok: false, raison: 'aucune ligne exportable',
                        candidats: r.candidats, ecartes_demarches: r.ecartes_demarches, avertissement });
    }

    const envoi = await pont.pousserVersLinki(nom, r.csv);

    await q(`MERGE INTO LISTE l USING (SELECT :nom NOM FROM DUAL) s ON (l.NOM = s.NOM)
             WHEN MATCHED THEN UPDATE SET LINKI_LIST_ID = :lid, LINKI_INSTANCE = :inst,
                    DERNIER_ENVOI = SYSTIMESTAMP, LIGNES_ENVOYEES = :n, UPDATED_AT = SYSTIMESTAMP
             WHEN NOT MATCHED THEN INSERT (NOM, FILTRE, CANAL, LINKI_LIST_ID, LINKI_INSTANCE,
                                           DERNIER_ENVOI, LIGNES_ENVOYEES, CREE_PAR)
                                  VALUES (:nom, :filtre, :canal, :lid, :inst,
                                          SYSTIMESTAMP, :n, 'arx-prospects')`,
            { nom, filtre: JSON.stringify(filtre), canal: filtre.canal || 'mixte',
              lid: envoi.liste_id, inst: pont.LINKI_BASE, n: r.lignes });

    res.json({ ok: true, liste: envoi.nom, liste_id: envoi.liste_id,
               candidats: r.candidats, ecartes_demarches: r.ecartes_demarches, lignes: r.lignes,
               crees: envoi.imported, mis_a_jour: envoi.updated, deja_dans_la_liste: envoi.skipped,
               refus: envoi.errors || [], avertissement });
  } catch (e) { next(e); }
});

/*
 * CRM — le pipeline, toutes bases confondues.
 *
 * Une seule liste pour INVESTORS, PROSPECTS, les dirigeants de fiches et les
 * 35 formulaires GATE_*. C'est le point : un prospect n'appartient pas a un
 * ecran, il appartient a un etat.
 *
 * L'absence de ligne dans CONTACT_STATE vaut `a_contacter` — on ne materialise
 * pas 85 494 lignes pour dire que rien ne s'est encore passe.
 */
const FILES = {
  // Les trois questions qu'on se pose le matin, dans l'ordre.
  retard:     `ACTION_LE < TRUNC(SYSDATE)`,
  aujourdhui: `ACTION_LE <= TRUNC(SYSDATE)`,
  semaine:    `ACTION_LE <= TRUNC(SYSDATE) + 7`,
  actifs:     `STATUT NOT IN ('a_contacter', 'gagne', 'perdu')`,
};

function ouPipeline(req) {
  const w = [], b = {};
  if (req.query.source) {
    // « gate » vaut pour les 35 formulaires d'un coup.
    if (req.query.source === 'gate') w.push(`SOURCE LIKE 'gate:%'`);
    else { w.push(`SOURCE = :source`); b.source = req.query.source; }
  }
  if (req.query.statut)       { w.push(`STATUT = :statut`); b.statut = req.query.statut; }
  if (req.query.proprietaire) { w.push(`PROPRIETAIRE = :prop`); b.prop = req.query.proprietaire; }
  if (req.query.canal === 'email')    w.push(`EMAIL IS NOT NULL`);
  if (req.query.canal === 'linkedin') w.push(`LINKEDIN_URL IS NOT NULL`);
  if (req.query.canal === 'joignable') w.push(`(EMAIL IS NOT NULL OR LINKEDIN_URL IS NOT NULL)`);
  if (req.query.optout === '1')  w.push(`OPT_OUT = 1`);
  if (req.query.optout === '0')  w.push(`OPT_OUT = 0`);
  if (FILES[req.query.file])     w.push(FILES[req.query.file]);
  if (req.query.q) {
    w.push(`(UPPER(FIRST_NAME || ' ' || LAST_NAME) LIKE :q
             OR UPPER(NVL(COMPANY,' ')) LIKE :q OR UPPER(NVL(TITLE,' ')) LIKE :q
             OR UPPER(NVL(EMAIL,' ')) LIKE :q)`);
    b.q = `%${String(req.query.q).toUpperCase()}%`;
  }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', binds: b };
}

app.get('/api/pipeline', auth, async (req, res, next) => {
  try {
    const { where, binds } = ouPipeline(req);
    const b = { ...binds, off: Number(req.query.page || 0) * 60 };
    // Les echeances d'abord, puis les fiches vivantes : une liste de CRM se lit
    // par urgence, pas par ordre alphabetique.
    const tri = { action: 'ACTION_LE NULLS LAST, LAST_NAME',
                  nom: 'LAST_NAME, FIRST_NAME',
                  recent: 'DERNIER_CONTACT_LE DESC NULLS LAST' }[req.query.tri]
                || 'ACTION_LE NULLS LAST, LAST_NAME';
    const r = await q(`SELECT * FROM (${crm.SQL_PIPELINE}) ${where}
                       ORDER BY ${tri} OFFSET :off ROWS FETCH NEXT 60 ROWS ONLY`, b);
    const c = await q(`SELECT COUNT(*) N FROM (${crm.SQL_PIPELINE}) ${where}`, binds);
    res.json({ total: c.rows[0].N, rows: r.rows });
  } catch (e) { next(e); }
});

/*
 * Les compteurs du CRM : une ligne par base, une ligne par statut, et les
 * echeances. C'est ce qui doit tenir en haut de l'ecran.
 */
app.get('/api/pipeline/stats', auth, async (_req, res, next) => {
  try {
    const [bases, statuts, echeances] = await Promise.all([
      q(`SELECT SOURCE, COUNT(*) N,
                COUNT(CASE WHEN EMAIL IS NOT NULL OR LINKEDIN_URL IS NOT NULL THEN 1 END) JOIGNABLES,
                COUNT(CASE WHEN STATUT <> 'a_contacter' THEN 1 END) ENGAGES,
                SUM(OPT_OUT) OPT_OUT
           FROM (${crm.SQL_PIPELINE}) GROUP BY SOURCE ORDER BY N DESC`),
      q(`SELECT STATUT, COUNT(*) N FROM (${crm.SQL_PIPELINE})
          WHERE STATUT <> 'a_contacter' GROUP BY STATUT`),
      q(`SELECT COUNT(CASE WHEN ${FILES.retard} THEN 1 END) RETARD,
                COUNT(CASE WHEN ${FILES.aujourdhui} THEN 1 END) AUJOURDHUI,
                COUNT(CASE WHEN ${FILES.semaine} THEN 1 END) SEMAINE,
                COUNT(CASE WHEN ${FILES.actifs} THEN 1 END) ACTIFS
           FROM (${crm.SQL_PIPELINE})`),
    ]);
    res.json({ bases: bases.rows, statuts: statuts.rows, echeances: echeances.rows[0],
               vocabulaire: crm.STATUTS, motifs: crm.MOTIFS_PERTE,
               types_action: crm.TYPES_ACTION, sans_action_due: crm.SANS_ACTION_DUE });
  } catch (e) { next(e); }
});

/*
 * Saisie d'un etat.
 *
 * MERGE : la ligne d'etat nait au premier geste, pas avant. Les colonnes
 * absentes du corps ne sont pas touchees — un ecran qui envoie un champ ne doit
 * pas effacer les autres.
 */
app.patch('/api/etat/:person_key', auth, async (req, res, next) => {
  try {
    const k = req.params.person_key;
    const v = req.body || {};
    if (v.statut && !crm.STATUTS.includes(v.statut))
      return res.status(400).json({ erreur: `statut inconnu : ${v.statut}` });
    if (v.action_type && !crm.TYPES_ACTION.includes(v.action_type))
      return res.status(400).json({ erreur: `type d'action inconnu : ${v.action_type}` });
    if (v.motif_perte && !crm.MOTIFS_PERTE.includes(v.motif_perte))
      return res.status(400).json({ erreur: `motif de perte inconnu : ${v.motif_perte}` });

    // La personne doit exister dans le referentiel : une cle inventee creerait
    // un etat orphelin que plus rien ne rattacherait a quelqu'un.
    const p = await q(`SELECT COUNT(*) N FROM V_PERSONNES WHERE PERSON_KEY = :k`, { k });
    if (!p.rows[0].N) return res.status(404).json({ erreur: 'personne inconnue' });

    await q(`MERGE INTO CONTACT_STATE c USING (SELECT :k PERSON_KEY FROM DUAL) s
               ON (c.PERSON_KEY = s.PERSON_KEY)
             WHEN MATCHED THEN UPDATE SET
               STATUT = NVL(:statut, STATUT),
               PROPRIETAIRE = NVL(:prop, PROPRIETAIRE),
               ACTION_TYPE = NVL(:atype, ACTION_TYPE),
               ACTION_LE = NVL(TO_DATE(:ale, 'YYYY-MM-DD'), ACTION_LE),
               ACTION_NOTE = NVL(:anote, ACTION_NOTE),
               NOTES = NVL(:notes, NOTES),
               MOTIF_PERTE = NVL(:motif, MOTIF_PERTE),
               OPT_OUT = NVL(:optout, OPT_OUT),
               OPT_OUT_LE = CASE WHEN :optout = 1 AND OPT_OUT_LE IS NULL THEN SYSTIMESTAMP ELSE OPT_OUT_LE END,
               UPDATED_AT = SYSTIMESTAMP
             WHEN NOT MATCHED THEN INSERT
               (PERSON_KEY, STATUT, PROPRIETAIRE, ACTION_TYPE, ACTION_LE, ACTION_NOTE,
                NOTES, MOTIF_PERTE, OPT_OUT, OPT_OUT_LE, ORIGINE_ETAT)
               VALUES (:k, NVL(:statut, 'a_contacter'), :prop, :atype,
                       TO_DATE(:ale, 'YYYY-MM-DD'), :anote, :notes, :motif,
                       NVL(:optout, 0), CASE WHEN :optout = 1 THEN SYSTIMESTAMP END, 'saisie')`,
            { k, statut: v.statut || null, prop: v.proprietaire || null,
              atype: v.action_type || null, ale: v.action_le || null,
              anote: v.action_note || null, notes: v.notes || null,
              motif: v.motif_perte || null,
              optout: v.opt_out == null ? null : (v.opt_out ? 1 : 0) });

    const r = await q(`SELECT * FROM (${crm.SQL_PIPELINE}) WHERE PERSON_KEY = :k`, { k });
    res.json({ ok: true, fiche: r.rows[0] });
  } catch (e) {
    // La contrainte B4.2 est le coeur du CRM : son refus doit se lire, pas
    // ressortir en ORA-02290 dans une boite de dialogue.
    if (String(e.message).includes('CK_CS_ACTION_DUE')) {
      return res.status(400).json({
        erreur: 'Ce statut exige une prochaine action datee : renseignez le type et la date.' });
    }
    next(e);
  }
});

app.get('/api/entreprises/:id', auth, async (req, res, next) => {
  try {
    const e = await q(`SELECT * FROM ENTREPRISES WHERE ID = :id`, { id: Number(req.params.id) });
    if (!e.rows.length) return res.status(404).json({ erreur: 'inconnue' });
    const row = e.rows[0];
    // Rattachement des contacts : lien explicite, sinon rapprochement par nom d'entreprise.
    const c = await q(`SELECT ID, PRENOM, NOM, FONCTION, INTITULE_POSTE, LOCALISATION,
                              EMAIL, TELEPHONE, LINKEDIN_URL, SOURCE, ANNEE_SOURCE, PURGE_LE, OPPOSITION
                       FROM CONTACTS
                       WHERE ENTREPRISE_ID = :id
                          OR (ENTREPRISE_ID IS NULL AND UPPER(NVL(INTITULE_POSTE,' ')) LIKE :nom)
                       ORDER BY NOM`,
                      { id: row.ID, nom: `%${String(row.RAISON_SOCIALE).toUpperCase()}%` });
    const i = await q(`SELECT ID, DATE_INTER, CANAL, RESUME, PROCHAINE_ETAPE, RELANCE_LE
                       FROM INTERACTIONS WHERE ENTREPRISE_ID = :id ORDER BY DATE_INTER DESC`,
                      { id: row.ID });
    res.json({ entreprise: row, contacts: c.rows, interactions: i.rows });
  } catch (e) { next(e); }
});

app.patch('/api/entreprises/:id', auth, async (req, res, next) => {
  try {
    const { statut, priorite, notes } = req.body || {};
    await q(`UPDATE ENTREPRISES SET
               STATUT   = NVL(:statut, STATUT),
               PRIORITE = NVL(:priorite, PRIORITE),
               NOTES    = NVL(:notes, NOTES),
               UPDATED_AT = SYSTIMESTAMP
             WHERE ID = :id`,
            { statut: statut || null, priorite: priorite ?? null, notes: notes || null, id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- page ----------
app.get('/', auth, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
});
// Assets (logo…) : derrière le même jeton — le cookie posé à l'ouverture de la page suffit.
// index:false pour que la racine reste servie par la route ci-dessus.
app.use(auth, express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.get('/healthz', (_req, res) => res.send('ok'));

app.use((e, _req, res, _next) => {
  console.error(e);
  res.status(500).json({ erreur: String(e.message || e) });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('arx-prospects écoute sur', port));
