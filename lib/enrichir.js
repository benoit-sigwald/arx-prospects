'use strict';
/*
 * Moteur d'enrichissement — sources publiques uniquement.
 *
 * Ce qui a deja ete mesure, et qu'il ne faut pas redecouvrir :
 *
 *   - Le chemin gratuit ne donne pas d'adresse nominative. Le pilote du
 *     2026-08-26 sur 200 societes et 549 dirigeants a confirme 51,5 % des
 *     domaines et recolte 51 adresses — dont **zero** portant le nom d'un
 *     dirigeant connu. Ce sont des adresses de fonction (dpo@, drh@) ou du
 *     bruit. Le web public livre le standard, jamais le decideur.
 *   - Aucun open data ne fournit de contact nominatif (recherche Einstein du
 *     2026-08-20). C'est precisement ce qui reste payant.
 *
 * Le moteur ne cherche donc pas ce qui n'existe pas. Il fait trois choses que
 * les sources publiques savent faire, dans l'ordre de leur valeur :
 *
 *   1. verifier les adresses qu'on possede deja, avant de s'en servir ;
 *   2. tenir a jour la fiche societe (etat, effectif, SIREN) ;
 *   3. decouvrir le site web, qui qualifie sans donner de canal.
 *
 * Toute valeur produite est ecrite dans ENRICHISSEMENT avec sa source et sa
 * date, jamais par-dessus la donnee d'origine. Une deduction n'a pas le meme
 * statut qu'une observation, et un enrichissement de six mois ne vaut pas un
 * enrichissement d'hier.
 */
const dns = require('dns').promises;

const CONFIANCES = ['certain', 'probable', 'deduit'];

// Types du lot, declares une fois : sans eux Oracle les deduit de la premiere
// ligne, et une valeur nulle en tete ferait echouer les 499 suivantes.
const CH = { type: require('oracledb').STRING };
const BINDS_ENRICHISSEMENT = {
  c:  { ...CH, maxSize: 620 },
  ch: { ...CH, maxSize: 40 },
  v:  { ...CH, maxSize: 1000 },
  cf: { ...CH, maxSize: 12 },
  s:  { ...CH, maxSize: 60 },
  d:  { ...CH, maxSize: 500 },
};

const DDL_ENRICHISSEMENT = `
CREATE TABLE PROSPECTS.ENRICHISSEMENT (
  ID         NUMBER GENERATED ALWAYS AS IDENTITY,
  CIBLE      VARCHAR2(620) NOT NULL,
  TYPE_CIBLE VARCHAR2(14) NOT NULL,
  CHAMP      VARCHAR2(40) NOT NULL,
  VALEUR     VARCHAR2(1000),
  CONFIANCE  VARCHAR2(12) NOT NULL,
  SOURCE     VARCHAR2(60) NOT NULL,
  DETAIL     VARCHAR2(500),
  VU_LE      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT PK_ENRICHISSEMENT PRIMARY KEY (ID),
  -- Une source ne dit qu'une chose a la fois sur un champ : la reecrire est une
  -- mise a jour, pas une seconde verite.
  CONSTRAINT UQ_ENRICHISSEMENT UNIQUE (CIBLE, CHAMP, SOURCE),
  CONSTRAINT CK_ENR_TYPE CHECK (TYPE_CIBLE IN ('personne', 'organisation')),
  CONSTRAINT CK_ENR_CONF CHECK (CONFIANCE IN (${CONFIANCES.map(c => `'${c}'`).join(', ')}))
)`;

const INDEX_ENRICHISSEMENT = [
  `CREATE INDEX PROSPECTS.IX_ENR_CIBLE ON PROSPECTS.ENRICHISSEMENT (CIBLE)`,
  `CREATE INDEX PROSPECTS.IX_ENR_CHAMP ON PROSPECTS.ENRICHISSEMENT (CHAMP, VALEUR)`,
];

/* ------------------------------------------------ 1. l'adresse est-elle vivante */

