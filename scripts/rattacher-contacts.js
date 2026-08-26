'use strict';
/*
 * Rattache les fiches CONTACTS a une entreprise en lisant le nom de societe
 * contenu dans INTITULE_POSTE.
 *
 * L'export Waalaxy ne porte pas de colonne « entreprise » : le nom est noye
 * dans le titre LinkedIn (« Co-fondateur chez Wilout », « CTO at VULOG »,
 * « Président de JBDA & Jarvix »). On extrait le candidat par motif, puis on
 * le rapproche de ENTREPRISES.RAISON_SOCIALE.
 *
 *   node scripts/rattacher-contacts.js           simulation, n'ecrit rien
 *   node scripts/rattacher-contacts.js --appliquer   ecrit ENTREPRISE_ID
 *
 * Le rapprochement est volontairement prudent : sans correspondance forte on
 * laisse le lien vide plutot que d'attribuer une personne a la mauvaise societe.
 */
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const APPLIQUER = process.argv.includes('--appliquer');
const SEUIL = 0.86;

// Bruit frequent des titres LinkedIn : ni entreprise, ni role exploitable.
const STOP = new Set(['THE', 'A', 'AN', 'MY', 'NOTRE', 'UN', 'UNE', 'LA', 'LE', 'LES',
  'GROUP', 'GROUPE', 'SAS', 'SA', 'SARL', 'SASU', 'EURL', 'INC', 'LTD', 'LLC',
  'FRANCE', 'PARIS', 'NICE', 'INTERNATIONAL', 'INDUSTRIES', 'SOLUTIONS',
  'TECHNOLOGIES', 'CONSULTING', 'COMPANY', 'STUDIO', 'GROUPE']);

function sansAccent(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
function cle(s) {
  const mots = sansAccent(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/).filter(m => m && !STOP.has(m));
  return mots.join(' ');
}
// Coefficient de Dice sur bigrammes : tolerant aux abreviations et fautes.
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bg = s => { const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m; };
  const A = bg(a), B = bg(b);
  let inter = 0, ta = 0, tb = 0;
  A.forEach((n, g) => { ta += n; inter += Math.min(n, B.get(g) || 0); });
  B.forEach(n => { tb += n; });
  return ta + tb ? (2 * inter) / (ta + tb) : 0;
}

