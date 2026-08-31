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

  const existe = (await q(`SELECT COUNT(*) N FROM ALL_TABLES
                            WHERE OWNER='PROSPECTS' AND TABLE_NAME='CONTACT_STATE'`)).rows[0].N > 0;

  // Les faits d'envoi vivent chez INVESTORS : sans ce droit, la reconciliation
  // ne verrait que DEMARCHAGE, c'est-a-dire rien.
  const grants = [`GRANT SELECT ON INVESTORS.MAILING_SENDS TO PROSPECTS`];

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

  const r = await crm.reconcilier(q, { appliquer: true });
  console.log(`  ok reconciliation : ${r.lignes} lignes`);

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
  await cn.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
