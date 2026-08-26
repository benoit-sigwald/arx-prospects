'use strict';
/*
 * Insere le NDJSON produit par preparer-import-paca.py dans ENTREPRISES et
 * CONTACTS.
 *
 *   node scripts/importer-paca.js import_paca.ndjson              simulation
 *   node scripts/importer-paca.js import_paca.ndjson --appliquer  ecrit
 *
 * Deux garde-fous :
 *   - le SIREN fait foi. Une organisation dont le SIREN est deja en base est
 *     ignoree : l'import ne doit pas dupliquer les 795 lignes existantes.
 *   - les contacts portent le SIREN de leur societe, jamais un identifiant du
 *     lac. On resout ENTREPRISE_ID apres l'insertion des organisations, donc
 *     un contact orphelin est compte et laisse de cote plutot qu'insere nu.
 */
const fs = require('fs');
const readline = require('readline');
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const FICHIER = process.argv[2];
const APPLIQUER = process.argv.includes('--appliquer');
const LOT = 1000;
const STATUT = 'a_qualifier';

const s = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

// Le lac classe chaque organisation par type d'acteur patrimonial. C'est la
// facette utile pour filtrer, mais elle arrive en identifiants techniques :
// on la rend lisible ici, la colonne alimentant directement le menu Secteur.
const LIBELLES = {
  family_office: 'Family office',
  wealth_manager: 'Gestion de patrimoine',
  club_deal: 'Club deal / immobilier',
  cgp: 'Conseil en gestion de patrimoine',
  debt_fund: 'Fonds de dette',
  vc: 'Capital-risque',
  pe: 'Capital-investissement',
  angel_network: 'Réseau de business angels',
};
const libelle = t => (t ? LIBELLES[t] || t : null);

// batchErrors laisse Oracle poursuivre le lot malgre les lignes refusees et les
// rapporte une a une. Sans cela, une seule collision d'unicite annule
// l'insertion des 999 autres lignes du meme lot.
async function parLots(c, sql, lignes, binds, libelle) {
  let ok = 0;
  const refus = new Map();
  for (let i = 0; i < lignes.length; i += LOT) {
    const lot = lignes.slice(i, i + LOT);
    const r = await c.executeMany(sql, lot,
      { autoCommit: true, bindDefs: binds, batchErrors: true });
    const erreurs = r.batchErrors || [];
    ok += lot.length - erreurs.length;
    erreurs.forEach(e => refus.set(e.errorNum, (refus.get(e.errorNum) || 0) + 1));
    const vus = Math.min(i + LOT, lignes.length);
    if (vus % 10000 < LOT || vus === lignes.length) console.log(`   ${libelle} ${vus}/${lignes.length}`);
  }
  if (refus.size) {
    console.log(`   ${libelle} refuses : ` +
      [...refus].map(([n, k]) => `ORA-${String(n).padStart(5, '0')} x${k}`).join(', '));
  }
  return ok;
}

