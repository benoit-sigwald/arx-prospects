'use strict';
/*
 * Normalise ENTREPRISES.TELEPHONE au format international.
 *
 * Quatre ecritures coexistent en base, heritees de chargements successifs :
 *   +33493097000     deja normalise
 *   493097000.0      passe par un flottant : le zero initial a saute et un
 *                    « .0 » traine. Le lien tel: est alors inutilisable.
 *   06 43 91 05 92   format national francais
 *   93 25 42 42      huit chiffres : Monaco, +377, pas la France. Les membres
 *                    de l'AMAF sont monegasques ; les prefixer en +33 les
 *                    rendrait injoignables.
 *
 *   node scripts/normaliser-telephones.js              simulation
 *   node scripts/normaliser-telephones.js --appliquer  ecrit
 */
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
const APPLIQUER = process.argv.includes('--appliquer');

function normaliser(brut, territoire) {
  if (!brut) return null;
  let s = String(brut).trim();
  if (s.startsWith('+')) return s;                 // deja fait
  // Double saisie « 04 89 82 73 18/9 » : on garde le premier numero.
  s = s.split(/[\/;]|\s+ou\s+/i)[0];
  s = s.replace(/\.0+$/, '');                      // artefact de flottant
  const d = s.replace(/\D/g, '');
  if (!d) return null;

  if (territoire === 'MC') {
    // Monaco : huit chiffres, indicatif 377. Mais une societe monegasque peut
    // publier un mobile francais : on ne bascule en +377 que si le compte de
    // chiffres correspond, sinon on applique les regles francaises plus bas.
    const n = d.startsWith('377') ? d.slice(3) : d;
    if (n.length === 8) return '+377' + n;
  }
  // France : neuf chiffres apres le zero initial. Le zero manque quand la
  // valeur est passee par un nombre.
  let n = d;
  if (n.startsWith('0033')) n = n.slice(4);
  else if (n.startsWith('33') && n.length === 11) n = n.slice(2);
  else if (n.startsWith('0')) n = n.slice(1);
  if (n.length !== 9 || n[0] === '0') return null;
  return '+33' + n;
}

(async () => {
  const c = await oracledb.getConnection({
    user: process.env.ORA_USER, password: process.env.ORA_PASSWORD,
    connectString: process.env.ORA_CONNECT, configDir: process.env.ORA_WALLET_DIR,
    walletLocation: process.env.ORA_WALLET_DIR, walletPassword: process.env.ORA_WALLET_PASSWORD,
  });

  const rows = (await c.execute(
    `SELECT ID, TELEPHONE, TERRITOIRE FROM ENTREPRISES WHERE TELEPHONE IS NOT NULL`)).rows;

  const majs = [], refus = [];
  for (const r of rows) {
    const n = normaliser(r.TELEPHONE, r.TERRITOIRE);
    if (!n) { refus.push(r); continue; }
    if (n !== r.TELEPHONE) majs.push({ tel: n, id: r.ID });
  }

  console.log(`telephones en base : ${rows.length}`);
  console.log(`  a normaliser     : ${majs.length}`);
  console.log(`  deja au format   : ${rows.length - majs.length - refus.length}`);
  console.log(`  illisibles       : ${refus.length}`);
  refus.slice(0, 6).forEach(r => console.log(`     ${JSON.stringify(r.TELEPHONE)} (${r.TERRITOIRE})`));

  if (!APPLIQUER) { console.log('\n>> SIMULATION'); await c.close(); return; }

  const r = await c.executeMany(
    `UPDATE ENTREPRISES SET TELEPHONE = :tel, UPDATED_AT = SYSTIMESTAMP WHERE ID = :id`,
    majs, { autoCommit: true,
            bindDefs: { tel: { type: oracledb.STRING, maxSize: 60 }, id: { type: oracledb.NUMBER } } });
  console.log(`\nlignes mises a jour : ${r.rowsAffected}`);

  const v = (await c.execute(
    `SELECT SUM(CASE WHEN TELEPHONE LIKE '+33%' THEN 1 ELSE 0 END) FR,
            SUM(CASE WHEN TELEPHONE LIKE '+377%' THEN 1 ELSE 0 END) MC,
            SUM(CASE WHEN TELEPHONE NOT LIKE '+%' THEN 1 ELSE 0 END) RESTE
       FROM ENTREPRISES WHERE TELEPHONE IS NOT NULL`)).rows[0];
  console.log(`france ${v.FR} | monaco ${v.MC} | non normalises ${v.RESTE}`);
  await c.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
