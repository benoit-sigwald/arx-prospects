'use strict';
/*
 * Cree le socle du pont Oracle -> Linki dans le schema PROSPECTS :
 * les GRANT de lecture, la vue V_PERSONNES et la table LISTE.
 *
 *   node scripts/creer-pont-linki.js              simulation, ecrit le SQL
 *   node scripts/creer-pont-linki.js --appliquer  execute
 *
 * Se connecte en ADMIN : seul ADMIN peut accorder la lecture d'un schema a un
 * autre. A executer dans le conteneur gate, seul endroit qui ait node +
 * oracledb + le wallet :
 *
 *   sudo docker cp creer-pont-linki.js <gate>:/app/
 *   sudo docker exec -w /app -e AP="$(sudo cat /root/.ora_admin)" <gate> \
 *        node creer-pont-linki.js --appliquer
 *
 * Trois partis pris, tous mesures le 2026-08-31 :
 *
 *   - PROSPECTS possede la vue. C'est le schema auquel arx-prospects est deja
 *     connecte : aucune session supplementaire sur les 21 du Always Free,
 *     aucun nouvel identifiant a cabler.
 *   - Les branches GATE_* sont generees a l'execution depuis ALL_TABLES. Les 35
 *     schemas ont une signature de colonnes strictement identique (verifie), et
 *     un nouveau site n'exige que de rejouer ce script.
 *   - STATUT_SOURCE rend le statut brut de son gisement, sans traduction. Les
 *     trois vocabulaires (demarchage, fiche entreprise, acces au gate) ne sont
 *     pas comparables ; les unifier ici serait un mensonge. C'est B2.2 qui s'en
 *     charge, dans CONTACT_STATE. Le seul drapeau transverse et fiable a ce
 *     stade est OPT_OUT.
 */
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const APPLIQUER = process.argv.includes('--appliquer');

// Une adresse doit avoir la forme d'une adresse : l'import Waalaxy a decale des
// colonnes et EMAIL contient parfois une localisation. Meme regex que le
// serveur, pour que le filtre « avec e-mail » dise la meme chose partout.
const RE_EMAIL = `'^[^[:space:]@]+@[^[:space:]@]+\\.[A-Za-z]{2,}$'`;
const email = c => `LOWER(CASE WHEN REGEXP_LIKE(${c}, ${RE_EMAIL})
  AND NOT REGEXP_LIKE(${c}, '\\.(png|webp|jpg|jpeg|svg|gif)($|\\?)', 'i')
  AND NOT REGEXP_LIKE(${c}, '@(2x|3x|1x|[0-9]+w|[0-9]+h)', 'i') THEN ${c} END)`;
// Linki refuse toute URL qui n'est pas un profil personnel : une page societe
// ferait echouer la ligne a l'import. On ne la laisse pas sortir d'ici.
const linkedin = c => `CASE WHEN ${c} LIKE '%linkedin.com/in/%' THEN ${c} END`;

