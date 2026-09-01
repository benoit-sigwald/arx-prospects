'use strict';
/*
 * L'etat commercial d'une personne, et le pipeline qui s'en deduit.
 *
 * Le probleme mesure le 2026-08-31 : `INVESTORS.DEMARCHAGE` porte 15 003 lignes
 * toutes en `a_contacter`, `DATE_CONTACT` nul partout — alors que
 * `INVESTORS.MAILING_SENDS` prouve que 19 messages sont partis vers 3 personnes,
 * dont 5 reponses et 3 rebonds. Les deux tables divergent deja. Sur 950 adresses
 * elles seraient illisibles.
 *
 * CONTACT_STATE est l'etat unique. Il est **creux** : une ligne n'existe que
 * pour une personne qui a un etat. Les 85 494 personnes de V_PERSONNES sont
 * `a_contacter` par defaut, sans occuper une ligne chacune.
 *
 * Deux familles de colonnes, et la frontiere ne doit jamais etre franchie :
 *
 *   machine  STATUT, OPT_OUT, DERNIER_CONTACT_LE, DERNIER_CANAL,
 *            DERNIERE_REPONSE_LE, MOTIF_PERTE, ORIGINE_ETAT
 *            -> reecrites a chaque reconciliation, depuis les faits.
 *   humain   PROPRIETAIRE, ACTION_NOTE, NOTES
 *            -> jamais touchees par la reconciliation.
 *   mixte    ACTION_TYPE, ACTION_LE
 *            -> amorcees par la reconciliation quand elles sont vides,
 *               jamais ecrasees ensuite.
 *
 * L'amorcage n'est pas une invention : une reponse que personne n'a prevu de
 * traiter est en retard par definition, et un envoi sans relance datee ne
 * reviendra jamais. Les delais sont nommes ci-dessous pour etre discutables.
 */

// B2.2 — le vocabulaire unique. Ordonne du plus faible au plus fort : la
// reconciliation ne fait jamais reculer un etat. Une personne qui a repondu ne
// peut pas redevenir « contactee » parce qu'un envoi plus recent existe.
const STATUTS = ['a_contacter', 'en_sequence', 'contacte', 'a_reveiller',
                 'a_repondu', 'en_discussion', 'rdv', 'perdu', 'gagne'];
const FORCE = Object.fromEntries(STATUTS.map((s, i) => [s, i]));

// `opt_out` n'est jamais un statut : c'est un drapeau. Un refus ne dit rien de
// l'avancement de la discussion, il dit qu'on n'ecrit plus.
const MOTIFS_PERTE = ['pas_interesse', 'mauvais_moment', 'concurrent',
                      'injoignable', 'hors_cible', 'opt_out'];

const TYPES_ACTION = ['email', 'appel', 'linkedin', 'relance', 'rdv', 'autre'];

// Les etats ou personne n'attend rien : pas de prochaine action exigee.
// `en_sequence` en fait partie — la sequence *est* la prochaine action, et
// l'exiger en plus obligerait a dater 950 lignes a la main.
const SANS_ACTION_DUE = ['a_contacter', 'en_sequence', 'gagne', 'perdu'];

// Delais d'amorcage, en jours apres le fait. A discuter, pas a deviner dans le
// code : ils sont ici, en clair, et une seule ligne les change.
const DELAIS = {
  a_repondu: 0,       // une reponse non traitee est due aujourd'hui
  contacte: 7,        // sans relance datee, un envoi ne revient jamais
  a_reveiller: 90,    // adresse morte ou froid : on repasse dans un trimestre
  en_discussion: 3,
  rdv: 0,
};

