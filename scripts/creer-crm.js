'use strict';
/*
 * Cree CONTACT_STATE et reconcilie l'etat commercial depuis les faits.
 *
 *   node scripts/creer-crm.js              simulation
 *   node scripts/creer-crm.js --appliquer  ecrit
 *
 * Se connecte en ADMIN (le GRANT sur INVESTORS.MAILING_SENDS l'exige), donc
 * depuis le conteneur gate :
 *
 *   sudo docker exec -w /app -e AP="$(sudo cat /root/.ora_admin)" <gate> \
 *        node creer-crm.js --appliquer
 *
 * Rejouable : la table n'est creee qu'une fois, la reconciliation ne fait
 * jamais reculer un statut et ne touche aucune colonne saisie a la main.
 */
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const crm = require('../lib/crm');

const APPLIQUER = process.argv.includes('--appliquer');

async function main() {
  const cn = await oracledb.getConnection({
    user: 'ADMIN',
    password: process.env.AP || process.env.ORA_ADMIN_PASSWORD,
    connectString: process.env.ORA_CONNECT,
    configDir: process.env.ORA_WALLET_DIR || '/tmp/wallet',
    walletLocation: process.env.ORA_WALLET_DIR || '/tmp/wallet',
    walletPassword: process.env.ORA_WALLET_PASSWORD,
  });
  const q = (sql, binds = {}) => cn.execute(sql, binds, { autoCommit: true });

  // On est ADMIN pour les GRANT, mais les objets vivent chez PROSPECTS. Sans
  // cette bascule, un nom non qualifie comme INTERACTION serait cherche dans
  // le schema ADMIN, ou il n'existe pas.
  await q(`ALTER SESSION SET CURRENT_SCHEMA = PROSPECTS`);

  const existeT = async n => (await q(`SELECT COUNT(*) N FROM ALL_TABLES
                                       WHERE OWNER='PROSPECTS' AND TABLE_NAME=:n`, { n })).rows[0].N > 0;
  const existe = await existeT('CONTACT_STATE');
  const existeCamp = await existeT('CAMPAGNE');
  const existeInter = await existeT('INTERACTION');

  // Les faits d'envoi vivent chez INVESTORS : sans ce droit, la reconciliation
  // ne verrait que DEMARCHAGE, c'est-a-dire rien.
  const grants = [`GRANT SELECT ON INVESTORS.MAILING_SENDS TO PROSPECTS`,
                  `GRANT SELECT ON INVESTORS.MAILING_CAMPAIGNS TO PROSPECTS`];

  if (!APPLIQUER) {
    console.log(existe ? '-- CONTACT_STATE existe deja' : crm.DDL + ';');
    if (!existe) crm.INDEX.forEach(i => console.log(i + ';'));
    grants.forEach(g => console.log(g + ';'));
    const ap = await crm.reconcilier(q, { appliquer: false });
    console.log('\n-- ce que la reconciliation ecrirait :');
    for (const r of ap.rows) console.log(`--   ${String(r.STATUT).padEnd(14)} ${String(r.N).padStart(6)} personnes, ${r.OPT_OUT} opt-out`);
    console.log('-- simulation : rien execute. Relancer avec --appliquer.');
    await cn.close();
    return;
  }

  for (const g of grants) { await q(g); console.log(`  ok grant : ${g}`); }
  if (!existe) {
    await q(crm.DDL);
    console.log('  ok table : PROSPECTS.CONTACT_STATE');
    for (const i of crm.INDEX) { await q(i); console.log(`  ok index : ${i.split(' ')[2]}`); }
  } else {
    console.log('  table CONTACT_STATE deja presente, conservee');
  }

  // CAMPAGNE avant INTERACTION : l'ingestion des interactions y resout le
  // rattachement a la campagne.
  if (!existeCamp) { await q(crm.DDL_CAMPAGNE); console.log('  ok table : PROSPECTS.CAMPAGNE'); }
  if (!existeInter) {
    await q(crm.DDL_INTERACTION);
    console.log('  ok table : PROSPECTS.INTERACTION');
    for (const i of crm.INDEX_CRM) { await q(i); console.log(`  ok index : ${i.split(' ')[2]}`); }
  }

  const r = await crm.reconcilier(q, { appliquer: true });
  console.log(`  ok reconciliation : ${r.lignes} lignes`);
  const rc = await crm.ingererCampagnes(q, { appliquer: true });
  console.log(`  ok campagnes : ${rc.lignes} lignes`);
  const ri = await crm.ingererInteractions(q, { appliquer: true });
  console.log(`  ok interactions : ${ri.lignes} lignes`);

  // Une table creee n'est pas une table juste : on relit ce qu'elle contient.
  const etat = await q(`SELECT STATUT, COUNT(*) N, SUM(OPT_OUT) OPT_OUT,
                               COUNT(DERNIER_CONTACT_LE) CONTACTES,
                               COUNT(DERNIERE_REPONSE_LE) REPONSES,
                               MAX(ORIGINE_ETAT) ORIGINE
                          FROM PROSPECTS.CONTACT_STATE GROUP BY STATUT ORDER BY N DESC`);
  console.log('\nCONTACT_STATE :');
  for (const l of etat.rows) {
    console.log(`  ${String(l.STATUT).padEnd(14)} ${String(l.N).padStart(5)} — ` +
                `${l.OPT_OUT} opt-out, ${l.CONTACTES} contactes, ${l.REPONSES} reponses (${l.ORIGINE})`);
  }
  const inter = await q(`SELECT CANAL, TYPE, SENS, COUNT(*) N FROM PROSPECTS.INTERACTION
                          GROUP BY CANAL, TYPE, SENS ORDER BY N DESC`);
  console.log('\nINTERACTION :');
  for (const l of inter.rows) {
    console.log(`  ${String(l.CANAL).padEnd(11)} ${String(l.TYPE).padEnd(12)} ` +
                `${String(l.SENS).padEnd(8)} ${l.N}`);
  }
  const camp = await q(`SELECT c.NOM, c.MOTEUR, c.CIBLES,
                               (SELECT COUNT(*) FROM PROSPECTS.INTERACTION i
                                 WHERE i.CAMPAGNE_ID = c.ID) EVENEMENTS
                          FROM PROSPECTS.CAMPAGNE c ORDER BY c.DEBUT DESC`);
  console.log('\nCAMPAGNE :');
  for (const l of camp.rows) {
    console.log(`  ${String(l.NOM).slice(0, 40).padEnd(42)} ${l.MOTEUR}  ` +
                `${l.CIBLES} cibles, ${l.EVENEMENTS} evenements`);
  }
  await cn.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