// Types cibles de la vue. Chaque branche caste explicitement : sans cela Oracle
// retient le type de la premiere branche et tronque silencieusement les autres.
const T = {
  PERSON_KEY: 'VARCHAR2(620)', SOURCE: 'VARCHAR2(40)',
  FIRST_NAME: 'VARCHAR2(120)', LAST_NAME: 'VARCHAR2(200)',
  EMAIL: 'VARCHAR2(320)', LINKEDIN_URL: 'VARCHAR2(500)',
  TITLE: 'VARCHAR2(400)', COMPANY: 'VARCHAR2(600)',
  CITY: 'VARCHAR2(160)', COUNTRY: 'VARCHAR2(64)', PHONE: 'VARCHAR2(60)',
  SOURCE_DETAIL: 'VARCHAR2(250)', OPT_OUT: 'NUMBER(1)', STATUT_SOURCE: 'VARCHAR2(30)',
  // Trois colonnes au-dela des dix canoniques, pour que le bouton « envoyer
  // vers Linki » des ecrans existants puisse rejouer le filtre affiche a
  // l'ecran. Sans elles, un ciblage fait par territoire ou par secteur devrait
  // etre retape en termes de personnes : c'est le copier-coller que B1.4
  // supprime.
  ENTREPRISE_ID: 'NUMBER', TERRITOIRE: 'VARCHAR2(10)', SECTEUR: 'VARCHAR2(200)',
  CODE_NAF: 'VARCHAR2(20)',
  // Le lien vers l'organisation. Sans lui, « toutes les personnes de ce fonds »
  // est une recherche de chaine de caracteres, et on ecrit deux fois a la meme
  // maison sans le voir.
  ORG_KEY: 'VARCHAR2(400)',
  // Quand cette personne est entree dans le referentiel. C'est le point de
  // depart de sa frise : sans lui, une inscription par formulaire n'a pas de
  // date et ne peut pas devenir une interaction.
  VU_LE: 'TIMESTAMP',
  // Les langues d'ecriture, en minuscules et separees par des virgules :
  // « fr,en ». Normalisees ici plutot qu'a l'ecran, pour que le filtre et le
  // choix du gabarit lisent la meme chose.
  LANGUES: 'VARCHAR2(60)',
};

// Une adresse chez un fournisseur grand public ne dit rien de l'employeur :
// regrouper sur « gmail.com » creerait une organisation de 38 personnes sans
// aucun rapport entre elles.
const DOMAINES_LIBRES = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr',
  'hotmail.com', 'hotmail.fr', 'outlook.com', 'outlook.fr', 'live.com', 'live.fr',
  'free.fr', 'orange.fr', 'wanadoo.fr', 'sfr.fr', 'laposte.net', 'icloud.com',
  'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'yandex.com'];

// Le domaine de l'adresse professionnelle est la cle de rapprochement la plus
// sure dont on dispose sans referentiel commun.
const cleDomaine = col => `CASE WHEN INSTR(${col}, '@') > 0
        AND LOWER(SUBSTR(${col}, INSTR(${col}, '@') + 1)) NOT IN (${DOMAINES_LIBRES.map(d => `'${d}'`).join(', ')})
      THEN 'dom:' || LOWER(SUBSTR(${col}, INSTR(${col}, '@') + 1)) END`;
const COLS = Object.keys(T);
const c = (expr, col) => `CAST(${expr} AS ${T[col]})`;

/* Une branche = une ligne de valeurs dans l'ordre de COLS. */
function branche(vals) {
  return '  SELECT ' + COLS.map((k, i) => `${c(vals[i], k)} AS ${k}`).join(',\n         ');
}

// INVESTORS : 15 001 fiches, dont 3 828 joignables (953 e-mails, 3 663 profils
// LinkedIn). FULL_NAME est le seul champ toujours rempli — 79 fiches n'ont pas
// de prenom, 7 pas de nom : on le decoupe en secours plutot que d'exporter une
// ligne sans nom, que Linki accepterait mais qu'aucun template ne saurait
// personnaliser.
const INVESTORS = branche([
  `'inv:' || c.CONTACT_ID`,
  `'investors'`,
  `NVL(c.FIRST_NAME, REGEXP_SUBSTR(c.FULL_NAME, '^[^[:space:]]+'))`,
  `NVL(c.LAST_NAME, NULLIF(TRIM(REGEXP_REPLACE(c.FULL_NAME, '^[^[:space:]]+[[:space:]]*', '')), ''))`,
  email('c.EMAIL'), linkedin('c.LINKEDIN_URL'),
  `c.JOB_TITLE`, `c.ORG_NAME`, `c.CITY`, `c.COUNTRY`,
  `NVL(c.PHONE_MOBILE, c.PHONE)`,
  // Le libelle du manifeste (« FR/FranceInvest ») dit d'ou vient la fiche ;
  // l'URL de collecte ne le dit qu'a qui sait la lire.
  `NVL(JSON_VALUE(c.SOURCES, '$[0]'), c.SOURCE_URL)`,
  `NVL(d.OPT_OUT, 0)`,
  `d.STATUT`,
  `NULL`,
  `NULL`,
  `c.ORG_TYPE`,
  `NULL`,
  // ORG_KEY existe deja chez INVESTORS : c'est la cle de ORGANIZATIONS.
  `NVL('inv:' || c.ORG_KEY, ${cleDomaine('c.EMAIL')})`,
  `c.LOADED_AT`,
  `LOWER(REPLACE(REPLACE(REPLACE(NVL(JSON_SERIALIZE(c.LANGUAGES), ''), '[', ''), ']', ''), '"', ''))`,
]) + `
    FROM INVESTORS.CONTACTS c
    LEFT JOIN INVESTORS.DEMARCHAGE d ON d.CONTACT_ID = c.CONTACT_ID`;