const DDL = `
CREATE TABLE PROSPECTS.CONTACT_STATE (
  PERSON_KEY          VARCHAR2(620) NOT NULL,
  STATUT              VARCHAR2(20) DEFAULT 'a_contacter' NOT NULL,
  OPT_OUT             NUMBER(1) DEFAULT 0 NOT NULL,
  OPT_OUT_LE          TIMESTAMP,
  PROPRIETAIRE        VARCHAR2(120),
  ACTION_TYPE         VARCHAR2(20),
  ACTION_LE           DATE,
  ACTION_NOTE         VARCHAR2(500),
  DERNIER_CONTACT_LE  TIMESTAMP,
  DERNIER_CANAL       VARCHAR2(20),
  DERNIERE_REPONSE_LE TIMESTAMP,
  MOTIF_PERTE         VARCHAR2(40),
  NOTES               VARCHAR2(2000),
  ORIGINE_ETAT        VARCHAR2(40),
  CREATED_AT          TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  UPDATED_AT          TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT PK_CONTACT_STATE PRIMARY KEY (PERSON_KEY),
  CONSTRAINT CK_CS_STATUT CHECK (STATUT IN (${STATUTS.map(s => `'${s}'`).join(', ')})),
  CONSTRAINT CK_CS_ACTION CHECK (ACTION_TYPE IS NULL OR ACTION_TYPE IN (${TYPES_ACTION.map(s => `'${s}'`).join(', ')})),
  CONSTRAINT CK_CS_PERTE  CHECK (MOTIF_PERTE IS NULL OR MOTIF_PERTE IN (${MOTIFS_PERTE.map(s => `'${s}'`).join(', ')})),
  -- B4.2 — aucune fiche active sans prochaine action datee. La contrainte le
  -- rend impossible, plutot qu'un ecran qui le rappelle et qu'on ignore.
  CONSTRAINT CK_CS_ACTION_DUE CHECK (
    STATUT IN (${SANS_ACTION_DUE.map(s => `'${s}'`).join(', ')})
    OR (ACTION_TYPE IS NOT NULL AND ACTION_LE IS NOT NULL))
)`;

const INDEX = [
  `CREATE INDEX PROSPECTS.IX_CS_ACTION ON PROSPECTS.CONTACT_STATE (ACTION_LE)`,
  `CREATE INDEX PROSPECTS.IX_CS_STATUT ON PROSPECTS.CONTACT_STATE (STATUT)`,
  `CREATE INDEX PROSPECTS.IX_CS_PROPRIO ON PROSPECTS.CONTACT_STATE (PROPRIETAIRE)`,
];

/*
 * Les faits, source par source, ramenes au vocabulaire unique.
 *
 * Chacune rend (PERSON_KEY, STATUT, OPT_OUT, DERNIER_CONTACT_LE, DERNIER_CANAL,
 * DERNIERE_REPONSE_LE, MOTIF_PERTE, ORIGINE_ETAT). L'agregation garde ensuite,
 * par personne, le statut le plus fort et les dates les plus recentes.
 */
/*
 * Depuis la tranche 3 de CapGrowthAI, l'etat commercial est PAR MANDAT :
 * le meme investisseur peut etre gagne sur un mandat et a contacter sur un
 * autre. Le mandat se lit sur la campagne qui a produit l'envoi.
 *
 * Les faits sans mandat determinable — DEMARCHAGE, opposition — ne creent
 * plus d'etat : ils portent l'opposition, qui est une decision de la personne
 * et non l'avancement d'une discussion. V_PERSONNES.OPT_OUT continue de la
 * rendre, inchangee.
 */
const FAITS = {
  // Ce qui est reellement parti. C'est la seule source qui prouve un envoi :
  // DEMARCHAGE, lui, n'a jamais ete mis a jour par le mailer.
  mailing: `
    SELECT 'inv:' || s.CONTACT_ID AS PERSON_KEY,
           CASE WHEN s.REPLIED_AT IS NOT NULL THEN 'a_repondu'
                WHEN s.BOUNCED_AT IS NOT NULL THEN 'perdu'
                ELSE 'contacte' END AS STATUT,
           0 AS OPT_OUT, CAST(NULL AS TIMESTAMP) AS OPT_OUT_LE,
           s.SENT_AT AS DERNIER_CONTACT_LE,
           'email' AS DERNIER_CANAL,
           s.REPLIED_AT AS DERNIERE_REPONSE_LE,
           -- Un rebond n'est pas une affaire perdue, c'est une adresse morte.
           -- Le dire ainsi evite de la relancer pendant des mois.
           CASE WHEN s.BOUNCED_AT IS NOT NULL THEN 'injoignable' END AS MOTIF_PERTE,
           'mailing' AS ORIGINE_ETAT,
           c.CLIENT_ID AS CLIENT_ID
      FROM INVESTORS.MAILING_SENDS s
      JOIN INVESTORS.MAILING_CAMPAIGNS c ON c.CAMPAIGN_ID = s.CAMPAIGN_ID
     WHERE s.CONTACT_ID IS NOT NULL AND c.CLIENT_ID IS NOT NULL`,
};

