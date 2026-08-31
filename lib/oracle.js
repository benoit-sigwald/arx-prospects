'use strict';
/*
 * Connexion Oracle partagee par le serveur et les scripts.
 *
 * Extrait de server.js le 2026-08-31 : la CLI d'export doit interroger la meme
 * base avec les memes identifiants. Deux implantations de la meme connexion,
 * c'est deux fois la meme panne a deboguer.
 *
 * Always Free plafonne a 21 sessions simultanees pour tout le parc : poolMax
 * reste bas, et une CLI ferme son pool en sortant.
 */
const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

const WALLET_DIR = process.env.ORA_WALLET_DIR || '/tmp/wallet';

// Le wallet arrive en base64 dans l'environnement du conteneur : on ne le
// re-extrait pas si le repertoire est deja peuple.
if (process.env.ORA_WALLET_B64 && !fs.existsSync(path.join(WALLET_DIR, 'tnsnames.ora'))) {
  const AdmZip = require('adm-zip');
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  new AdmZip(Buffer.from(process.env.ORA_WALLET_B64, 'base64')).extractAllTo(WALLET_DIR, true);
  console.log('wallet extrait dans', WALLET_DIR);
}

let _pool;
async function pool(poolMax = 4) {
  if (!_pool) {
    _pool = await oracledb.createPool({
      user: process.env.ORA_USER,
      password: process.env.ORA_PASSWORD,
      connectString: process.env.ORA_CONNECT,
      configDir: WALLET_DIR,
      walletLocation: WALLET_DIR,
      walletPassword: process.env.ORA_WALLET_PASSWORD,
      poolMin: 0, poolMax, poolTimeout: 120,
    });
  }
  return _pool;
}

async function q(sql, binds = {}, opts = {}) {
  const c = await (await pool()).getConnection();
  try { return await c.execute(sql, binds, { autoCommit: true, ...opts }); }
  finally { await c.close(); }
}

async function fermer() {
  if (_pool) { await _pool.close(0); _pool = null; }
}

module.exports = { oracledb, pool, q, fermer, WALLET_DIR };