// PROSPECTS.CONTACTS : 70 053 fiches mais 44 joignables. Les 69 377 lignes
// PACA/DINUM viennent du registre : un nom, jamais un canal. Elles restent dans
// la vue — c'est un referentiel de personnes, pas une liste d'envoi — et c'est
// l'export qui exige un canal.
const PROSPECTS_CONTACTS = branche([
  `'pro:' || c.ID`,
  `'prospects'`,
  `c.PRENOM`, `c.NOM`,
  email('c.EMAIL'), linkedin('c.LINKEDIN_URL'),
  `NVL(c.FONCTION, c.INTITULE_POSTE)`,
  `e.RAISON_SOCIALE`,
  `NVL(c.LOCALISATION, e.VILLE)`,
  // Le pays n'est pas stocke : il est deduit du rattachement a une entreprise
  // du referentiel PACA. Sans rattachement, on ne devine pas.
  `CASE WHEN e.TERRITOIRE IS NOT NULL THEN 'FR' END`,
  `c.TELEPHONE`,
  `NVL(c.LISTE_ORIGINE, c.SOURCE)`,
  `CASE WHEN c.OPPOSITION = 'O' THEN 1 ELSE 0 END`,
  `NULL`,
  `c.ENTREPRISE_ID`,
  `e.TERRITOIRE`,
  `e.SECTEUR_LIBELLE`,
  `e.CODE_NAF`,
  `NVL2(e.ID, 'ent:' || e.ID, ${cleDomaine('c.EMAIL')})`,
  `NVL(CAST(c.DATE_COLLECTE AS TIMESTAMP), c.CREATED_AT)`,
  // Registre francais, entreprises PACA : la langue n'est pas collectee mais
  // elle n'est pas non plus douteuse.
  `'fr'`,
]) + `
    FROM PROSPECTS.CONTACTS c
    LEFT JOIN PROSPECTS.ENTREPRISES e ON e.ID = c.ENTREPRISE_ID`;

// ENTREPRISES.DIRIGEANT : 54 499 noms rattaches par construction, sans canal
// direct. Aucun n'est exportable vers Linki ; ils sont la parce que la vue doit
// pouvoir remplacer la recherche de personnes de l'application, qui les montre
// deja, et parce que le telephone du siege reste un canal.
const PROSPECTS_DIRIGEANTS = branche([
  `'dir:' || e.ID`,
  `'prospects_dirigeant'`,
  `REGEXP_SUBSTR(e.DIRIGEANT, '^[^[:space:]]+')`,
  `NULLIF(TRIM(REGEXP_REPLACE(e.DIRIGEANT, '^[^[:space:]]+[[:space:]]*', '')), '')`,
  `NULL`, `NULL`,
  `'Dirigeant'`,
  `e.RAISON_SOCIALE`, `e.VILLE`, `'FR'`, `e.TELEPHONE`,
  `e.SOURCE`,
  `0`,
  `NULL`,
  `e.ID`,
  `e.TERRITOIRE`,
  `e.SECTEUR_LIBELLE`,
  `e.CODE_NAF`,
  `'ent:' || e.ID`,
  `NVL(CAST(e.DATE_COLLECTE AS TIMESTAMP), e.CREATED_AT)`,
  `'fr'`,
]) + `
    FROM PROSPECTS.ENTREPRISES e
   WHERE e.DIRIGEANT IS NOT NULL AND TRIM(e.DIRIGEANT) IS NOT NULL`;

