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

  // Static public assets allowed without auth (for lock screen logo & public pages like /asebc)
  const isAsebc = pathname === '/asebc' || pathname.startsWith('/asebc/');
  const isPublicAsset = pathname.startsWith('/assets/') || pathname === '/favicon.png' || isAsebc;

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
  <title>Réseau de décideurs &mdash; Accès Protégé | Arx Consulting</title>
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
      <img src="data:image/png;base64,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" alt="Arx Consulting" style="width:48px; height:48px; border-radius:12px;">
    </div>
    <h1>Réseau de décideurs</h1>
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
  if (pathname === '/asebc') {
    res.writeHead(301, { 'Location': '/asebc/' });
    res.end();
    return;
  }

  let filePath;
  if (pathname === '/asebc/') {
    filePath = path.join(PUBLIC_DIR, 'asebc', 'index.html');
  } else {
    filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  }

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