(async () => {
  const orgs = [], contacts = [];
  const rl = readline.createInterface({ input: fs.createReadStream(FICHIER), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    (r.t === 'o' ? orgs : contacts).push(r);
  }
  console.log(`fichier : ${orgs.length} organisations, ${contacts.length} contacts`);

  const c = await oracledb.getConnection({
    user: process.env.ORA_USER, password: process.env.ORA_PASSWORD,
    connectString: process.env.ORA_CONNECT, configDir: process.env.ORA_WALLET_DIR,
    walletLocation: process.env.ORA_WALLET_DIR, walletPassword: process.env.ORA_WALLET_PASSWORD,
  });

  const avant = (await c.execute(
    `SELECT (SELECT COUNT(*) FROM ENTREPRISES) E, (SELECT COUNT(*) FROM CONTACTS) K FROM DUAL`)).rows[0];
  console.log(`base    : ${avant.E} entreprises, ${avant.K} contacts`);

  const dejaLa = new Set((await c.execute(
    `SELECT SIREN FROM ENTREPRISES WHERE SIREN IS NOT NULL`)).rows.map(r => r.SIREN));
  console.log(`SIREN deja en base : ${dejaLa.size}`);

  const aInserer = orgs.filter(o => !o.siren || !dejaLa.has(o.siren));
  const ignores = orgs.length - aInserer.length;
  console.log(`organisations a inserer : ${aInserer.length} (${ignores} deja presentes)`);

  if (!APPLIQUER) {
    console.log('\n>> SIMULATION, rien n\'a ete ecrit');
    console.log('exemple :', JSON.stringify(aInserer[0]));
    await c.close();
    return;
  }

  /* ------------------------------ organisations ----------------------------- */
  const SQL_ORG = `INSERT INTO ENTREPRISES
    (RAISON_SOCIALE, NOM_NORM, TERRITOIRE, SIREN, CODE_NAF, SECTEUR_LIBELLE,
     ADRESSE, CODE_POSTAL, VILLE, DEPARTEMENT, TELEPHONE, SITE_WEB,
     EFFECTIF, EFFECTIF_ESTIME, CONFIANCE_EFFECTIF, CA_EUR, RESULTAT_EUR,
     STATUT, SOURCE, SOURCE_URL, ANNEE_SOURCE, DATE_COLLECTE, CREATED_AT)
    VALUES (:nom, :nom_norm, :territoire, :siren, :naf, :secteur,
            :adresse, :cp, :ville, :dep, :tel, :site,
            :effectif, :eff_est, :conf, :ca, :resultat,
            :statut, :source, :source_url, :annee, SYSDATE, SYSTIMESTAMP)`;

  const bindsOrg = {
    nom: { type: oracledb.STRING, maxSize: 300 },
    nom_norm: { type: oracledb.STRING, maxSize: 300 },
    territoire: { type: oracledb.STRING, maxSize: 10 },
    siren: { type: oracledb.STRING, maxSize: 9 },
    naf: { type: oracledb.STRING, maxSize: 10 },
    secteur: { type: oracledb.STRING, maxSize: 200 },
    adresse: { type: oracledb.STRING, maxSize: 300 },
    cp: { type: oracledb.STRING, maxSize: 10 },
    ville: { type: oracledb.STRING, maxSize: 120 },
    dep: { type: oracledb.STRING, maxSize: 10 },
    tel: { type: oracledb.STRING, maxSize: 60 },
    site: { type: oracledb.STRING, maxSize: 300 },
    effectif: { type: oracledb.NUMBER },
    eff_est: { type: oracledb.STRING, maxSize: 20 },
    conf: { type: oracledb.STRING, maxSize: 10 },
    ca: { type: oracledb.NUMBER },
    resultat: { type: oracledb.NUMBER },
    statut: { type: oracledb.STRING, maxSize: 30 },
    source: { type: oracledb.STRING, maxSize: 250 },
    source_url: { type: oracledb.STRING, maxSize: 400 },
    annee: { type: oracledb.NUMBER },
  };

  const lignesOrg = aInserer.map(o => ({
    nom: s(o.nom, 300), nom_norm: s(o.nom_norm, 300),
    territoire: s(o.territoire, 10),
    // CLE_UNIQUE est une colonne virtuelle (NOM_NORM|TERRITOIRE|VILLE) :
    // Oracle la calcule, l'inserer leve ORA-54013.
    siren: s(o.siren, 9), naf: s(o.naf, 10), secteur: s(libelle(o.secteur), 200),
    adresse: s(o.adresse, 300), cp: s(o.cp, 10), ville: s(o.ville, 120), dep: s(o.dep, 10),
    tel: s(o.tel, 60), site: s(o.site, 300),
    effectif: o.effectif ?? null, eff_est: s(o.effectif_estime, 20),
    // CK_ENT_CONF n'accepte que haute/moyenne/faible : une tranche du
    // registre est fiable comme source mais reste une fourchette.
    conf: o.effectif == null ? 'faible' : 'moyenne',
    ca: o.ca ?? null, resultat: o.resultat ?? null,
    statut: STATUT, source: s(o.source, 250), source_url: s(o.source_url, 400),
    annee: o.annee ?? null,
  }));

  console.log('\ninsertion des organisations…');
  // CLE_UNIQUE (NOM_NORM|TERRITOIRE|VILLE) est unique : deux societes homonymes
  // dans la meme commune ne peuvent coexister. On tranche ici, en gardant la
  // premiere, plutot que de laisser la base refuser au coup par coup.
  const vus = new Set();
  const distincts = lignesOrg.filter(l => {
    const k = `${l.nom_norm}|${l.territoire}|${l.ville || '-'}`;
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  });
  console.log(`homonymes ecartes dans le fichier : ${lignesOrg.length - distincts.length}`);
  console.log(`organisations inserees : ${await parLots(c, SQL_ORG, distincts, bindsOrg, 'orgs')}`);

  /* --------------------------------- contacts ------------------------------- */
  // On relit la table pour obtenir les ID attribues par la colonne identite.
  const map = new Map();
  const res = await c.execute(
    `SELECT ID, SIREN FROM ENTREPRISES WHERE SIREN IS NOT NULL`, {}, { resultSet: true });
  const rs = res.resultSet;
  let row;
  while ((row = await rs.getRow())) if (!map.has(row.SIREN)) map.set(row.SIREN, row.ID);
  await rs.close();
  console.log(`\ncorrespondance SIREN -> ID : ${map.size}`);

  const SQL_CT = `INSERT INTO CONTACTS
    (ENTREPRISE_ID, PRENOM, NOM, FONCTION, INTITULE_POSTE, LOCALISATION,
     EMAIL, TELEPHONE, LINKEDIN_URL, LISTE_ORIGINE, SOURCE, ANNEE_SOURCE,
     DATE_COLLECTE, BASE_LEGALE, OPPOSITION, CREATED_AT)
    VALUES (:eid, :prenom, :nom, :fonction, :intitule, :lieu,
            :email, :tel, :linkedin, :liste, :source, :annee,
            SYSDATE, :base, 'N', SYSTIMESTAMP)`;
// PURGE_LE est virtuelle : ADD_MONTHS(DATE_COLLECTE, 36). La renseigner leve
// ORA-54013 — la duree de conservation est portee par le schema, pas par nous.

  const bindsCt = {
    eid: { type: oracledb.NUMBER },
    prenom: { type: oracledb.STRING, maxSize: 120 },
    nom: { type: oracledb.STRING, maxSize: 200 },
    fonction: { type: oracledb.STRING, maxSize: 200 },
    intitule: { type: oracledb.STRING, maxSize: 300 },
    lieu: { type: oracledb.STRING, maxSize: 200 },
    email: { type: oracledb.STRING, maxSize: 320 },
    tel: { type: oracledb.STRING, maxSize: 60 },
    linkedin: { type: oracledb.STRING, maxSize: 400 },
    liste: { type: oracledb.STRING, maxSize: 120 },
    source: { type: oracledb.STRING, maxSize: 250 },
    annee: { type: oracledb.NUMBER },
    base: { type: oracledb.STRING, maxSize: 60 },
  };

  // Une personne est identifiee par sa societe, son nom et sa fonction. Sans
  // ce releve, relancer l'import sur un lac recollecte reinsere tout le stock
  // deja present — 57 000 doublons au deuxieme passage.
  const dejaVus = new Set();
  {
    const q = await c.execute(
      `SELECT ENTREPRISE_ID, PRENOM, NOM, FONCTION FROM CONTACTS`, {}, { resultSet: true });
    let l;
    while ((l = await q.resultSet.getRow())) {
      dejaVus.add(`${l.ENTREPRISE_ID}|${l.PRENOM || ''}|${l.NOM || ''}|${l.FONCTION || ''}`);
    }
    await q.resultSet.close();
  }
  console.log(`contacts deja en base : ${dejaVus.size} cles distinctes`);

  let orphelins = 0, connus = 0;
  const lignesCt = [];
  for (const k of contacts) {
    const eid = map.get(k.siren);
    if (!eid) { orphelins++; continue; }
    const cle = `${eid}|${k.prenom || ''}|${k.nom || ''}|${k.fonction || ''}`;
    if (dejaVus.has(cle)) { connus++; continue; }
    dejaVus.add(cle);
    lignesCt.push({
      eid, prenom: s(k.prenom, 120), nom: s(k.nom, 200),
      fonction: s(k.fonction, 200), intitule: s(k.intitule, 300), lieu: s(k.lieu, 200),
      email: s(k.email, 320), tel: s(k.tel, 60), linkedin: s(k.linkedin, 400),
      liste: s(k.liste, 120), source: s(k.source, 250), annee: k.annee ?? null,
      base: s(k.base_legale, 60) || 'public_register',
    });
  }
  console.log(`contacts a inserer : ${lignesCt.length} (${orphelins} sans societe resolue, ${connus} deja presents)`);
  console.log('\ninsertion des contacts…');
  console.log(`contacts inseres : ${await parLots(c, SQL_CT, lignesCt, bindsCt, 'contacts')}`);

  const apres = (await c.execute(
    `SELECT (SELECT COUNT(*) FROM ENTREPRISES) E, (SELECT COUNT(*) FROM CONTACTS) K,
            (SELECT COUNT(ENTREPRISE_ID) FROM CONTACTS) L FROM DUAL`)).rows[0];
  console.log('');
  console.log(`entreprises : ${avant.E} -> ${apres.E}`);
  console.log(`contacts    : ${avant.K} -> ${apres.K} (dont ${apres.L} rattaches)`);
  await c.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