/*
 * Une branche par schema GATE_*. Le formulaire du gate est le seul gisement
 * entrant : la personne s'est presentee elle-meme.
 *
 * CONSENT_RGPD pilote OPT_OUT. Une fiche sans consentement enregistre est
 * traitee comme un refus, pas comme une inconnue : c'est le sens defensif du
 * drapeau, et le cout d'une erreur est asymetrique.
 *
 * COUNTRY et CITY viennent de la geolocalisation IP, pas d'une declaration.
 * Ce ne sont pas les memes objets que le COUNTRY ISO-2 d'INVESTORS ; ils
 * cohabitent dans la meme colonne parce que Linki attend du texte libre.
 */
function brancheGate(owner) {
  const site = owner.replace(/^GATE_/, '').toLowerCase();
  return branche([
    `'gate:${site}:' || p.ID`,
    `'gate:${site}'`,
    `p.FIRST_NAME`, `p.LAST_NAME`,
    email('p.EMAIL'), `NULL`,
    `NULL`,
    `p.COMPANY`, `p.CITY`, `p.COUNTRY`, `p.PHONE`,
    `'formulaire ' || NVL(p.SITE, '${site}')`,
    `CASE WHEN NVL(p.CONSENT_RGPD, 0) = 1 THEN 0 ELSE 1 END`,
    `p.STATUS`,
    `NULL`,
    `NULL`,
    // INTEREST est ce que la personne a coche en demandant l'acces : c'est le
    // seul equivalent de secteur cote formulaire, et il est declaratif.
    `p.INTEREST`,
    `NULL`,
    // Cote formulaire il n'y a ni ORG_KEY ni entreprise du referentiel : le
    // domaine professionnel est le seul rattachement possible.
    cleDomaine('p.EMAIL'),
    `p.CREATED_AT`,
    `LOWER(SUBSTR(p.LANG, 1, 2))`,
  ]) + `
    FROM ${owner}.PROSPECTS p`;
}

/*
 * V_ORGANISATIONS — la colonne vertebrale qui manquait.
 *
 * Une personne appartient a une maison. Tant que COMPANY etait une chaine de
 * caracteres, « toutes les personnes de ce fonds » etait une recherche de
 * texte, et rien n'empechait d'ecrire deux fois a la meme adresse.
 *
 * Comme V_PERSONNES : une vue, pas une copie. INVESTORS.ORGANIZATIONS porte
 * deja 20 164 maisons, PROSPECTS.ENTREPRISES 54 499 societes ; les dupliquer
 * dans une table creerait deux verites a synchroniser.
 *
 * Les personnes rattachees par le seul domaine de leur adresse (cle « dom: »)
 * n'ont pas de ligne ici : l'organisation est alors deduite, pas connue. La
 * requete de rapprochement les compte a part plutot que d'inventer une fiche.
 */