// Adresses de service : elles arrivent quelque part, mais pas chez quelqu'un.
// Les melanger a du nominatif fausse tous les taux d'une campagne.
const PREFIXES_FONCTION = new Set(['contact', 'info', 'hello', 'bonjour', 'accueil',
  'commercial', 'sales', 'admin', 'administration', 'direction', 'secretariat',
  'compta', 'comptabilite', 'facturation', 'rh', 'drh', 'recrutement', 'jobs',
  'dpo', 'rgpd', 'privacy', 'legal', 'juridique', 'support', 'service', 'sav',
  'marketing', 'presse', 'press', 'communication', 'newsletter', 'no-reply',
  'noreply', 'postmaster', 'webmaster', 'abuse', 'invest', 'investors', 'ir']);

/*
 * Ce classement ne remplace pas INVESTORS.CONTACTS.EMAIL_STATUS, qui est plus
 * fin (938 nominative, 12 role, mesure le 2026-08-31) parce qu'il vient de la
 * collecte. Il sert la ou aucun statut n'existe, et surtout a une seule chose :
 * reperer les adresses de fonction, qu'il ne faut jamais traiter comme une
 * personne. « non_classee » dit qu'on ne sait pas — pas que l'adresse est
 * douteuse.
 */
function classerAdresse(email) {
  const [avant] = String(email).toLowerCase().split('@');
  const racine = avant.split('+')[0];
  if (PREFIXES_FONCTION.has(racine)) return 'fonction';
  // Un point ou un tiret entre deux blocs alphabetiques : prenom.nom, la forme
  // la plus courante d'une adresse nominative.
  if (/^[a-z]{2,}[._-][a-z]{2,}$/.test(racine)) return 'nominative';
  return 'non_classee';
}

/*
 * Verification MX.
 *
 * On s'arrete au MX : interroger le serveur en RCPT TO pour savoir si la boite
 * existe est intrusif, souvent bloque, et fait tomber l'IP dans des listes
 * noires. Le MX suffit a ecarter les domaines morts, qui sont la cause des
 * rebonds durs. La verification fine reste celle du routeur : Brevo rend les
 * `hard_bounce`, et c'est cette information-la qui fait foi.
 */