/*
 * Reconciliation.
 *
 * Rejouable sans degat : un MERGE par personne, qui ne descend jamais le statut
 * et ne touche aucune colonne humaine. La relancer deux fois de suite donne le
 * meme resultat.
 */
async function reconcilier(q, { appliquer = false } = {}) {
  const union = Object.values(FAITS).join('\n    UNION ALL\n');

  // Un etat sans action due ne recoit rien ; les autres sont dates depuis le
  // fait qui les a produits, pas depuis la date du jour — sinon rejouer la
  // reconciliation repousserait indefiniment toutes les echeances.
  const actifs = STATUTS.filter(s => !SANS_ACTION_DUE.includes(s));
  const ACTION_AMORCEE =
    `CASE WHEN f.STATUT IN (${actifs.map(s => `'${s}'`).join(', ')}) THEN 'relance' END`;
  const DATE_AMORCEE =
    `CASE ${actifs.map(s =>
      `WHEN f.STATUT = '${s}' THEN TRUNC(NVL(f.DERNIERE_REPONSE_LE, NVL(f.DERNIER_CONTACT_LE, SYSTIMESTAMP))) + ${DELAIS[s] ?? 7}`
     ).join('\n         ')} END`;

  // Le statut le plus fort gagne. Le classement vit dans le SQL par un DECODE
  // explicite : le lire dans le plan d'execution vaut mieux que le deviner.
  const rang = STATUTS.map((s, i) => `'${s}', ${i}`).join(', ');
  const agrege = `
    SELECT PERSON_KEY, CLIENT_ID,
           MAX(OPT_OUT) AS OPT_OUT,
           MAX(OPT_OUT_LE) AS OPT_OUT_LE,
           MAX(DERNIER_CONTACT_LE) AS DERNIER_CONTACT_LE,
           MAX(DERNIERE_REPONSE_LE) AS DERNIERE_REPONSE_LE,
           MAX(STATUT) KEEP (DENSE_RANK LAST ORDER BY DECODE(STATUT, ${rang})) AS STATUT,
           MAX(DERNIER_CANAL) KEEP (DENSE_RANK LAST ORDER BY NVL(DERNIER_CONTACT_LE, TIMESTAMP '1970-01-01 00:00:00')) AS DERNIER_CANAL,
           MAX(MOTIF_PERTE) AS MOTIF_PERTE,
           LISTAGG(DISTINCT ORIGINE_ETAT, '+') WITHIN GROUP (ORDER BY ORIGINE_ETAT) AS ORIGINE_ETAT
      FROM (${union})
     GROUP BY PERSON_KEY, CLIENT_ID`;

  if (!appliquer) {
    const apercu = await q(`SELECT STATUT, SUM(OPT_OUT) OPT_OUT, COUNT(*) N
                            FROM (${agrege}) GROUP BY STATUT ORDER BY N DESC`);
    return { simulation: true, rows: apercu.rows };
  }

  const r = await q(`
    MERGE INTO PROSPECTS.CONTACT_STATE cible
    USING (${agrege}) f
      ON (cible.PERSON_KEY = f.PERSON_KEY AND cible.CLIENT_ID = f.CLIENT_ID)
    WHEN MATCHED THEN UPDATE SET
      -- On ne fait jamais reculer un etat : DECODE compare les deux rangs.
      STATUT = CASE WHEN DECODE(f.STATUT, ${rang}) > DECODE(cible.STATUT, ${rang})
                    THEN f.STATUT ELSE cible.STATUT END,
      OPT_OUT = GREATEST(cible.OPT_OUT, f.OPT_OUT),
      OPT_OUT_LE = NVL(cible.OPT_OUT_LE, f.OPT_OUT_LE),
      DERNIER_CONTACT_LE = GREATEST(NVL(cible.DERNIER_CONTACT_LE, f.DERNIER_CONTACT_LE),
                                    NVL(f.DERNIER_CONTACT_LE, cible.DERNIER_CONTACT_LE)),
      DERNIERE_REPONSE_LE = GREATEST(NVL(cible.DERNIERE_REPONSE_LE, f.DERNIERE_REPONSE_LE),
                                     NVL(f.DERNIERE_REPONSE_LE, cible.DERNIERE_REPONSE_LE)),
      DERNIER_CANAL = NVL(f.DERNIER_CANAL, cible.DERNIER_CANAL),
      MOTIF_PERTE = NVL(cible.MOTIF_PERTE, f.MOTIF_PERTE),
      ORIGINE_ETAT = f.ORIGINE_ETAT,
      -- Amorcage : on ne comble que le vide. Une action posee par quelqu'un
      -- reste telle quelle, meme si un fait plus recent arrive.
      ACTION_TYPE = NVL(cible.ACTION_TYPE, ${ACTION_AMORCEE}),
      ACTION_LE   = NVL(cible.ACTION_LE, ${DATE_AMORCEE}),
      UPDATED_AT = SYSTIMESTAMP
    WHEN NOT MATCHED THEN INSERT
      (PERSON_KEY, CLIENT_ID, STATUT, OPT_OUT, OPT_OUT_LE, DERNIER_CONTACT_LE,
       DERNIERE_REPONSE_LE, DERNIER_CANAL, MOTIF_PERTE, ORIGINE_ETAT,
       ACTION_TYPE, ACTION_LE)
      VALUES (f.PERSON_KEY, f.CLIENT_ID, f.STATUT, f.OPT_OUT, f.OPT_OUT_LE, f.DERNIER_CONTACT_LE,
              f.DERNIERE_REPONSE_LE, f.DERNIER_CANAL, f.MOTIF_PERTE, f.ORIGINE_ETAT,
              ${ACTION_AMORCEE}, ${DATE_AMORCEE})`);

  return { simulation: false, lignes: r.rowsAffected };
}