/* --------- extraction du nom d'entreprise dans un titre LinkedIn --------- */
// L'ordre compte : « chez » et « at » sont explicites, les autres sont des paris.
const MOTIFS = [
  /\bchez\s+(.+)$/i,
  /\bat\s+(.+)$/i,
  /@\s*([^\s].*)$/,
  /\b(?:de|d[’'])\s+(.+)$/i,
  /\s[-–—]\s*(.+)$/,
];

function candidats(intitule, fonction) {
  const brut = String(intitule || '').replace(/\\+$/, '').trim();
  if (!brut) return [];
  const out = [];
  for (const m of MOTIFS) {
    const r = brut.match(m);
    if (r && r[1]) out.push(r[1]);
  }
  // « Co-fondateur & Président de Klape.io » a deja ete pris par le motif « de ».
  // Reste le cas « CEO - OPTIMUM » ou la fonction prefixe le nom : on retire
  // la fonction connue du debut du titre et on garde le reliquat.
  const f = String(fonction || '').trim();
  if (f && brut.toUpperCase().startsWith(f.toUpperCase())) {
    const reste = brut.slice(f.length).replace(/^[\s:,\-–—/|]+/, '');
    if (reste) out.push(reste);
  }
  // Nettoyage : on coupe aux separateurs de liste et on borne la longueur.
  return out
    .map(s => s.split(/\s+[-–—|/]\s+|\s*[,;]\s*|\s+\(/)[0].trim())
    .map(s => s.replace(/\s+(inc|ltd|llc|sas|sa|sarl)\.?$/i, '').trim())
    .filter(s => s.length >= 2 && s.length <= 60 && cle(s))
    .filter((s, i, a) => a.indexOf(s) === i);
}

/* ------------------------------- rapprochement ------------------------------ */
// « MyLittleAdventure » et « My Little Adventure » designent la meme societe :
// on compare aussi les cles sans espaces, sinon Dice les separe a tort.
const compact = k => k.replace(/ /g, '');

function rapprocher(cand, entreprises) {
  const k = cle(cand), kc = compact(k);
  if (!k) return null;
  let best = null, bs = 0;
  for (const e of entreprises) {
    let s = Math.max(dice(k, e.k), dice(kc, e.kc));
    if (k === e.k || kc === e.kc) {
      s = 1;
    } else {
      // Inclusion : signal fort, mais seulement si le nom court represente
      // l'essentiel du long. Sans ce garde-fou « INVEST » capture
      // « Investor CRO » et « MPE » capture « Empereur Nissapero ».
      const [court, long_] = kc.length <= e.kc.length ? [kc, e.kc] : [e.kc, kc];
      if (court.length >= 6 && long_.includes(court) && court.length / long_.length >= 0.6) {
        s = Math.max(s, 0.9);
      }
    }
    if (s > bs) { bs = s; best = e; }
  }
  return bs >= SEUIL ? { e: best, score: bs } : { e: best, score: bs, rejete: true };
}

(async () => {
  const c = await oracledb.getConnection({
    user: process.env.ORA_USER, password: process.env.ORA_PASSWORD,
    connectString: process.env.ORA_CONNECT, configDir: process.env.ORA_WALLET_DIR,
    walletLocation: process.env.ORA_WALLET_DIR, walletPassword: process.env.ORA_WALLET_PASSWORD,
  });

  const ents = (await c.execute(
    `SELECT ID, RAISON_SOCIALE, VILLE FROM ENTREPRISES WHERE RAISON_SOCIALE IS NOT NULL`
  )).rows.map(e => { const k = cle(e.RAISON_SOCIALE); return { ...e, k, kc: k.replace(/ /g, '') }; })
    .filter(e => e.k);

  const contacts = (await c.execute(
    `SELECT ID, PRENOM, NOM, FONCTION, INTITULE_POSTE FROM CONTACTS ORDER BY ID`
  )).rows;

  console.log(`${ents.length} entreprises, ${contacts.length} contacts, seuil ${SEUIL}`);
  console.log(APPLIQUER ? '>> ECRITURE' : '>> SIMULATION (aucune ecriture)');
  console.log('');

  let lies = 0, rejetes = 0, sansCandidat = 0;
  for (const p of contacts) {
    const nom = [p.PRENOM, p.NOM].filter(Boolean).join(' ');
    const cands = candidats(p.INTITULE_POSTE, p.FONCTION);
    if (!cands.length) {
      sansCandidat++;
      console.log(`  ·  ${nom.padEnd(26)} aucun nom de societe dans le titre`);
      continue;
    }
    let retenu = null;
    for (const cand of cands) {
      const r = rapprocher(cand, ents);
      if (r && !r.rejete) { retenu = { ...r, cand }; break; }
      if (!retenu && r) retenu = { ...r, cand };
    }
    if (retenu && !retenu.rejete) {
      lies++;
      console.log(`  +  ${nom.padEnd(26)} « ${retenu.cand} » -> ${retenu.e.RAISON_SOCIALE} (${retenu.e.VILLE || '?'}) ${retenu.score.toFixed(2)}`);
      if (APPLIQUER) {
        await c.execute(`UPDATE CONTACTS SET ENTREPRISE_ID = :e WHERE ID = :i`,
                        { e: retenu.e.ID, i: p.ID }, { autoCommit: true });
      }
    } else {
      rejetes++;
      const p2 = retenu ? `meilleur « ${retenu.e?.RAISON_SOCIALE} » ${retenu.score.toFixed(2)}` : '';
      console.log(`  -  ${nom.padEnd(26)} « ${cands[0]} » sous le seuil — ${p2}`);
    }
  }

  console.log('');
  console.log(`rattaches        : ${lies}`);
  console.log(`sous le seuil    : ${rejetes}`);
  console.log(`sans candidat    : ${sansCandidat}`);
  if (APPLIQUER) {
    const v = (await c.execute(`SELECT COUNT(ENTREPRISE_ID) N FROM CONTACTS`)).rows[0].N;
    console.log(`ENTREPRISE_ID renseigne en base : ${v}`);
  }
  await c.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