async function verifierDomaines(domaines, { simultanes = 12 } = {}) {
  const verdicts = new Map();
  const liste = [...domaines];
  let i = 0;

  async function ouvrier() {
    while (i < liste.length) {
      const d = liste[i++];
      try {
        const mx = await dns.resolveMx(d);
        verdicts.set(d, mx && mx.length
          ? { etat: 'mx_ok', detail: mx.sort((a, b) => a.priority - b.priority)[0].exchange }
          : { etat: 'mx_absent', detail: null });
      } catch (e) {
        // ENOTFOUND : le domaine n'existe pas. ENODATA : il existe mais ne
        // recoit pas de courrier. Les deux interdisent l'envoi, pour des
        // raisons differentes qu'il faut pouvoir relire.
        verdicts.set(d, {
          etat: e.code === 'ENOTFOUND' ? 'domaine_inconnu'
              : e.code === 'ENODATA' ? 'mx_absent' : 'indisponible',
          detail: e.code || String(e.message).slice(0, 120),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(simultanes, liste.length) }, ouvrier));
  return verdicts;
}

/*
 * L'enrichisseur « adresses ».
 *
 * Il ne cherche rien : il qualifie ce qu'on a deja. C'est le seul enrichissement
 * dont la valeur est immediate — 950 des 953 adresses d'INVESTORS n'ont jamais
 * servi, et un rebond dur coute plus cher qu'un envoi manque : il abime la
 * reputation de l'expediteur pour tous les envois suivants.
 */
async function enrichirAdresses(q, { appliquer = false, limite = null, qLot = null } = {}) {
  const r = await q(`SELECT PERSON_KEY, EMAIL FROM V_PERSONNES
                      WHERE EMAIL IS NOT NULL
                      ORDER BY PERSON_KEY
                      ${limite ? `FETCH FIRST ${Number(limite)} ROWS ONLY` : ''}`);

  // Un domaine se resout une fois pour toutes les adresses qui le portent :
  // 953 adresses ne font pas 953 requetes DNS.
  const domaines = new Set(r.rows.map(x => x.EMAIL.split('@')[1]).filter(Boolean));
  const verdicts = await verifierDomaines(domaines);

  const lignes = r.rows.map(x => ({
    cible: x.PERSON_KEY,
    domaine: x.EMAIL.split('@')[1],
    etat: (verdicts.get(x.EMAIL.split('@')[1]) || {}).etat || 'indisponible',
    detail: (verdicts.get(x.EMAIL.split('@')[1]) || {}).detail || null,
    forme: classerAdresse(x.EMAIL),
  }));

  const compte = cle => lignes.reduce((a, l) => (a[l[cle]] = (a[l[cle]] || 0) + 1, a), {});
  const resume = { adresses: lignes.length, domaines: domaines.size,
                   etats: compte('etat'), formes: compte('forme') };

  if (!appliquer) return { simulation: true, resume };

  // Deux champs, deux verites distinctes : la boite peut-elle recevoir, et
  // l'adresse designe-t-elle une personne. Les confondre ferait croire qu'une
  // adresse de fonction valide est un contact.
  const ecrire = async (champ, source, sel) => {
    const donnees = lignes.map(l => ({
      c: l.cible, ch: champ, v: sel(l).valeur, cf: sel(l).confiance,
      s: source, d: sel(l).detail || null,
    }));
    const SQL = `MERGE INTO ENRICHISSEMENT e
                 USING (SELECT :c CIBLE, :ch CHAMP, :s SOURCE FROM DUAL) s
                   ON (e.CIBLE = s.CIBLE AND e.CHAMP = s.CHAMP AND e.SOURCE = s.SOURCE)
                 WHEN MATCHED THEN UPDATE SET VALEUR = :v, CONFIANCE = :cf,
                        DETAIL = :d, VU_LE = SYSTIMESTAMP
                 WHEN NOT MATCHED THEN INSERT
                        (CIBLE, TYPE_CIBLE, CHAMP, VALEUR, CONFIANCE, SOURCE, DETAIL)
                   VALUES (:c, 'personne', :ch, :v, :cf, :s, :d)`;
    for (let i = 0; i < donnees.length; i += 500) {
      await qLot(SQL, donnees.slice(i, i + 500), BINDS_ENRICHISSEMENT);
    }
  };

  await ecrire('email_etat', 'mx', l => ({
    valeur: l.etat,
    // Le DNS est une observation, pas une deduction.
    confiance: l.etat === 'indisponible' ? 'deduit' : 'certain',
    detail: l.detail,
  }));
  await ecrire('email_forme', 'motif', l => ({
    valeur: l.forme,
    confiance: l.forme === 'non_classee' ? 'deduit' : 'probable',
    detail: l.domaine,
  }));

  return { simulation: false, resume };
}

/*
 * Ce que l'enrichissement a rendu, relu depuis la base.
 *
 * Toujours avec la date : un verdict MX de six mois ne vaut pas celui d'hier,
 * et c'est la seule facon de savoir ce qu'il faut refaire.
 */
const SQL_ETAT_ENRICHISSEMENT = `
  SELECT CHAMP, VALEUR, SOURCE, COUNT(*) N,
         MIN(VU_LE) PLUS_ANCIEN, MAX(VU_LE) PLUS_RECENT
    FROM ENRICHISSEMENT
   GROUP BY CHAMP, VALEUR, SOURCE
   ORDER BY CHAMP, N DESC`;

module.exports = {
  DDL_ENRICHISSEMENT, INDEX_ENRICHISSEMENT, CONFIANCES,
  classerAdresse, verifierDomaines, enrichirAdresses, SQL_ETAT_ENRICHISSEMENT,
};