/* ===================== INTERACTIONS ET CAMPAGNES ====================== */

/*
 * INTERACTION — la frise. Un objet, pas un champ.
 *
 * `CONTACT_STATE.DERNIER_CONTACT_LE` ne disait ni quoi, ni combien de fois, ni
 * dans quel sens. Une frise repond a la seule question qu'on se pose avant de
 * decrocher : que s'est-il deja passe avec cette personne.
 *
 * Le principe qui commande tout : ce qu'une machine peut voir, une machine
 * l'ecrit. Envois, ouvertures, clics, reponses, rebonds et formulaires sont
 * ingeres ; l'humain ne saisit que ce qu'aucun systeme ne voit — l'appel et son
 * compte rendu. Un CRM qui demande de tout retaper n'est pas rempli.
 *
 * (ORIGINE, SOURCE_REF) est unique : l'ingestion se rejoue sans doubler la
 * frise, et un evenement corrige remplace le sien.
 */
const CANAUX = ['email', 'linkedin', 'appel', 'formulaire', 'rencontre', 'autre'];
const TYPES_INTER = ['envoi', 'ouverture', 'clic', 'reponse', 'rebond', 'plainte',
                     'invitation', 'message', 'visite', 'appel', 'inscription', 'note'];

const DDL_INTERACTION = `
CREATE TABLE PROSPECTS.INTERACTION (
  ID          NUMBER GENERATED ALWAYS AS IDENTITY,
  PERSON_KEY  VARCHAR2(620) NOT NULL,
  ORG_KEY     VARCHAR2(400),
  CAMPAGNE_ID NUMBER,
  QUAND       TIMESTAMP NOT NULL,
  CANAL       VARCHAR2(20) NOT NULL,
  TYPE        VARCHAR2(24) NOT NULL,
  SENS        VARCHAR2(8)  NOT NULL,
  RESUME      VARCHAR2(2000),
  ORIGINE     VARCHAR2(20) NOT NULL,
  SOURCE_REF  VARCHAR2(220) NOT NULL,
  AUTEUR      VARCHAR2(120),
  CREATED_AT  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT PK_INTERACTION PRIMARY KEY (ID),
  CONSTRAINT UQ_INTERACTION UNIQUE (ORIGINE, SOURCE_REF),
  CONSTRAINT CK_INT_CANAL CHECK (CANAL IN (${CANAUX.map(c => `'${c}'`).join(', ')})),
  CONSTRAINT CK_INT_TYPE  CHECK (TYPE IN (${TYPES_INTER.map(c => `'${c}'`).join(', ')})),
  CONSTRAINT CK_INT_SENS  CHECK (SENS IN ('sortant', 'entrant'))
)`;

