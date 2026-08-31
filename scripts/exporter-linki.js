'use strict';
/*
 * Exporte un ciblage de V_PERSONNES au format d'import de Linki.
 *
 *   node scripts/exporter-linki.js --source=investors --canal=email --limite=200
 *   node scripts/exporter-linki.js --liste="Investisseurs FR"        rejoue un filtre enregistre
 *   node scripts/exporter-linki.js --source=investors --enregistrer="Investisseurs FR"
 *   node scripts/exporter-linki.js --liste="Investisseurs FR" --pousser
 *
 * Sans --pousser, le CSV part sur la sortie standard et rien n'est envoye :
 * on peut le relire avant qu'une seule personne soit demarchee.
 *
 * Filtres : --source (investors | prospects | prospects_dirigeant | gate)
 *           --canal (email | linkedin)  --pays  --ville  --titre  --q  --limite
 *
 * A executer dans le conteneur arx-prospects, qui a le wallet et les
 * identifiants du schema PROSPECTS.
 */
const { q, fermer } = require('../lib/oracle');
const pont = require('../lib/pont-linki');

function args() {
  const o = { drapeaux: new Set() };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
    else if (a.startsWith('--')) o.drapeaux.add(a.slice(2));
  }
  return o;
}

// Le filtre enregistre fait foi quand il existe : rejouer une liste doit donner
// le meme ciblage qu'a sa creation, pas celui de la ligne de commande du jour.
async function filtreDepuisListe(nom) {
  const r = await q(`SELECT ID, NOM, FILTRE, CANAL FROM LISTE WHERE NOM = :n`, { n: nom });
  if (!r.rows.length) throw new Error(`liste inconnue : ${nom}`);
  const l = r.rows[0];
  return { id: l.ID, nom: l.NOM, filtre: JSON.parse(l.FILTRE) };
}

async function main() {
  const a = args();
  const versStdout = !a.drapeaux.has('pousser');

  let filtre, nomListe = a.liste || a.enregistrer || null, listeId = null;

  if (a.liste) {
    const l = await filtreDepuisListe(a.liste);
    filtre = l.filtre; listeId = l.id; nomListe = l.nom;
  } else {
    filtre = {
      source: a.source || null, canal: a.canal || null, pays: a.pays || null,
      ville: a.ville || null, titre: a.titre || null, q: a.q || null,
      limite: a.limite ? Number(a.limite) : null,
    };
    for (const k of Object.keys(filtre)) if (filtre[k] == null) delete filtre[k];
  }

  // Les exclusions coutent un aller-retour vers Linki. On ne le paie pas quand
  // l'instance n'est pas joignable : le CSV reste utilisable, on le dit.
  let exclusions = null;
  try {
    exclusions = await pont.exclusionsLinki();
  } catch (e) {
    process.stderr.write(`avertissement : exclusions Linki indisponibles (${e.message})\n`);
  }

  const r = await pont.construireCsv(q, filtre, { exclusions });

  process.stderr.write(
    `${r.candidats} candidats — ${r.ecartes_demarches} deja demarches ecartes — ` +
    `${r.lignes} lignes exportables\n`);

  if (a.enregistrer && !a.liste) {
    // MERGE plutot qu'INSERT : reenregistrer un ciblage sous le meme nom doit
    // le corriger, pas echouer sur la contrainte d'unicite.
    await q(`MERGE INTO LISTE l USING (SELECT :nom NOM FROM DUAL) s ON (l.NOM = s.NOM)
             WHEN MATCHED THEN UPDATE SET FILTRE = :filtre, CANAL = :canal, UPDATED_AT = SYSTIMESTAMP
             WHEN NOT MATCHED THEN INSERT (NOM, FILTRE, CANAL, CREE_PAR)
                                  VALUES (:nom, :filtre, :canal, :par)`,
            { nom: a.enregistrer, filtre: JSON.stringify(filtre),
              canal: filtre.canal || 'mixte', par: process.env.USER || 'cli' });
    process.stderr.write(`filtre enregistre dans LISTE sous « ${a.enregistrer} »\n`);
  }

  if (versStdout) {
    process.stdout.write(r.csv + '\n');
    await fermer();
    return;
  }

  if (!nomListe) throw new Error('--pousser exige --liste ou --enregistrer pour nommer la liste Linki');
  if (!r.lignes) { process.stderr.write('rien a pousser\n'); await fermer(); return; }

  const res = await pont.pousserVersLinki(nomListe, r.csv);
  process.stderr.write(
    `pousse dans Linki « ${res.nom} » (${res.liste_id}) : ` +
    `${res.imported} crees, ${res.updated} mis a jour, ${res.skipped} deja dans la liste` +
    (res.errors?.length ? `, ${res.errors.length} refus` : '') + '\n');
  if (res.errors?.length) process.stderr.write(res.errors.slice(0, 5).join('\n') + '\n');

  if (listeId) {
    await q(`UPDATE LISTE SET LINKI_LIST_ID = :lid, LINKI_INSTANCE = :inst,
                    DERNIER_ENVOI = SYSTIMESTAMP, LIGNES_ENVOYEES = :n, UPDATED_AT = SYSTIMESTAMP
              WHERE ID = :id`,
            { lid: res.liste_id, inst: pont.LINKI_BASE, n: r.lignes, id: listeId });
  }
  await fermer();
}

main().catch(async e => { console.error(e.message); await fermer().catch(() => {}); process.exit(1); });