const VUE_ORGANISATIONS = `CREATE OR REPLACE VIEW PROSPECTS.V_ORGANISATIONS AS
  SELECT CAST('inv:' || o.ORG_KEY AS VARCHAR2(400))     AS ORG_KEY,
         CAST('investors' AS VARCHAR2(20))              AS SOURCE,
         CAST(o.ORG_NAME AS VARCHAR2(600))              AS NOM,
         CAST(o.ORG_TYPE AS VARCHAR2(200))              AS TYPE,
         CAST(o.CITY AS VARCHAR2(160))                  AS VILLE,
         CAST(o.COUNTRY AS VARCHAR2(64))                AS PAYS,
         CAST(o.WEBSITE AS VARCHAR2(500))               AS SITE_WEB,
         CAST(o.EMAIL AS VARCHAR2(320))                 AS EMAIL,
         CAST(o.PHONE AS VARCHAR2(60))                  AS TELEPHONE,
         CAST(o.LINKEDIN_URL AS VARCHAR2(500))          AS LINKEDIN_URL,
         CAST(o.REVENUE_EUR AS NUMBER)                  AS CA_EUR,
         CAST(o.HEADCOUNT_MIN AS NUMBER)                AS EFFECTIF,
         CAST(NULL AS VARCHAR2(10))                     AS TERRITOIRE,
         CAST(o.REGISTRATION_ID AS VARCHAR2(60))        AS IMMATRICULATION
    FROM INVESTORS.ORGANIZATIONS o
  UNION ALL
  SELECT CAST('ent:' || e.ID AS VARCHAR2(400)),
         CAST('prospects' AS VARCHAR2(20)),
         CAST(e.RAISON_SOCIALE AS VARCHAR2(600)),
         CAST(e.SECTEUR_LIBELLE AS VARCHAR2(200)),
         CAST(e.VILLE AS VARCHAR2(160)),
         CAST('FR' AS VARCHAR2(64)),
         CAST(e.SITE_WEB AS VARCHAR2(500)),
         CAST(NULL AS VARCHAR2(320)),
         CAST(e.TELEPHONE AS VARCHAR2(60)),
         CAST(NULL AS VARCHAR2(500)),
         CAST(e.CA_EUR AS NUMBER),
         CAST(e.EFFECTIF AS NUMBER),
         CAST(e.TERRITOIRE AS VARCHAR2(10)),
         CAST(e.SIREN AS VARCHAR2(60))
    FROM PROSPECTS.ENTREPRISES e`;

/*
 * LISTE stocke un filtre, jamais des lignes.
 *
 * Une liste figee se perime le jour ou une fiche est enrichie ou se retire.
 * En gardant le critere, un ciblage se rejoue et donne l'etat du referentiel au
 * moment ou on l'envoie, pas au moment ou on l'a pense.
 *
 * LINKI_INSTANCE et LINKI_LIST_ID disent ou le ciblage a atterri : une instance
 * Linki par client, donc la meme liste peut exister deux fois sans etre la meme.
 */
const DDL_LISTE = `
CREATE TABLE PROSPECTS.LISTE (
  ID             NUMBER GENERATED ALWAYS AS IDENTITY,
  NOM            VARCHAR2(160) NOT NULL,
  FILTRE         CLOB NOT NULL,
  CANAL          VARCHAR2(20) DEFAULT 'mixte' NOT NULL,
  LINKI_INSTANCE VARCHAR2(60),
  LINKI_LIST_ID  VARCHAR2(64),
  DERNIER_ENVOI  TIMESTAMP,
  LIGNES_ENVOYEES NUMBER,
  CREE_PAR       VARCHAR2(120),
  NOTES          VARCHAR2(1000),
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  UPDATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT PK_LISTE      PRIMARY KEY (ID),
  CONSTRAINT UQ_LISTE_NOM  UNIQUE (NOM),
  CONSTRAINT CK_LISTE_JSON CHECK (FILTRE IS JSON),
  CONSTRAINT CK_LISTE_CANAL CHECK (CANAL IN ('email','linkedin','mixte'))
)`;