/*
 * CAMPAGNE — une table de tete, pas un quatrieme silo.
 *
 * Trois notions de campagne coexistaient : INVESTORS.MAILING_CAMPAIGNS (le
 * mailer), PROSPECTS.LISTE (le ciblage) et les listes Linki. Aucune ne voyait
 * les autres. CAMPAGNE ne les remplace pas : elle les reference par
 * (MOTEUR, REF_EXTERNE) et repond enfin a « dans quoi cette personne est-elle
 * passee ».
 */
const MOTEURS = ['mailer', 'linki', 'manuel'];

const DDL_CAMPAGNE = `
CREATE TABLE PROSPECTS.CAMPAGNE (
  ID          NUMBER GENERATED ALWAYS AS IDENTITY,
  NOM         VARCHAR2(200) NOT NULL,
  MOTEUR      VARCHAR2(20) NOT NULL,
  REF_EXTERNE VARCHAR2(120),
  LISTE_ID    NUMBER,
  CANAL       VARCHAR2(20),
  DEBUT       TIMESTAMP,
  FIN         TIMESTAMP,
  CIBLES      NUMBER,
  NOTES       VARCHAR2(1000),
  CREATED_AT  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  UPDATED_AT  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT PK_CAMPAGNE PRIMARY KEY (ID),
  CONSTRAINT UQ_CAMPAGNE_REF UNIQUE (MOTEUR, REF_EXTERNE),
  CONSTRAINT CK_CAMP_MOTEUR CHECK (MOTEUR IN (${MOTEURS.map(c => `'${c}'`).join(', ')}))
)`;

const INDEX_CRM = [
  `CREATE INDEX PROSPECTS.IX_INT_PERSONNE ON PROSPECTS.INTERACTION (PERSON_KEY)`,
  `CREATE INDEX PROSPECTS.IX_INT_ORG ON PROSPECTS.INTERACTION (ORG_KEY)`,
  `CREATE INDEX PROSPECTS.IX_INT_QUAND ON PROSPECTS.INTERACTION (QUAND)`,
  `CREATE INDEX PROSPECTS.IX_INT_CAMP ON PROSPECTS.INTERACTION (CAMPAGNE_ID)`,
];

/*
 * Les evenements du mailer.
 *
 * Une ligne de MAILING_SENDS porte jusqu'a six horodatages : elle produit donc
 * jusqu'a six interactions, chacune avec sa date propre. Les aplatir en un seul
 * « dernier evenement » perdrait justement la frise.
 */
const EVENEMENTS_MAILER = [
  ['SENT_AT', 'envoi', 'sortant'],
  ['OPENED_AT', 'ouverture', 'entrant'],
  ['CLICKED_AT', 'clic', 'entrant'],
  ['REPLIED_AT', 'reponse', 'entrant'],
  ['BOUNCED_AT', 'rebond', 'entrant'],
  ['COMPLAINED_AT', 'plainte', 'entrant'],
];

function sqlEvenementsMailer() {
  return EVENEMENTS_MAILER.map(([col, type, sens]) => `
    SELECT 'inv:' || s.CONTACT_ID AS PERSON_KEY, s.${col} AS QUAND,
           'email' AS CANAL, '${type}' AS TYPE, '${sens}' AS SENS,
           CAST(s.RENDERED_SUBJECT AS VARCHAR2(2000)) AS RESUME,
           'mailing' AS ORIGINE, CAST(s.SEND_ID || ':${type}' AS VARCHAR2(220)) AS SOURCE_REF,
           CAST(s.CAMPAIGN_ID AS VARCHAR2(120)) AS REF_CAMPAGNE
      FROM INVESTORS.MAILING_SENDS s
     WHERE s.${col} IS NOT NULL AND s.CONTACT_ID IS NOT NULL`).join('\n    UNION ALL');
}

/*
 * Les inscriptions par formulaire.
 *
 * Une personne qui remplit le formulaire d'un site s'est presentee elle-meme :
 * c'est la seule interaction entrante qui precede tout demarchage, et la plus
 * qualifiante. Elle est lue dans V_PERSONNES, ou les 35 schemas GATE_* sont
 * deja reunis.
 */
