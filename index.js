/**
 * WhatsApp Bulk Messaging & Automation Platform
 * Backend: Node.js + @whiskeysockets/baileys
 * 
 * IMPORTANT: Use only for opted-in contacts. Bulk unsolicited
 * messaging violates WhatsApp ToS and risks account bans.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ─── Config ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LOG_FILE = path.join(DATA_DIR, 'app.log');

// Ensure dirs exist
[DATA_DIR, SESSIONS_DIR, CAMPAIGNS_DIR, HISTORY_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Simple Logger ───────────────────────────────────────────────────────────
const log = {
  _write(level, msg, data) {
    const entry = { ts: new Date().toISOString(), level, msg, ...(data || {}) };
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line);
    console.log(`[${level.toUpperCase()}] ${msg}`, data || '');
  },
  info: (msg, data) => log._write('info', msg, data),
  warn: (msg, data) => log._write('warn', msg, data),
  error: (msg, data) => log._write('error', msg, data),
};

// ─── SSE Event Bus ───────────────────────────────────────────────────────────
const eventBus = new EventEmitter();
eventBus.setMaxListeners(200);
const sseClients = new Map(); // userId -> Set of res objects

function sendSSE(userId, event, data) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch (_) {}
  });
}

function broadcastSSE(event, data) {
  sseClients.forEach((_, userId) => sendSSE(userId, event, data));
}

// ─── User Store ──────────────────────────────────────────────────────────────
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'waba_salt_2025').digest('hex');
}

// ─── Session Tokens ──────────────────────────────────────────────────────────
const activeSessions = new Map(); // token -> { userId, expires }

function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, { userId, expires: Date.now() + 86400000 * 7 });
  return token;
}

function validateToken(token) {
  const s = activeSessions.get(token);
  if (!s || s.expires < Date.now()) { activeSessions.delete(token); return null; }
  return s.userId;
}

// ─── WhatsApp Instance Manager ───────────────────────────────────────────────
const waInstances = new Map(); // userId -> WA instance state

async function getWALib() {
  try {
    return await import('@whiskeysockets/baileys');
  } catch (e) {
    log.error('Baileys not installed. Run: npm install @whiskeysockets/baileys', { err: e.message });
    return null;
  }
}

async function createWAInstance(userId) {
  const baileys = await getWALib();
  if (!baileys) return { error: 'Baileys library not available' };

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
  } = baileys;

  // Clean up existing
  if (waInstances.has(userId)) {
    try { waInstances.get(userId).sock?.end(); } catch (_) {}
  }

  const sessionPath = path.join(SESSIONS_DIR, userId);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const instance = {
    status: 'connecting',
    qr: null,
    sock: null,
    autoReplies: [],
    keywordTriggers: [],
    phoneNumber: null,
    connectedAt: null,
  };
  waInstances.set(userId, instance);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => ({
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  }),
          level: 'silent',
          info: () => {},
          error: () => {},
        }),
      },
      printQRInTerminal: false,
      logger: { 
         level: 'silent', 
         trace: () => {}, 
        debug: () => {}, 
        info: () => {}, 
  warn: () => {}, 
  error: () => {}, 
  fatal: () => {},
  child: () => ({ 
    level: 'silent', 
    trace: () => {}, 
    debug: () => {}, 
    info: () => {}, 
    warn: () => {}, 
    error: () => {}, 
    fatal: () => {},
  }) 
},
    });
    instance.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const QRCode = await import('qrcode');
          const qrDataURL = await QRCode.default.toDataURL(qr);
          instance.qr = qrDataURL;
          instance.status = 'qr_ready';
          sendSSE(userId, 'qr', { qr: qrDataURL });
          log.info(`QR generated for ${userId}`);
        } catch (e) {
          // Fallback: send raw QR string
          instance.qr = qr;
          instance.status = 'qr_ready';
          sendSSE(userId, 'qr', { qr, raw: true });
        }
      }

      if (connection === 'open') {
        instance.status = 'connected';
        instance.qr = null;
        instance.connectedAt = new Date().toISOString();
        instance.phoneNumber = sock.user?.id?.split(':')[0] || 'Unknown';
        sendSSE(userId, 'status', { status: 'connected', phone: instance.phoneNumber });
        log.info(`WA connected for ${userId}`, { phone: instance.phoneNumber });
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason;

        if (code === 401 || code === reason?.loggedOut) {
          instance.status = 'logged_out';
          sendSSE(userId, 'status', { status: 'logged_out' });
          log.warn(`WA logged out for ${userId}`);
          // Clean session
          try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
        } else if (code === 403) {
          instance.status = 'BANNED';
          sendSSE(userId, 'status', { status: 'BANNED' });
          log.warn(`WA BANNED for ${userId}`);
        } else if (connection === 'close' && instance.status !== 'logged_out') {
          instance.status = 'reconnecting';
          sendSSE(userId, 'status', { status: 'reconnecting' });
          setTimeout(() => createWAInstance(userId), 5000);
        }
      }
    });

    // Auto-reply handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';

        // Log incoming
        sendSSE(userId, 'incoming', { from, text, ts: Date.now() });

        // Check keyword triggers first
        const inst = waInstances.get(userId);
        let replied = false;
        if (inst?.keywordTriggers?.length) {
          for (const trigger of inst.keywordTriggers) {
            if (text.toLowerCase().includes(trigger.keyword.toLowerCase())) {
              try {
                await sock.sendMessage(from, { text: trigger.reply });
                replied = true;
              } catch (_) {}
              break;
            }
          }
        }

        // Global auto-reply
        if (!replied && inst?.autoReply) {
          try { await sock.sendMessage(from, { text: inst.autoReply }); } catch (_) {}
        }
      }
    });

    return { success: true };
  } catch (e) {
    instance.status = 'error';
    log.error(`WA init error for ${userId}`, { err: e.message });
    return { error: e.message };
  }
}

// ─── Campaign Engine ─────────────────────────────────────────────────────────
const activeCampaigns = new Map(); // campaignId -> { running, stop, paused }

function loadCampaign(userId, campaignId) {
  const f = path.join(CAMPAIGNS_DIR, `${userId}_${campaignId}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}

function saveCampaign(userId, campaignId, data) {
  const f = path.join(CAMPAIGNS_DIR, `${userId}_${campaignId}.json`);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

function listCampaigns(userId) {
  try {
    return fs.readdirSync(CAMPAIGNS_DIR)
      .filter(f => f.startsWith(`${userId}_`) && f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8')); }
        catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (_) { return []; }
}

function appendHistory(userId, entry) {
  const f = path.join(HISTORY_DIR, `${userId}.jsonl`);
  fs.appendFileSync(f, JSON.stringify(entry) + '\n');
}

function loadHistory(userId) {
  const f = path.join(HISTORY_DIR, `${userId}.jsonl`);
  try {
    return fs.readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

// Spin-tax: {option1|option2|option3}
function spinText(template) {
  return template.replace(/\{([^}]+)\}/g, (_, group) => {
    const opts = group.split('|');
    return opts[Math.floor(Math.random() * opts.length)];
  });
}

function formatNumber(num) {
  num = num.replace(/\D/g, '');
  if (!num.startsWith('1') && num.length === 10) num = '1' + num;
  return num + '@s.whatsapp.net';
}

async function runCampaign(userId, campaignId) {
  const campaign = loadCampaign(userId, campaignId);
  if (!campaign) return;

  const instance = waInstances.get(userId);
  if (!instance || instance.status !== 'connected') {
    campaign.status = 'error';
    campaign.error = 'WhatsApp not connected';
    saveCampaign(userId, campaignId, campaign);
    sendSSE(userId, 'campaign_update', campaign);
    return;
  }

  const ctrl = { running: true, paused: false };
  activeCampaigns.set(campaignId, ctrl);

  campaign.status = 'running';
  campaign.startedAt = new Date().toISOString();
  if (!campaign.progress) campaign.progress = 0;

  const numbers = campaign.numbers.slice(campaign.progress);

  for (let i = 0; i < numbers.length; i++) {
    if (!ctrl.running) break;
    while (ctrl.paused) await new Promise(r => setTimeout(r, 500));

    const rawNum = numbers[i];
    const jid = formatNumber(rawNum);
    const text = spinText(campaign.message);

    try {
      await instance.sock.sendMessage(jid, { text });
      campaign.sent = (campaign.sent || 0) + 1;
      campaign.progress++;
      appendHistory(userId, {
        ts: new Date().toISOString(),
        campaign: campaignId,
        number: rawNum,
        status: 'sent',
        message: text,
      });
      sendSSE(userId, 'log', {
        type: 'success',
        msg: `✓ Sent to ${rawNum}`,
        ts: Date.now(),
      });
    } catch (e) {
      const reason = e.message || 'Unknown';
      const isBanned = reason.includes('403') || reason.toLowerCase().includes('forbidden');
      campaign.failed = (campaign.failed || 0) + 1;
      campaign.progress++;
      appendHistory(userId, {
        ts: new Date().toISOString(),
        campaign: campaignId,
        number: rawNum,
        status: isBanned ? 'BANNED' : 'failed',
        reason,
      });
      sendSSE(userId, 'log', {
        type: isBanned ? 'banned' : 'error',
        msg: `✗ Failed ${rawNum}: ${reason}`,
        ts: Date.now(),
      });
    }

    // Throttle
    const delay = campaign.delay || 2000;
    const jitter = Math.random() * 1000;
    await new Promise(r => setTimeout(r, delay + jitter));

    campaign.remaining = campaign.numbers.length - campaign.progress;
    saveCampaign(userId, campaignId, campaign);
    sendSSE(userId, 'campaign_update', {
      id: campaign.id,
      sent: campaign.sent,
      failed: campaign.failed,
      progress: campaign.progress,
      remaining: campaign.remaining,
      total: campaign.numbers.length,
      status: campaign.status,
    });
  }

  if (ctrl.running) {
    campaign.status = 'completed';
    campaign.completedAt = new Date().toISOString();
    saveCampaign(userId, campaignId, campaign);
    sendSSE(userId, 'campaign_update', { ...campaign });
    sendSSE(userId, 'toast', { msg: `Campaign "${campaign.name}" completed!`, type: 'success' });
    log.info(`Campaign completed`, { userId, campaignId });
  }

  activeCampaigns.delete(campaignId);
}

// ─── Number Validator ────────────────────────────────────────────────────────
async function validateNumbers(userId, numbers) {
  const instance = waInstances.get(userId);
  if (!instance?.sock || instance.status !== 'connected') {
    return { error: 'WhatsApp not connected' };
  }

  const results = { valid: [], invalid: [], total: numbers.length };

  for (const num of numbers) {
    const cleaned = num.replace(/\D/g, '');
    try {
      const [result] = await instance.sock.onWhatsApp(cleaned);
      if (result?.exists) {
        results.valid.push(cleaned);
      } else {
        results.invalid.push(cleaned);
      }
    } catch (_) {
      results.invalid.push(cleaned);
    }
    await new Promise(r => setTimeout(r, 500));
    sendSSE(userId, 'validate_progress', {
      checked: results.valid.length + results.invalid.length,
      total: results.total,
      valid: results.valid.length,
    });
  }

  return results;
}

// ─── HTTP Router ─────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 10_000_000) reject(new Error('Too large')); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function getToken(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.replace('Bearer ', '').trim();
  if (bearer) return bearer;
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  } catch (_) {
    return '';
  }
}

function auth(req) {
  return validateToken(getToken(req));
}

// Serve static HTML
const HTML_FILE = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const method = req.method;

  // ── Serve frontend ──
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (_) {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }

  // ── SSE Endpoint ──
  if (pathname === '/api/events') {
    const urlToken = url.searchParams.get('token');
    const userId = urlToken ? validateToken(urlToken) : auth(req);
    if (!userId) { res.writeHead(401); res.end(); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(res);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.get(userId)?.delete(res);
    });
    return;
  }

  // ── Auth Routes ──
  if (pathname === '/api/auth/signup' && method === 'POST') {
    const { username, password } = await parseBody(req);
    if (!username || !password) return json(res, { error: 'Missing fields' }, 400);
    const users = loadUsers();
    if (users[username]) return json(res, { error: 'Username taken' }, 409);
    users[username] = { username, password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    const token = createToken(username);
    log.info('User registered', { username });
    return json(res, { token, username });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const { username, password } = await parseBody(req);
    const users = loadUsers();
    const user = users[username];
    if (!user || user.password !== hashPassword(password)) {
      return json(res, { error: 'Invalid credentials' }, 401);
    }
    const token = createToken(username);
    log.info('User logged in', { username });
    return json(res, { token, username });
  }

  // ── Protected Routes ──
  const userId = auth(req);
  if (!userId && pathname.startsWith('/api/')) {
    return json(res, { error: 'Unauthorized' }, 401);
  }

  // ── WhatsApp Routes ──
  if (pathname === '/api/wa/connect' && method === 'POST') {
    const result = await createWAInstance(userId);
    return json(res, result);
  }

  if (pathname === '/api/wa/status') {
    const inst = waInstances.get(userId);
    return json(res, inst
      ? { status: inst.status, phone: inst.phoneNumber, connectedAt: inst.connectedAt }
      : { status: 'disconnected' }
    );
  }

  if (pathname === '/api/wa/disconnect' && method === 'POST') {
    const inst = waInstances.get(userId);
    if (inst?.sock) {
      try { await inst.sock.logout(); } catch (_) {}
    }
    waInstances.delete(userId);
    const sessionPath = path.join(SESSIONS_DIR, userId);
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
    return json(res, { success: true });
  }

  if (pathname === '/api/wa/autoreply' && method === 'POST') {
    const { message, enabled } = await parseBody(req);
    const inst = waInstances.get(userId);
    if (!inst) return json(res, { error: 'Not connected' }, 400);
    inst.autoReply = enabled ? message : null;
    return json(res, { success: true });
  }

  if (pathname === '/api/wa/triggers' && method === 'POST') {
    const { triggers } = await parseBody(req);
    const inst = waInstances.get(userId);
    if (!inst) return json(res, { error: 'Not connected' }, 400);
    inst.keywordTriggers = triggers || [];
    return json(res, { success: true });
  }

  if (pathname === '/api/wa/triggers' && method === 'GET') {
    const inst = waInstances.get(userId);
    return json(res, { triggers: inst?.keywordTriggers || [] });
  }

  // ── Campaign Routes ──
  if (pathname === '/api/campaigns' && method === 'GET') {
    return json(res, { campaigns: listCampaigns(userId) });
  }

  if (pathname === '/api/campaigns' && method === 'POST') {
    const body = await parseBody(req);
    const { name, message, numbers, delay } = body;
    if (!name || !message || !numbers?.length) {
      return json(res, { error: 'Missing required fields' }, 400);
    }
    const campaignId = crypto.randomUUID();
    const campaign = {
      id: campaignId,
      userId,
      name,
      message,
      numbers,
      delay: delay || 2000,
      status: 'pending',
      sent: 0,
      failed: 0,
      progress: 0,
      remaining: numbers.length,
      createdAt: new Date().toISOString(),
    };
    saveCampaign(userId, campaignId, campaign);
    return json(res, { campaign });
  }

  const campaignMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/(\w+)$/);
  if (campaignMatch) {
    const [, campaignId, action] = campaignMatch;

    if (action === 'start' && method === 'POST') {
      const ctrl = activeCampaigns.get(campaignId);
      if (ctrl?.running) return json(res, { error: 'Already running' }, 400);
      runCampaign(userId, campaignId); // async, don't await
      return json(res, { success: true });
    }

    if (action === 'stop' && method === 'POST') {
      const ctrl = activeCampaigns.get(campaignId);
      if (ctrl) ctrl.running = false;
      const campaign = loadCampaign(userId, campaignId);
      if (campaign) {
        campaign.status = 'stopped';
        saveCampaign(userId, campaignId, campaign);
      }
      return json(res, { success: true });
    }

    if (action === 'pause' && method === 'POST') {
      const ctrl = activeCampaigns.get(campaignId);
      if (ctrl) ctrl.paused = !ctrl.paused;
      const campaign = loadCampaign(userId, campaignId);
      if (campaign) {
        campaign.status = ctrl?.paused ? 'paused' : 'running';
        saveCampaign(userId, campaignId, campaign);
      }
      return json(res, { paused: ctrl?.paused });
    }

    if (action === 'resume' && method === 'POST') {
      const ctrl = activeCampaigns.get(campaignId);
      if (ctrl) { ctrl.paused = false; return json(res, { success: true }); }
      runCampaign(userId, campaignId);
      return json(res, { success: true });
    }

    if (action === 'delete' && method === 'DELETE') {
      const ctrl = activeCampaigns.get(campaignId);
      if (ctrl) ctrl.running = false;
      const f = path.join(CAMPAIGNS_DIR, `${userId}_${campaignId}.json`);
      try { fs.unlinkSync(f); } catch (_) {}
      return json(res, { success: true });
    }
  }

  // ── Validate Numbers ──
  if (pathname === '/api/validate' && method === 'POST') {
    const { numbers } = await parseBody(req);
    if (!numbers?.length) return json(res, { error: 'No numbers provided' }, 400);
    const result = await validateNumbers(userId, numbers);
    return json(res, result);
  }

  // ── History ──
  if (pathname === '/api/history' && method === 'GET') {
    const history = loadHistory(userId);
    const campaign = url.searchParams.get('campaign');
    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q');
    let filtered = history;
    if (campaign) filtered = filtered.filter(h => h.campaign === campaign);
    if (status) filtered = filtered.filter(h => h.status === status);
    if (q) filtered = filtered.filter(h => h.number?.includes(q) || h.message?.includes(q));
    return json(res, { history: filtered.slice(-2000).reverse() });
  }

  if (pathname === '/api/history/stats' && method === 'GET') {
    const history = loadHistory(userId);
    const stats = {
      total: history.length,
      sent: history.filter(h => h.status === 'sent').length,
      failed: history.filter(h => h.status === 'failed').length,
      banned: history.filter(h => h.status === 'BANNED').length,
      uniqueContacts: new Set(history.map(h => h.number)).size,
    };
    return json(res, stats);
  }

  // ── Send Single Message ──
  if (pathname === '/api/send' && method === 'POST') {
    const { number, message } = await parseBody(req);
    const inst = waInstances.get(userId);
    if (!inst?.sock || inst.status !== 'connected') {
      return json(res, { error: 'WhatsApp not connected' }, 400);
    }
    try {
      const jid = formatNumber(number);
      await inst.sock.sendMessage(jid, { text: message });
      appendHistory(userId, { ts: new Date().toISOString(), number, status: 'sent', message });
      return json(res, { success: true });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── Keep-alive ping ──
  if (pathname === '/ping') {
    res.writeHead(200); res.end('pong');
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─── Auto-resume sessions on startup ─────────────────────────────────────────
async function autoResumeSessions() {
  const baileys = await getWALib();
  if (!baileys) { log.warn('Baileys unavailable, skipping session resume'); return; }
  try {
    const sessionDirs = fs.readdirSync(SESSIONS_DIR);
    for (const userId of sessionDirs) {
      const sessionPath = path.join(SESSIONS_DIR, userId);
      const credFile = path.join(sessionPath, 'creds.json');
      if (fs.existsSync(credFile)) {
        log.info(`Auto-resuming session for ${userId}`);
        await createWAInstance(userId);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } catch (e) {
    log.error('Error during session auto-resume', { err: e.message });
  }
}

// ─── Self-ping keep-alive ─────────────────────────────────────────────────────
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL + '/ping';
    http.get(url, () => {}).on('error', () => {});
  }, 14 * 60 * 1000); // every 14 minutes
}

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  log.info(`Server running on http://localhost:${PORT}`);
  await autoResumeSessions();
});

process.on('uncaughtException', e => log.error('Uncaught exception', { err: e.message }));
process.on('unhandledRejection', e => log.error('Unhandled rejection', { err: String(e) }));
