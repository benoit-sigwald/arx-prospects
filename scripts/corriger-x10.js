'use strict';
/*
 * Restaure CA_EUR, RESULTAT_EUR et EFFECTIF des lignes issues de
 * Prospect-solidarite a partir du fichier source.
 *
 * Le chargement initial a multiplie par 10 : 301 effectifs sur 302, 47 CA sur
 * 358, 37 resultats sur 311. Aucun seuil ne separe proprement le bon du faux —
 * un resultat stocke a 843 460 est errone tandis que -51 093 000 est juste —
 * donc on ne corrige pas par regle : on reecrit la valeur du fichier d'origine.
 *
 *   node scripts/corriger-x10.js solidarite.csv              simulation
 *   node scripts/corriger-x10.js solidarite.csv --appliquer  ecrit
 *
 * Les valeurs remplacees sont sauvegardees dans sauvegarde-x10.json avant
 * toute ecriture.
 */
const fs = require('fs');
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const FICHIER = process.argv[2];
const APPLIQUER = process.argv.includes('--appliquer');
const SOURCE = 'Prospect-solidarite (classement CA 2024, Alpes-Maritimes)';

const na = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = v => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function lireCsv(chemin) {
  const [entete, ...corps] = fs.readFileSync(chemin, 'utf8').replace(/^﻿/, '')
    .split(/\r?\n/).filter(l => l.trim());
  const cols = entete.split(';');
  return corps.map(l => {
    const v = l.split(';');
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
  });
}

(async () => {
  const src = lireCsv(FICHIER);
  const parNom = new Map();
  for (const s of src) {
    const k = na(s.raison_sociale);
    if (k && !parNom.has(k)) parNom.set(k, s);
  }
  console.log(`${src.length} lignes source, ${parNom.size} noms distincts`);

  const c = await oracledb.getConnection({
    user: process.env.ORA_USER, password: process.env.ORA_PASSWORD,
    connectString: process.env.ORA_CONNECT, configDir: process.env.ORA_WALLET_DIR,
    walletLocation: process.env.ORA_WALLET_DIR, walletPassword: process.env.ORA_WALLET_PASSWORD,
  });

  const cibles = (await c.execute(
    `SELECT ID, RAISON_SOCIALE, CA_EUR, RESULTAT_EUR, EFFECTIF
       FROM ENTREPRISES WHERE SOURCE = :s`, { s: SOURCE })).rows;
  console.log(`${cibles.length} lignes en base pour cette source`);

  const sauvegarde = [], majs = [];
  let introuvables = 0, inchangees = 0;

  for (const e of cibles) {
    const s = parNom.get(na(e.RAISON_SOCIALE));
    if (!s) { introuvables++; continue; }
    const neuf = { CA_EUR: num(s.ca_2024), RESULTAT_EUR: num(s.resultat_2024), EFFECTIF: num(s.effectif) };
    // On n'ecrase jamais une valeur presente par un vide : le fichier source
    // a des cellules manquantes la ou la base a parfois une donnee.
    const diff = {};
    for (const k of ['CA_EUR', 'RESULTAT_EUR', 'EFFECTIF']) {
      if (neuf[k] !== null && Number(e[k]) !== neuf[k]) diff[k] = neuf[k];
    }
    if (!Object.keys(diff).length) { inchangees++; continue; }
    sauvegarde.push({ id: e.ID, nom: e.RAISON_SOCIALE,
                      avant: { CA_EUR: e.CA_EUR, RESULTAT_EUR: e.RESULTAT_EUR, EFFECTIF: e.EFFECTIF },
                      apres: diff });
    majs.push({ id: e.ID, ...diff });
  }

  const facteur = sauvegarde.filter(s => {
    const a = s.avant.CA_EUR, b = s.apres.CA_EUR;
    return a && b && Math.abs(a / b - 10) < 0.01;
  }).length;
  console.log('');
  console.log(`a corriger      : ${majs.length}`);
  console.log(`  dont CA x10   : ${facteur}`);
  console.log(`deja correctes  : ${inchangees}`);
  console.log(`sans equivalent : ${introuvables}`);
  console.log('');
  sauvegarde.slice(0, 6).forEach(s => console.log(
    `  ${s.nom.slice(0, 30).padEnd(30)} CA ${s.avant.CA_EUR} -> ${s.apres.CA_EUR ?? '='}` +
    `  eff ${s.avant.EFFECTIF} -> ${s.apres.EFFECTIF ?? '='}`));

  if (!APPLIQUER) { console.log('\n>> SIMULATION, rien n\'a ete ecrit'); await c.close(); return; }

  fs.writeFileSync('/tmp/sauvegarde-x10.json', JSON.stringify(sauvegarde, null, 1));
  console.log('\nsauvegarde ecrite : /tmp/sauvegarde-x10.json');

  for (const m of majs) {
    const set = [], b = { id: m.id };
    for (const k of ['CA_EUR', 'RESULTAT_EUR', 'EFFECTIF']) {
      if (m[k] !== undefined) { set.push(`${k} = :${k}`); b[k] = m[k]; }
    }
    await c.execute(`UPDATE ENTREPRISES SET ${set.join(', ')}, UPDATED_AT = SYSTIMESTAMP
                     WHERE ID = :id`, b, { autoCommit: true });
  }
  const v = (await c.execute(
    `SELECT COUNT(*) N, ROUND(SUM(CA_EUR)/1e9,2) CA_MD FROM ENTREPRISES WHERE SOURCE = :s`,
    { s: SOURCE })).rows[0];
  console.log(`ecrit. ${majs.length} lignes. CA cumule de la source : ${v.CA_MD} Md EUR`);
  await c.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