const SQL_INSCRIPTIONS = `
    SELECT p.PERSON_KEY, p.VU_LE AS QUAND,
           'formulaire' AS CANAL, 'inscription' AS TYPE, 'entrant' AS SENS,
           CAST('Demande d' || CHR(39) || 'acces — ' || NVL(p.SOURCE_DETAIL, p.SOURCE)
                AS VARCHAR2(2000)) AS RESUME,
           'gate' AS ORIGINE, CAST(p.PERSON_KEY AS VARCHAR2(220)) AS SOURCE_REF,
           CAST(NULL AS VARCHAR2(120)) AS REF_CAMPAGNE
      FROM V_PERSONNES p
     WHERE p.SOURCE LIKE 'gate:%' AND p.VU_LE IS NOT NULL`;

/*
 * Ingestion, rejouable : la contrainte d'unicite absorbe les rejeux, et
 * l'organisation comme la campagne sont resolues au passage.
 */
async function ingererInteractions(q, { appliquer = false } = {}) {
  const faits = `${sqlEvenementsMailer()}\n    UNION ALL${SQL_INSCRIPTIONS}`;

  if (!appliquer) {
    const r = await q(`SELECT ORIGINE, TYPE, COUNT(*) N FROM (${faits})
                       GROUP BY ORIGINE, TYPE ORDER BY N DESC`);
    return { simulation: true, rows: r.rows };
  }

  const r = await q(`
    MERGE INTO INTERACTION cible
    USING (
      SELECT f.*, p.ORG_KEY, c.ID AS CAMPAGNE_ID, c.CLIENT_ID AS CLIENT_ID
        FROM (${faits}) f
        LEFT JOIN V_PERSONNES p ON p.PERSON_KEY = f.PERSON_KEY
        LEFT JOIN CAMPAGNE c ON c.REF_EXTERNE = f.REF_CAMPAGNE AND c.MOTEUR = 'mailer'
    ) f ON (cible.ORIGINE = f.ORIGINE AND cible.SOURCE_REF = f.SOURCE_REF)
    WHEN MATCHED THEN UPDATE SET
      QUAND = f.QUAND, ORG_KEY = f.ORG_KEY, CAMPAGNE_ID = f.CAMPAGNE_ID,
      CLIENT_ID = f.CLIENT_ID, RESUME = f.RESUME
    WHEN NOT MATCHED THEN INSERT
      (PERSON_KEY, ORG_KEY, CAMPAGNE_ID, CLIENT_ID, QUAND, CANAL, TYPE, SENS,
       RESUME, ORIGINE, SOURCE_REF)
      VALUES (f.PERSON_KEY, f.ORG_KEY, f.CAMPAGNE_ID, f.CLIENT_ID, f.QUAND, f.CANAL,
              f.TYPE, f.SENS, f.RESUME, f.ORIGINE, f.SOURCE_REF)`);
  return { simulation: false, lignes: r.rowsAffected };
}

/* Les campagnes du mailer, reprises telles quelles. */
async function ingererCampagnes(q, { appliquer = false } = {}) {
  const source = `
    SELECT CAST(c.CAMPAIGN_ID AS VARCHAR2(120)) AS REF_EXTERNE,
           CAST(c.NAME AS VARCHAR2(200)) AS NOM,
           'mailer' AS MOTEUR, 'email' AS CANAL,
           c.CREATED_AT AS DEBUT, c.TOTAL_TARGETED AS CIBLES,
           c.CLIENT_ID AS CLIENT_ID
      FROM INVESTORS.MAILING_CAMPAIGNS c`;
  if (!appliquer) {
    return { simulation: true, rows: (await q(`SELECT COUNT(*) N FROM (${source})`)).rows };
  }
  const r = await q(`
    MERGE INTO CAMPAGNE cible USING (${source}) s
      ON (cible.MOTEUR = s.MOTEUR AND cible.REF_EXTERNE = s.REF_EXTERNE)
    WHEN MATCHED THEN UPDATE SET NOM = s.NOM, DEBUT = s.DEBUT, CIBLES = s.CIBLES,
                                 CLIENT_ID = s.CLIENT_ID, UPDATED_AT = SYSTIMESTAMP
    WHEN NOT MATCHED THEN INSERT (NOM, MOTEUR, REF_EXTERNE, CANAL, DEBUT, CIBLES, CLIENT_ID)
                          VALUES (s.NOM, s.MOTEUR, s.REF_EXTERNE, s.CANAL, s.DEBUT, s.CIBLES, s.CLIENT_ID)`);
  return { simulation: false, lignes: r.rowsAffected };
}

