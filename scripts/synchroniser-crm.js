'use strict';
/*
 * Passage de synchronisation du CRM.
 *
 *   node scripts/synchroniser-crm.js
 *
 * Rejoue les trois alimentations automatiques : l'etat commercial depuis les
 * faits, les campagnes du mailer, et les interactions. Sans lui, l'ecran
 * vieillit des le premier envoi — MAILING_SENDS avance, CONTACT_STATE non.
 *
 * Se connecte en PROSPECTS, pas en ADMIN : les tables existent deja et les
 * droits de lecture sur INVESTORS sont poses. Un passage de routine n'a aucune
 * raison de tourner avec un compte d'administration.
 *
 * Rejouable et sans effet de bord : la reconciliation ne fait jamais reculer un
 * statut ni ne touche les colonnes saisies a la main, et (ORIGINE, SOURCE_REF)
 * empeche de doubler la frise.
 */
const { q, fermer } = require('../lib/oracle');
const crm = require('../lib/crm');

async function main() {
  const t0 = Date.now();

  // L'ordre compte : les campagnes d'abord, sinon les interactions ne trouvent
  // pas a quelle campagne se rattacher et le lien reste nul jusqu'au passage
  // suivant.
  const camp = await crm.ingererCampagnes(q, { appliquer: true });
  const inter = await crm.ingererInteractions(q, { appliquer: true });
  const etat = await crm.reconcilier(q, { appliquer: true });

  const compte = await q(`SELECT
      (SELECT COUNT(*) FROM CAMPAGNE) CAMPAGNES,
      (SELECT COUNT(*) FROM INTERACTION) INTERACTIONS,
      (SELECT COUNT(*) FROM CONTACT_STATE) ETATS,
      (SELECT COUNT(*) FROM CONTACT_STATE WHERE STATUT = 'a_repondu') A_REPONDU,
      (SELECT COUNT(*) FROM CONTACT_STATE WHERE ACTION_LE < TRUNC(SYSDATE)) EN_RETARD
    FROM DUAL`);
  const c = compte.rows[0];

  console.log(`synchronisation en ${Math.round((Date.now() - t0) / 1000)} s — ` +
    `campagnes ${camp.lignes}, interactions ${inter.lignes}, etats ${etat.lignes} traites`);
  console.log(`  en base : ${c.CAMPAGNES} campagnes, ${c.INTERACTIONS} interactions, ` +
    `${c.ETATS} etats dont ${c.A_REPONDU} a traiter et ${c.EN_RETARD} en retard`);

  await fermer();
}

main().catch(async e => { console.error(e.message); await fermer().catch(() => {}); process.exit(1); });
