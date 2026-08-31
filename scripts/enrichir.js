'use strict';
/*
 * Moteur d'enrichissement — passage complet.
 *
 *   node scripts/enrichir.js                 simulation, ne resout que le DNS
 *   node scripts/enrichir.js --appliquer     ecrit dans ENRICHISSEMENT
 *   node scripts/enrichir.js --limite=50     restreint le lot
 *
 * Tourne dans le conteneur arx-prospects : il a le wallet, les identifiants du
 * schema PROSPECTS et la sortie reseau. Rejouable — chaque source ne dit qu'une
 * chose a la fois sur un champ, et la relancer met a jour la date.
 *
 * Concu pour un timer : c'est un passage court et idempotent, pas une
 * migration. Il ne demande jamais confirmation et ne modifie aucune donnee
 * d'origine.
 */
const { q, qLot, fermer } = require('../lib/oracle');
const enr = require('../lib/enrichir');

const APPLIQUER = process.argv.includes('--appliquer');
const LIMITE = (process.argv.find(a => a.startsWith('--limite=')) || '').split('=')[1] || null;

async function main() {
  const existe = (await q(`SELECT COUNT(*) N FROM USER_TABLES
                            WHERE TABLE_NAME = 'ENRICHISSEMENT'`)).rows[0].N > 0;
  if (!existe) {
    if (!APPLIQUER) {
      console.log(enr.DDL_ENRICHISSEMENT + ';');
      enr.INDEX_ENRICHISSEMENT.forEach(i => console.log(i + ';'));
    } else {
      await q(enr.DDL_ENRICHISSEMENT);
      console.log('  ok table : PROSPECTS.ENRICHISSEMENT');
      for (const i of enr.INDEX_ENRICHISSEMENT) {
        await q(i); console.log(`  ok index : ${i.split(' ')[2]}`);
      }
    }
  }

  const t0 = Date.now();
  const r = await enr.enrichirAdresses(q, { appliquer: APPLIQUER, limite: LIMITE, qLot });
  const s = r.resume;

  console.log(`\nAdresses : ${s.adresses} sur ${s.domaines} domaines, ` +
              `${Math.round((Date.now() - t0) / 1000)} s`);
  console.log('  etat de reception :');
  for (const [k, n] of Object.entries(s.etats).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(18)} ${String(n).padStart(5)}`);
  }
  console.log('  forme de l\'adresse :');
  for (const [k, n] of Object.entries(s.formes).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(18)} ${String(n).padStart(5)}`);
  }

  if (!APPLIQUER) {
    console.log('\nsimulation : rien ecrit. Relancer avec --appliquer.');
    await fermer();
    return;
  }

  // On relit ce qu'on a ecrit : une ecriture reussie n'est pas une ecriture juste.
  const etat = await q(enr.SQL_ETAT_ENRICHISSEMENT);
  console.log('\nENRICHISSEMENT :');
  for (const l of etat.rows) {
    console.log(`  ${String(l.CHAMP).padEnd(13)} ${String(l.VALEUR).padEnd(16)} ` +
                `${String(l.SOURCE).padEnd(7)} ${String(l.N).padStart(5)}  ` +
                `vu le ${new Date(l.PLUS_RECENT).toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  await fermer();
}

main().catch(async e => { console.error(e.message); await fermer().catch(() => {}); process.exit(1); });