/* La frise d'une personne, la plus recente d'abord. */
const SQL_FRISE = `
  SELECT i.ID, i.QUAND, i.CANAL, i.TYPE, i.SENS, i.RESUME, i.ORIGINE, i.AUTEUR,
         c.NOM AS CAMPAGNE
    FROM INTERACTION i
    LEFT JOIN CAMPAGNE c ON c.ID = i.CAMPAGNE_ID
   WHERE i.PERSON_KEY = :k
   ORDER BY i.QUAND DESC`;

/*
 * Le pipeline : chaque personne joignable, avec son etat.
 *
 * Jointure a gauche volontaire — l'absence de ligne d'etat *est* un etat :
 * `a_contacter`. Materialiser 85 494 lignes pour dire « rien ne s'est encore
 * passe » couterait de l'espace et une reconciliation a chaque import.
 */
const SQL_PIPELINE = `
  SELECT p.PERSON_KEY, p.SOURCE, p.FIRST_NAME, p.LAST_NAME, p.EMAIL, p.LINKEDIN_URL,
         p.TITLE, p.COMPANY, p.CITY, p.COUNTRY, p.PHONE, p.TERRITOIRE, p.SECTEUR,
         NVL(e.STATUT, 'a_contacter')      AS STATUT,
         GREATEST(NVL(e.OPT_OUT, 0), p.OPT_OUT) AS OPT_OUT,
         e.PROPRIETAIRE, e.ACTION_TYPE, e.ACTION_LE, e.ACTION_NOTE,
         e.DERNIER_CONTACT_LE, e.DERNIER_CANAL, e.DERNIERE_REPONSE_LE,
         e.MOTIF_PERTE, e.NOTES, e.ORIGINE_ETAT, e.UPDATED_AT,
         CASE WHEN e.ACTION_LE IS NULL THEN NULL
              ELSE TRUNC(e.ACTION_LE) - TRUNC(SYSDATE) END AS JOURS
    FROM V_PERSONNES p
    -- L'etat est desormais par mandat : sans ce filtre, une personne suivie
    -- sur deux mandats apparaitrait deux fois dans cet ecran, qui ne connait
    -- pas la notion. arx-prospects s'arrete a la tranche 4 ; d'ici la il
    -- montre l'etat le plus avance.
    LEFT JOIN (
      SELECT PERSON_KEY, MAX(STATUT) KEEP (DENSE_RANK LAST ORDER BY DECODE(STATUT,
                ${STATUTS.map((s, i) => `'${s}', ${i}`).join(', ')})) STATUT,
             MAX(OPT_OUT) OPT_OUT, MAX(PROPRIETAIRE) PROPRIETAIRE,
             MAX(ACTION_TYPE) ACTION_TYPE, MAX(ACTION_LE) ACTION_LE,
             MAX(ACTION_NOTE) ACTION_NOTE, MAX(DERNIER_CONTACT_LE) DERNIER_CONTACT_LE,
             MAX(DERNIER_CANAL) DERNIER_CANAL, MAX(DERNIERE_REPONSE_LE) DERNIERE_REPONSE_LE,
             MAX(MOTIF_PERTE) MOTIF_PERTE, MAX(NOTES) NOTES,
             MAX(ORIGINE_ETAT) ORIGINE_ETAT, MAX(UPDATED_AT) UPDATED_AT
        FROM CONTACT_STATE GROUP BY PERSON_KEY) e ON e.PERSON_KEY = p.PERSON_KEY`;

module.exports = { STATUTS, MOTIFS_PERTE, TYPES_ACTION, SANS_ACTION_DUE, DELAIS,
                   CANAUX, TYPES_INTER, MOTEURS,
                   DDL, INDEX, FAITS, reconcilier, SQL_PIPELINE,
                   DDL_INTERACTION, DDL_CAMPAGNE, INDEX_CRM, SQL_FRISE,
                   ingererInteractions, ingererCampagnes };
