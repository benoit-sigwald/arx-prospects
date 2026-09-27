// server.js - Contact PACA powered exclusively by Oracle Autonomous Database 23ai (OCI)
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const oracledb = require('oracledb');

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.PACA_ACCESS_TOKEN || 'paca-arx-2026';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Oracle Database Connection Pool
let dbPool = null;

async function initOraclePool() {
  try {
    dbPool = await oracledb.createPool({
      user: process.env.ORA_USER || 'prospects',
      password: process.env.ORA_PASSWORD || 'PriefXOosnNJVChB0KlxM64k',
      connectString: process.env.ORA_CONNECT || 'arxdb01_low',
      configDir: process.env.ORA_WALLET_DIR || '/wallet',
      walletLocation: process.env.ORA_WALLET_DIR || '/wallet',
      walletPassword: process.env.ORA_WALLET_PASSWORD || 'Blackstone2026',
      poolMin: 2,
      poolMax: 10,
      poolIncrement: 2,
      poolTimeout: 60
    });
    console.log('[ORACLE ATP] Connection pool initialized successfully.');
  } catch (err) {
    console.error('[ORACLE ATP] Failed to initialize connection pool:', err);
  }
}

// Helpers
function parseCookies(request) {
  const list = {};
  const rc = request.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const clean = String(val).replace(/\r?\n|\r/g, ' ').replace(/"/g, '""');
  return `"${clean}"`;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Handle prefix stripping if mounted on /contact-paca
  if (pathname === '/contact-paca') {
    const search = parsedUrl.search || '';
    res.writeHead(301, { 'Location': '/contact-paca/' + search });
    res.end();
    return;
  }
  if (pathname.startsWith('/contact-paca/')) {
    pathname = pathname.slice('/contact-paca'.length) || '/';
  }

  // Health check
  if (pathname === '/health' || pathname === '/sante') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', oracle: !!dbPool }));
    return;
  }

  // Token Authentication Check
  const cookies = parseCookies(req);
  const queryToken = parsedUrl.query.token || parsedUrl.query.k;
  const headerToken = req.headers['x-access-token'];
  const cookieToken = cookies['paca_token'];

  const isTokenValid = (
    queryToken === ACCESS_TOKEN ||
    cookieToken === ACCESS_TOKEN ||
    headerToken === ACCESS_TOKEN
  );

  // If query token valid on page request, set persistent cookie and redirect to clean URL
  if (!pathname.startsWith('/api/') && queryToken === ACCESS_TOKEN) {
    res.writeHead(302, {
      'Set-Cookie': `paca_token=${ACCESS_TOKEN}; Path=/; Max-Age=2592000; SameSite=Lax`,
      'Location': req.url.split('?')[0] || '/'
    });
    res.end();
    return;
  }

  // Static public assets allowed without auth (for lock screen logo)
  const isPublicAsset = pathname.startsWith('/assets/') || pathname === '/favicon.png';

  // If not authenticated
  if (!isTokenValid && !isPublicAsset) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Accès non autorisé. Jeton requis.' }));
      return;
    }

    // Render Apple Gate Lockscreen
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contact PACA &mdash; Accès Protégé | Arx Consulting</title>
  <link rel="icon" type="image/png" href="assets/favicon.png">
  <link href="https://fonts.googleapis.com/css2?family=SF+Pro+Display:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #000000;
      --card: #1c1c1e;
      --blue: #0071e3;
      --blue-hover: #0077ed;
      --text: #f5f5f7;
      --text-sec: #86868b;
      --border: rgba(255, 255, 255, 0.12);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; }
    body {
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .gate-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 2.5rem 2rem;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      backdrop-filter: blur(20px);
    }
    .logo-badge {
      width: 52px;
      height: 52px;
      background: var(--blue);
      border-radius: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1.2rem;
      box-shadow: 0 4px 14px rgba(0, 113, 227, 0.4);
    }
    .logo-badge img {
      width: 32px;
      height: 32px;
      object-fit: contain;
    }
    h1 {
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    p {
      color: var(--text-sec);
      font-size: 0.92rem;
      line-height: 1.45;
      margin-bottom: 1.8rem;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      padding: 0.85rem 1rem;
      background: #2c2c2e;
      border: 1px solid var(--border);
      border-radius: 12px;
      color: #fff;
      font-size: 1rem;
      outline: none;
      text-align: center;
      letter-spacing: 0.05em;
    }
    input:focus {
      border-color: var(--blue);
      box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.3);
    }
    .btn-submit {
      background: var(--blue);
      color: #fff;
      border: none;
      padding: 0.85rem;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .btn-submit:hover {
      background: var(--blue-hover);
    }
    .footer-note {
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: #636366;
    }
    .error-msg {
      color: #ff453a;
      font-size: 0.82rem;
      margin-top: 0.5rem;
      display: none;
    }
  </style>
</head>
<body>
  <div class="gate-card">
    <div class="logo-badge">
      <img src="assets/arx-logo-blanc.png" alt="Arx Consulting">
    </div>
    <h1>Contact PACA</h1>
    <p>Accès restreint aux décideurs économiques de la Région Sud. Saisissez votre jeton de sécurité.</p>

    <form method="GET" action="" onsubmit="return handleAuth(event)">
      <div class="form-group">
        <input type="password" id="tokenInput" placeholder="Entrez le jeton d'accès" autocomplete="current-password" required autofocus>
        <button type="submit" class="btn-submit">Déverrouiller l'accès &rarr;</button>
        <div id="errorMsg" class="error-msg">Jeton d'accès invalide.</div>
      </div>
    </form>

    <div class="footer-note">
      Connecté à Oracle Autonomous Database (OCI) &bull; <a href="https://arxcapital.duckdns.org" target="_blank" style="color: inherit; text-decoration: underline;">Arx Consulting</a>
    </div>
  </div>

  <script>
    function handleAuth(e) {
      e.preventDefault();
      const val = document.getElementById('tokenInput').value.trim();
      if (!val) return false;
      window.location.href = window.location.pathname + '?token=' + encodeURIComponent(val);
      return false;
    }
  </script>
</body>
</html>`);
    return;
  }

  // =========================================================================
  // API ROUTING: LIVE ORACLE AUTONOMOUS DATABASE 23ai QUERIES
  // =========================================================================

  // Helper to get Oracle connection from pool
  async function getDb() {
    if (!dbPool) await initOraclePool();
    return await dbPool.getConnection();
  }

  // 1. STATS ENDPOINT: LIVE COUNTS FROM ORACLE
  if (pathname === '/api/stats') {
    let cn;
    try {
      cn = await getDb();
      const sql = `
        SELECT 
          COUNT(*) AS TOTAL,
          COUNT(CASE WHEN UPPER(c.FONCTION) LIKE '%SIDENT%' OR UPPER(c.FONCTION) LIKE '%RANT%' OR UPPER(c.FONCTION) LIKE '%DIRECTEUR%' OR UPPER(c.FONCTION) LIKE '%DIRIGEANT%' OR UPPER(c.FONCTION) LIKE '%FONDATEUR%' THEN 1 END) AS C_LEVEL,
          COUNT(CASE WHEN c.EMAIL IS NOT NULL OR c.TELEPHONE IS NOT NULL OR e.TELEPHONE IS NOT NULL THEN 1 END) AS ACTIONABLE,
          COUNT(CASE WHEN c.EMAIL IS NOT NULL THEN 1 END) AS WITH_EMAIL,
          COUNT(CASE WHEN c.TELEPHONE IS NOT NULL OR e.TELEPHONE IS NOT NULL THEN 1 END) AS WITH_PHONE,
          COUNT(CASE WHEN c.TELEPHONE LIKE '+336%' OR c.TELEPHONE LIKE '+337%' OR c.TELEPHONE LIKE '06%' OR c.TELEPHONE LIKE '07%' THEN 1 END) AS WITH_MOBILE,
          COUNT(CASE WHEN c.LINKEDIN_URL IS NOT NULL THEN 1 END) AS WITH_LINKEDIN,
          COUNT(CASE WHEN e.DEPARTEMENT = '06' OR e.TERRITOIRE = '06' OR SUBSTR(e.CODE_POSTAL, 1, 2) = '06' THEN 1 END) AS DEPT_06,
          COUNT(CASE WHEN e.DEPARTEMENT = '13' OR e.TERRITOIRE = '13' OR SUBSTR(e.CODE_POSTAL, 1, 2) = '13' THEN 1 END) AS DEPT_13,
          COUNT(CASE WHEN e.DEPARTEMENT = '83' OR e.TERRITOIRE = '83' OR SUBSTR(e.CODE_POSTAL, 1, 2) = '83' THEN 1 END) AS DEPT_83,
          COUNT(CASE WHEN e.DEPARTEMENT = '84' OR e.TERRITOIRE = '84' OR SUBSTR(e.CODE_POSTAL, 1, 2) = '84' THEN 1 END) AS DEPT_84,
          COUNT(CASE WHEN e.DEPARTEMENT = '05' OR e.TERRITOIRE = '05' OR SUBSTR(e.CODE_POSTAL, 1, 2) = '05' THEN 1 END) AS DEPT_05,
          COUNT(CASE WHEN e.DEPARTEMENT = '04' OR e.TERRITOIRE = '04' OR SUBSTR(e.CODE_POSTAL, 1, 2) = '04' THEN 1 END) AS DEPT_04
        FROM PROSPECTS.CONTACTS c
        LEFT JOIN PROSPECTS.ENTREPRISES e ON c.ENTREPRISE_ID = e.ID
      `;
      const result = await cn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const rEnt = await cn.execute('SELECT COUNT(*) AS CNT FROM PROSPECTS.ENTREPRISES');
      const data = result.rows[0];
      data.TOTAL_ENTREPRISES = rEnt.rows[0][0];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('Error in /api/stats:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      if (cn) try { await cn.close(); } catch(e){}
    }
    return;
  }

  // 1b. LIVE FULL SPECTRUM METRICS & SCALING DASHBOARD ENDPOINT
  if (pathname === '/api/live-stats') {
    let cn;
    try {
      cn = await getDb();

      // Master scale metrics
      const rEntTotal = await cn.execute('SELECT COUNT(*) FROM PROSPECTS.ENTREPRISES');
      const rEntPaca = await cn.execute(`
        SELECT COUNT(*) FROM PROSPECTS.ENTREPRISES 
        WHERE CODE_POSTAL LIKE '06%' OR CODE_POSTAL LIKE '13%' OR CODE_POSTAL LIKE '83%' 
           OR CODE_POSTAL LIKE '84%' OR CODE_POSTAL LIKE '04%' OR CODE_POSTAL LIKE '05%'
      `);
      const rEntWeb = await cn.execute('SELECT COUNT(*) FROM PROSPECTS.ENTREPRISES WHERE SITE_WEB IS NOT NULL');
      const rEntPhone = await cn.execute('SELECT COUNT(*) FROM PROSPECTS.ENTREPRISES WHERE TELEPHONE IS NOT NULL');

      const rContacts = await cn.execute(`
        SELECT 
          COUNT(*) AS TOTAL,
          COUNT(CASE WHEN EMAIL IS NOT NULL THEN 1 END) AS EMAILS,
          COUNT(CASE WHEN TELEPHONE IS NOT NULL THEN 1 END) AS PHONES,
          COUNT(CASE WHEN LINKEDIN_URL IS NOT NULL THEN 1 END) AS LINKEDINS,
          COUNT(CASE WHEN EMAIL IS NOT NULL OR TELEPHONE IS NOT NULL OR LINKEDIN_URL IS NOT NULL THEN 1 END) AS REACHABLE
        FROM PROSPECTS.CONTACTS
      `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      // C-Suite breakdown
      const rolesSql = `
        SELECT 
            CASE 
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DRH%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%RESSOURCES HUMAINES%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PEOPLE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%TALENT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%RECRUT%' THEN 'DRH / Head of People'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DIRECTEUR GENERAL%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PDG%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CEO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PRESIDENT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%GERANT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%FONDATEUR%' THEN 'CEO / Dirigeant / DG'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CTO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%TECHNIQUE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%ENGINEERING%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%ARCHITECT%' THEN 'CTO / Dir. Technique'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CFO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%FINANCE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%FINANCIER%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DAF%' THEN 'CFO / DAF'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CIO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DSI%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%INFORMATIQUE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%SYSTEMES D%' THEN 'CIO / DSI'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%COO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%OPERATION%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%EXPLOITATION%' THEN 'COO / Operations'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CAIO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%INTELLIGENCE ARTIFICIELLE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%IA%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%AI%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%MACHINE LEARNING%' THEN 'CAIO / Head of AI & ML'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CDO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DATA%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DONNEE%' THEN 'CDO / Head of Data'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CMO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%MARKETING%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%GROWTH%' THEN 'CMO / Marketing & Growth'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CRO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%COMMERCIAL%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%SALES%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%VENTES%' THEN 'CRO / Sales & Dev'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CPO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PRODUIT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PRODUCT%' THEN 'CPO / Head of Product'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CISO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CYBER%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%SECURITE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%RSSI%' THEN 'CISO / RSSI & Cyber'
                ELSE 'OTHER / SECTOR SPECIALISTS'
            END AS role_category,
            COUNT(*) AS total_count,
            COUNT(EMAIL) AS with_email,
            COUNT(TELEPHONE) AS with_phone,
            COUNT(LINKEDIN_URL) AS with_linkedin
        FROM PROSPECTS.CONTACTS
        GROUP BY 
            CASE 
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DRH%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%RESSOURCES HUMAINES%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PEOPLE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%TALENT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%RECRUT%' THEN 'DRH / Head of People'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DIRECTEUR GENERAL%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PDG%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CEO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PRESIDENT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%GERANT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%FONDATEUR%' THEN 'CEO / Dirigeant / DG'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CTO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%TECHNIQUE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%ENGINEERING%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%ARCHITECT%' THEN 'CTO / Dir. Technique'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CFO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%FINANCE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%FINANCIER%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DAF%' THEN 'CFO / DAF'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CIO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DSI%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%INFORMATIQUE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%SYSTEMES D%' THEN 'CIO / DSI'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%COO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%OPERATION%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%EXPLOITATION%' THEN 'COO / Operations'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CAIO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%INTELLIGENCE ARTIFICIELLE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%IA%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%AI%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%MACHINE LEARNING%' THEN 'CAIO / Head of AI & ML'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CDO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DATA%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%DONNEE%' THEN 'CDO / Head of Data'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CMO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%MARKETING%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%GROWTH%' THEN 'CMO / Marketing & Growth'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CRO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%COMMERCIAL%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%SALES%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%VENTES%' THEN 'CRO / Sales & Dev'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CPO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PRODUIT%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%PRODUCT%' THEN 'CPO / Head of Product'
                WHEN UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CISO%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%CYBER%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%SECURITE%' 
                  OR UPPER(NVL(FONCTION, INTITULE_POSTE)) LIKE '%RSSI%' THEN 'CISO / RSSI & Cyber'
                ELSE 'OTHER / SECTOR SPECIALISTS'
            END
        ORDER BY total_count DESC
      `;
      const rRoles = await cn.execute(rolesSql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      // Scraper Heartbeat
      let scraperInfo = { status: 'RUNNING', uptime_seconds: null, current_batch: 'Active Harvester' };
      try {
        const rHb = await cn.execute(`
          SELECT 
            SERVICE_NAME, STATUS, 
            TO_CHAR(STARTED_AT, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS STARTED_AT, 
            TO_CHAR(LAST_HEARTBEAT, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS LAST_HEARTBEAT,
            PROCESSED_COUNT, EXTRACTED_CXOS, CURRENT_BATCH, HOST_INFO,
            ROUND((SYSDATE - CAST(STARTED_AT AS DATE)) * 86400) AS UPTIME_SECONDS,
            ROUND((SYSDATE - CAST(LAST_HEARTBEAT AS DATE)) * 86400) AS SECONDS_SINCE_HEARTBEAT
          FROM PROSPECTS.INGESTION_HEARTBEAT 
          WHERE SERVICE_NAME = 'c_suite_harvester'
        `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

        if (rHb.rows && rHb.rows.length > 0) {
          scraperInfo = rHb.rows[0];
        }
      } catch (hbErr) {
        console.warn('Could not query INGESTION_HEARTBEAT:', hbErr.message);
      }

      const responsePayload = {
        refreshed_at: new Date().toISOString(),
        database: {
          total_entreprises: rEntTotal.rows[0][0],
          paca_entreprises: rEntPaca.rows[0][0],
          resolved_websites: rEntWeb.rows[0][0],
          hq_phones: rEntPhone.rows[0][0],
          total_contacts: rContacts.rows[0].TOTAL,
          verified_emails: rContacts.rows[0].EMAILS,
          direct_phones: rContacts.rows[0].PHONES,
          linkedin_profiles: rContacts.rows[0].LINKEDINS,
          actionable_contacts: rContacts.rows[0].REACHABLE
        },
        roles: rRoles.rows.map(r => ({
          role: r.ROLE_CATEGORY,
          total: r.TOTAL_COUNT,
          emails: r.WITH_EMAIL,
          phones: r.WITH_PHONE,
          linkedin: r.WITH_LINKEDIN
        })),
        scraper: scraperInfo
      };

      res.writeHead(200, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify(responsePayload));
    } catch (err) {
      console.error('Error in /api/live-stats:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      if (cn) try { await cn.close(); } catch(e){}
    }
    return;
  }

  // 2. FILTER OPTIONS ENDPOINT (Dynamic dropdown lists from Oracle)
  if (pathname === '/api/filter-options') {
    let cn;
    try {
      cn = await getDb();
      // Secteurs
      const rSecteurs = await cn.execute(`
        SELECT DISTINCT e.SECTEUR 
        FROM PROSPECTS.ENTREPRISES e 
        WHERE e.SECTEUR IS NOT NULL 
        ORDER BY e.SECTEUR
      `);
      // Top Villes
      const rVilles = await cn.execute(`
        SELECT e.VILLE, COUNT(*) AS CNT
        FROM PROSPECTS.ENTREPRISES e
        WHERE e.VILLE IS NOT NULL
        GROUP BY e.VILLE
        ORDER BY CNT DESC
        FETCH FIRST 80 ROWS ONLY
      `);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        secteurs: rSecteurs.rows.map(r => r[0]),
        villes: rVilles.rows.map(r => ({ ville: r[0], count: r[1] }))
      }));
    } catch (err) {
      console.error('Error in /api/filter-options:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      if (cn) try { await cn.close(); } catch(e){}
    }
    return;
  }

  // Helper to construct contact filter WHERE clauses and binds for both /api/contacts and /api/export
  function buildContactFilters(q) {
    const whereClauses = ["1=1"];
    const binds = {};

    if (q.ids && q.ids.trim()) {
      const idList = q.ids.split(',').map(x => parseInt(x)).filter(x => !isNaN(x)).slice(0, 5000);
      if (idList.length > 0) {
        whereClauses.push(`c.ID IN (${idList.join(',')})`);
      }
    }

    // Keyword search
    if (q.q && q.q.trim()) {
      whereClauses.push(`(
        UPPER(c.PRENOM || ' ' || c.NOM) LIKE :searchKey
        OR UPPER(NVL(e.RAISON_SOCIALE, ' ')) LIKE :searchKey
        OR UPPER(NVL(c.FONCTION, ' ')) LIKE :searchKey
        OR UPPER(NVL(c.EMAIL, ' ')) LIKE :searchKey
        OR UPPER(NVL(c.TELEPHONE, ' ')) LIKE :searchKey
        OR UPPER(NVL(e.TELEPHONE, ' ')) LIKE :searchKey
        OR UPPER(NVL(e.VILLE, ' ')) LIKE :searchKey
        OR UPPER(NVL(c.LOCALISATION, ' ')) LIKE :searchKey
        OR UPPER(NVL(e.SIREN, ' ')) LIKE :searchKey
        OR UPPER(NVL(e.CODE_NAF, ' ')) LIKE :searchKey
        OR UPPER(NVL(e.SECTEUR, ' ')) LIKE :searchKey
      )`);
      binds.searchKey = `%${q.q.trim().toUpperCase()}%`;
    }

    // Department
    if (q.dept && q.dept.trim()) {
      whereClauses.push(`(
        e.DEPARTEMENT = :dept 
        OR e.TERRITOIRE = :dept 
        OR SUBSTR(e.CODE_POSTAL, 1, 2) = :dept
        OR c.LOCALISATION LIKE '%' || :dept || '%'
      )`);
      binds.dept = q.dept.trim();
    }

    // Secteur
    if (q.secteur && q.secteur.trim()) {
      whereClauses.push(`(e.SECTEUR = :secteur OR e.CODE_NAF = :secteur)`);
      binds.secteur = q.secteur.trim();
    }

    // Ville
    if (q.ville && q.ville.trim()) {
      whereClauses.push(`(UPPER(e.VILLE) = :ville OR UPPER(c.LOCALISATION) LIKE '%' || :ville || '%')`);
      binds.ville = q.ville.trim().toUpperCase();
    }

    // Channels
    if (q.has_email === 'true' || q.has_email === '1') {
      whereClauses.push(`c.EMAIL IS NOT NULL`);
    }
    if (q.has_phone === 'true' || q.has_phone === '1') {
      whereClauses.push(`(c.TELEPHONE IS NOT NULL OR e.TELEPHONE IS NOT NULL)`);
    }
    if (q.has_mobile === 'true' || q.has_mobile === '1') {
      whereClauses.push(`(c.TELEPHONE LIKE '+336%' OR c.TELEPHONE LIKE '+337%' OR c.TELEPHONE LIKE '06%' OR c.TELEPHONE LIKE '07%')`);
    }
    if (q.has_actionable === 'true' || q.has_actionable === '1') {
      whereClauses.push(`(c.EMAIL IS NOT NULL OR c.TELEPHONE IS NOT NULL OR e.TELEPHONE IS NOT NULL)`);
    }
    if (q.has_c_level === 'true' || q.has_c_level === '1') {
      whereClauses.push(`(UPPER(c.FONCTION) LIKE '%SIDENT%' OR UPPER(c.FONCTION) LIKE '%RANT%' OR UPPER(c.FONCTION) LIKE '%DIRECTEUR%' OR UPPER(c.FONCTION) LIKE '%DIRIGEANT%' OR UPPER(c.FONCTION) LIKE '%FONDATEUR%')`);
    }
    if (q.has_website === 'true' || q.has_website === '1') {
      whereClauses.push(`e.SITE_WEB IS NOT NULL`);
    }

    // Role category
    if (q.fonction) {
      if (q.fonction === 'direction') {
        whereClauses.push(`(UPPER(c.FONCTION) LIKE '%DIRECTEUR%' OR UPPER(c.FONCTION) LIKE '%PRÉSIDENT%' OR UPPER(c.FONCTION) LIKE '%PRESIDENT%' OR UPPER(c.FONCTION) LIKE '%DG%')`);
      } else if (q.fonction === 'conseil') {
        whereClauses.push(`(UPPER(c.FONCTION) LIKE '%ADMINISTRATEUR%' OR UPPER(c.FONCTION) LIKE '%CONSEIL%' OR UPPER(c.FONCTION) LIKE '%SURVEILLANCE%')`);
      } else if (q.fonction === 'gerant') {
        whereClauses.push(`(UPPER(c.FONCTION) LIKE '%GÉRANT%' OR UPPER(c.FONCTION) LIKE '%GERANT%' OR UPPER(c.FONCTION) LIKE '%FONDATEUR%')`);
      } else if (q.fonction === 'rh') {
        whereClauses.push(`(UPPER(c.FONCTION) LIKE '%RH%' OR UPPER(c.FONCTION) LIKE '%RESSOURCES%')`);
      }
    }

    // Chiffre d'Affaires
    if (q.ca) {
      if (q.ca === '1m') whereClauses.push(`e.CA_EUR >= 1000000`);
      else if (q.ca === '5m') whereClauses.push(`e.CA_EUR >= 5000000`);
      else if (q.ca === '20m') whereClauses.push(`e.CA_EUR >= 20000000`);
      else if (q.ca === '50m') whereClauses.push(`e.CA_EUR >= 50000000`);
    }

    return { whereSql: whereClauses.join(' AND '), binds };
  }

  // 3. CONTACTS SEARCH & FILTER ENDPOINT (Paginated Real-Time SQL Query)
  if (pathname === '/api/contacts') {
    let cn;
    try {
      cn = await getDb();
      const q = parsedUrl.query;
      const page = Math.max(1, parseInt(q.page) || 1);
      const pageSize = Math.min(200, Math.max(10, parseInt(q.pageSize) || 50));
      const offset = (page - 1) * pageSize;

      const { whereSql, binds } = buildContactFilters(q);

      // Total count query
      const countSql = `
        SELECT COUNT(*) AS CNT
        FROM PROSPECTS.CONTACTS c
        LEFT JOIN PROSPECTS.V_ENTREPRISES_CONSOLIDEES e ON c.ENTREPRISE_ID = e.ID
        WHERE ${whereSql}
      `;
      const countRes = await cn.execute(countSql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const totalRows = countRes.rows[0].CNT;

      // Data query with consolidated enterprise details
      const dataSql = `
        SELECT 
          c.ID, c.PRENOM, c.NOM, c.FONCTION, c.EMAIL, c.TELEPHONE, c.LINKEDIN_URL, c.SOURCE AS CONTACT_SOURCE,
          e.ID AS ENTREPRISE_ID, e.RAISON_SOCIALE, e.SIREN, e.CODE_NAF, e.SECTEUR, 
          COALESCE(e.VILLE, c.LOCALISATION) AS VILLE, 
          e.CODE_POSTAL,
          e.DEPARTEMENT,
          e.EFFECTIF_ESTIME, e.CA_EUR, e.FORME_JURIDIQUE, e.SITE_WEB, e.ADRESSE, e.TELEPHONE AS ENT_PHONE
        FROM PROSPECTS.CONTACTS c
        LEFT JOIN PROSPECTS.V_ENTREPRISES_CONSOLIDEES e ON c.ENTREPRISE_ID = e.ID
        WHERE ${whereSql}
        ORDER BY 
          (CASE WHEN c.EMAIL IS NOT NULL THEN 0 WHEN c.TELEPHONE IS NOT NULL THEN 1 ELSE 2 END),
          NVL(e.RAISON_SOCIALE, c.NOM)
        OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
      `;

      const dataRes = await cn.execute(dataSql, { ...binds, offset, limit: pageSize }, { outFormat: oracledb.OUT_FORMAT_OBJECT });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: totalRows,
        page,
        pageSize,
        totalPages: Math.ceil(totalRows / pageSize),
        rows: dataRes.rows
      }));
    } catch (err) {
      console.error('Error in /api/contacts:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      if (cn) try { await cn.close(); } catch(e){}
    }
    return;
  }

  // Helper to sanitize field values for CSV export (strip bracket arrays, nulls, etc.)
  function cleanField(val) {
    if (val === null || val === undefined) return '';
    let str = String(val).trim();
    if (str.startsWith('["') && str.endsWith('"]')) {
      try {
        const arr = JSON.parse(str);
        if (Array.isArray(arr)) return arr.join(', ');
      } catch(e) {}
      str = str.replace(/[\[\]"']/g, '').trim();
    } else if (str.startsWith('["')) {
      str = str.replace(/[\[\]"']/g, '').trim();
    }
    return str;
  }

  // 4. EXPORT CSV STREAM DIRECTLY FROM ORACLE (FULL DATA FOR OUTBOUND CAMPAIGNS)
  if (pathname === '/api/export') {
    let cn;
    try {
      cn = await getDb();
      const q = parsedUrl.query;
      const { whereSql, binds } = buildContactFilters(q);

      const sql = `
        SELECT 
          c.PRENOM, c.NOM, c.FONCTION, c.EMAIL, 
          COALESCE(c.TELEPHONE, e.TELEPHONE) AS TELEPHONE, 
          c.LINKEDIN_URL,
          e.RAISON_SOCIALE, e.SIREN, e.CODE_NAF, e.SECTEUR, e.EFFECTIF_ESTIME, e.CA_EUR,
          COALESCE(e.VILLE, c.LOCALISATION) AS VILLE, 
          e.CODE_POSTAL,
          e.DEPARTEMENT,
          e.ADRESSE, e.SITE_WEB, e.FORME_JURIDIQUE
        FROM PROSPECTS.CONTACTS c
        LEFT JOIN PROSPECTS.V_ENTREPRISES_CONSOLIDEES e ON c.ENTREPRISE_ID = e.ID
        WHERE ${whereSql}
        ORDER BY (CASE WHEN c.EMAIL IS NOT NULL THEN 0 ELSE 1 END), NVL(e.RAISON_SOCIALE, c.NOM)
        FETCH FIRST 25000 ROWS ONLY
      `;

      const result = await cn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="contact_paca_oracle_full_export_${Date.now()}.csv"`
      });

      // UTF-8 BOM for Microsoft Excel compatibility
      res.write('\uFEFF');
      
      // Complete CSV Headers for Outbound Campaign
      const headers = [
        "Prénom", "Nom", "Fonction", "Email Professionnel", "Téléphone", "LinkedIn",
        "Entreprise", "SIREN", "Code NAF", "Secteur", "Effectif", "Chiffre d'Affaires (EUR)",
        "Ville", "Code Postal", "Département", "Adresse", "Site Web", "Forme Juridique"
      ];
      res.write(headers.map(escapeCsv).join(';') + '\r\n');

      for (const row of result.rows) {
        let prenom = cleanField(row.PRENOM);
        let nom = cleanField(row.NOM);
        let fonction = cleanField(row.FONCTION);

        // Sanitize synthetic DRH department records for clean mail merges
        if (nom.toUpperCase() === 'RESSOURCES HUMAINES' && (prenom.toUpperCase().startsWith('DIRECTION') || !prenom)) {
          prenom = 'Service';
          nom = 'Ressources Humaines';
          fonction = fonction || 'Direction des Ressources Humaines';
        }

        const line = [
          prenom,
          nom,
          fonction,
          cleanField(row.EMAIL),
          cleanField(row.TELEPHONE),
          cleanField(row.LINKEDIN_URL),
          cleanField(row.RAISON_SOCIALE),
          cleanField(row.SIREN),
          cleanField(row.CODE_NAF),
          cleanField(row.SECTEUR),
          cleanField(row.EFFECTIF_ESTIME),
          row.CA_EUR && row.CA_EUR > 0 ? String(row.CA_EUR) : '',
          cleanField(row.VILLE),
          cleanField(row.CODE_POSTAL),
          cleanField(row.DEPARTEMENT),
          cleanField(row.ADRESSE),
          cleanField(row.SITE_WEB),
          cleanField(row.FORME_JURIDIQUE)
        ];
        res.write(line.map(escapeCsv).join(';') + '\r\n');
      }
      res.end();
    } catch (err) {
      console.error('Error in /api/export:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      if (cn) try { await cn.close(); } catch(e){}
    }
    return;
  }

  // =========================================================================
  // STATIC FILES (index.html, logos, CSS - NO LOCAL DATA FILES)
  // =========================================================================
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Accès interdit');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    } else {
      headers['Cache-Control'] = 'public, max-age=86400';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

// Boot server & Oracle Pool
initOraclePool().then(() => {
  server.listen(PORT, () => {
    console.log(`[CONTACT PACA] Server listening on port ${PORT}`);
    console.log(`[SECURITY] Token protection active: ${ACCESS_TOKEN}`);
    console.log(`[DATABASE] Live connection to Oracle ATP 23ai active`);
  });
});