async function main() {
  const cn = await oracledb.getConnection({
    user: 'ADMIN',
    password: process.env.AP || process.env.ORA_ADMIN_PASSWORD,
    connectString: process.env.ORA_CONNECT,
    configDir: process.env.ORA_WALLET_DIR || '/tmp/wallet',
    walletLocation: process.env.ORA_WALLET_DIR || '/tmp/wallet',
    walletPassword: process.env.ORA_WALLET_PASSWORD,
  });

  const gates = (await cn.execute(
    `SELECT OWNER FROM ALL_TABLES
      WHERE TABLE_NAME = 'PROSPECTS' AND OWNER LIKE 'GATE\\_%' ESCAPE '\\'
      ORDER BY OWNER`)).rows.map(r => r.OWNER);
  console.log(`Schemas GATE_* avec une table PROSPECTS : ${gates.length}`);

  // Une signature de colonnes differente casserait la generation en silence :
  // on refuse de continuer plutot que de produire une vue bancale.
  const sig = (await cn.execute(
    `SELECT COUNT(DISTINCT SIG) N FROM (
       SELECT OWNER, LISTAGG(COLUMN_NAME, ',') WITHIN GROUP (ORDER BY COLUMN_NAME) SIG
         FROM ALL_TAB_COLUMNS
        WHERE TABLE_NAME = 'PROSPECTS' AND OWNER LIKE 'GATE\\_%' ESCAPE '\\'
        GROUP BY OWNER)`)).rows[0].N;
  if (sig !== 1) throw new Error(`${sig} signatures de colonnes differentes parmi les GATE_* : generation refusee`);

  const grants = [
    `GRANT SELECT ON INVESTORS.CONTACTS TO PROSPECTS`,
    `GRANT SELECT ON INVESTORS.DEMARCHAGE TO PROSPECTS`,
    `GRANT SELECT ON INVESTORS.ORGANIZATIONS TO PROSPECTS`,
    ...gates.map(g => `GRANT SELECT ON ${g}.PROSPECTS TO PROSPECTS`),
  ];

  const vue = `CREATE OR REPLACE VIEW PROSPECTS.V_PERSONNES AS\n` +
    [INVESTORS, PROSPECTS_CONTACTS, PROSPECTS_DIRIGEANTS, ...gates.map(brancheGate)]
      .join('\n  UNION ALL\n');

  const existeListe = (await cn.execute(
    `SELECT COUNT(*) N FROM ALL_TABLES WHERE OWNER = 'PROSPECTS' AND TABLE_NAME = 'LISTE'`)).rows[0].N > 0;

  const etapes = [
    ...grants.map(sql => ['grant', sql]),
    ['vue', vue],
    ['vue', VUE_ORGANISATIONS],
    // Pas de GRANT sur LISTE : la table nait dans le schema PROSPECTS, qui en
    // est donc proprietaire. Oracle refuse qu'un schema se donne un droit a
    // lui-meme (ORA-01749).
    ...(existeListe ? [] : [['table', DDL_LISTE]]),
  ];

  if (!APPLIQUER) {
    console.log(vue);
    console.log(`\n-- ${grants.length} GRANT, vue a ${3 + gates.length} branches, ` +
                `table LISTE ${existeListe ? 'deja presente' : 'a creer'}`);
    console.log('-- simulation : rien n\'a ete execute. Relancer avec --appliquer.');
    await cn.close();
    return;
  }

  for (const [type, sql] of etapes) {
    await cn.execute(sql);
    console.log(`  ok ${type} : ${sql.split('\n')[0].slice(0, 90)}`);
  }
  await cn.commit();

  // Une vue compilee n'est pas une vue qui repond : on la lit avant de dire oui.
  const controle = await cn.execute(
    `SELECT SOURCE, COUNT(*) LIGNES,
            COUNT(CASE WHEN EMAIL IS NOT NULL OR LINKEDIN_URL IS NOT NULL THEN 1 END) JOIGNABLES,
            SUM(OPT_OUT) OPT_OUT
       FROM PROSPECTS.V_PERSONNES
      GROUP BY SOURCE
      HAVING COUNT(*) > 0
      ORDER BY LIGNES DESC`);
  console.log('\nV_PERSONNES :');
  for (const r of controle.rows) {
    console.log(`  ${String(r.SOURCE).padEnd(22)} ${String(r.LIGNES).padStart(6)} lignes, ` +
                `${String(r.JOIGNABLES).padStart(5)} joignables, ${r.OPT_OUT} opt-out`);
  }
  await cn.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
