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

// ---------- wallet ----------
const WALLET_DIR = process.env.ORA_WALLET_DIR || '/tmp/wallet';
if (process.env.ORA_WALLET_B64 && !fs.existsSync(path.join(WALLET_DIR, 'tnsnames.ora'))) {
  const AdmZip = require('adm-zip');
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  new AdmZip(Buffer.from(process.env.ORA_WALLET_B64, 'base64')).extractAllTo(WALLET_DIR, true);
  console.log('wallet extrait dans', WALLET_DIR);
}

// ---------- db ----------
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];
let _pool;
async function pool() {
  if (!_pool) {
    _pool = await oracledb.createPool({
      user: process.env.ORA_USER,
      password: process.env.ORA_PASSWORD,
      connectString: process.env.ORA_CONNECT,
      configDir: WALLET_DIR,
      walletLocation: WALLET_DIR,
      walletPassword: process.env.ORA_WALLET_PASSWORD,
      poolMin: 0, poolMax: 4, poolTimeout: 120,
    });
  }
  return _pool;
}
async function q(sql, binds = {}, opts = {}) {
  const c = await (await pool()).getConnection();
  try { return await c.execute(sql, binds, { autoCommit: true, ...opts }); }
  finally { await c.close(); }
}

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
                (SELECT NVL(SUM(CA_EUR),0) FROM ENTREPRISES) CA_CUMULE FROM DUAL`),
    ]);
    res.json({
      territoires: terr.rows, secteurs: sect.rows,
      effectifs: eff.rows, totaux: tot.rows[0],
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
         'contact'                                         AS ORIGINE,
         TRIM(NVL(c.PRENOM, ' ') || ' ' || NVL(c.NOM, ' ')) AS NOM_COMPLET,
         c.FONCTION                                        AS ROLE,
         c.INTITULE_POSTE                                  AS DETAIL,
         c.LOCALISATION                                    AS LIEU,
         -- L'import Waalaxy a decale les colonnes sur au moins une ligne :
         -- EMAIL y contient une localisation. On ne retient que ce qui a la
         -- forme d'une adresse, sinon le filtre « avec e-mail » ment et la
         -- fiche propose un mailto: invalide.
         CASE WHEN REGEXP_LIKE(c.EMAIL, '^[^[:space:]@]+@[^[:space:]@]+\.[A-Za-z]{2,}$')
              THEN c.EMAIL END                             AS EMAIL,
         c.TELEPHONE                                       AS TELEPHONE,
         c.LINKEDIN_URL                                    AS LINKEDIN_URL,
         c.ENTREPRISE_ID                                   AS ENTREPRISE_ID,
         CAST(NULL AS VARCHAR2(16))                        AS TERRITOIRE,
         c.SOURCE                                          AS SOURCE,
         c.OPPOSITION                                      AS OPPOSITION
  FROM CONTACTS c
  UNION ALL
  SELECT e.ID,
         'dirigeant',
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
