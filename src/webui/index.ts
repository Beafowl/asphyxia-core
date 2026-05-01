import { Router, RequestHandler, Request } from 'express';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import crypto from 'crypto';
import session from 'express-session';
import cookies from 'cookie-parser';
import createMemoryStore from 'memorystore';
import flash from 'connect-flash';
import { VERSION } from '../utils/Consts';
import {
  CONFIG_MAP,
  CONFIG_DATA,
  CONFIG,
  CONFIG_OPTIONS,
  SaveConfig,
  ARGS,
  DATAFILE_MAP,
  FILE_CHECK,
} from '../utils/ArgConfig';
import { get, isEmpty } from 'lodash';
import { Converter } from 'showdown';
import {
  ReadAssets,
  PLUGIN_PATH,
  GetProfileCount,
  GetProfiles,
  FindCardsByRefid,
  Count,
  FindProfile,
  PurgeProfile,
  UpdateProfile,
  CreateCard,
  FindCard,
  DeleteCard,
  APIFind,
  APIRemove,
  PluginStats,
  PurgePlugin,
  APIFindOne,
  APIInsert,
  APIUpdate,
  APIUpsert,
  APICount,
  CreateUserAccount,
  AuthenticateUser,
  UpdateUserAccount,
  GetAllUsers,
  SetUserAdmin,
  FindUserByUsername,
  FindUserByCardNumber,
  SaveTachiToken,
  GetTachiToken,
  DeleteTachiToken,
  SaveTachiExportTimestamp,
  GetTachiExportTimestamp,
  SaveTachiAutoExport,
  GetTachiAutoExport,
  SaveFlowerToken,
  GetFlowerToken,
  DeleteFlowerToken,
  GenerateApiToken,
  GetApiTokenByToken,
  GetApiTokenExists,
  DeleteApiToken,
  CreateOAuthClient,
  GetOAuthClient,
  GetOAuthClientsByUser,
  DeleteOAuthClient,
  CreateOAuthCode,
  ConsumeOAuthCode,
  CreateOAuthAccessToken,
  GetOAuthAccessToken,
  RefreshOAuthAccessToken,
  RevokeOAuthToken,
  GetOAuthTokensByUser,
  RevokeOAuthTokensByClientForUser,
} from '../utils/EamuseIO';
import { urlencoded, json } from 'body-parser';
import path from 'path';
import { ROOT_CONTAINER } from '../eamuse/index';
import { fun } from './fun';
import { card2nfc, nfc2card, cardType } from '../utils/CardCipher';
import { groupBy, startCase, lowerCase, upperFirst } from 'lodash';
import { sizeof } from 'sizeof';
import { ajax as emit } from './emit';
import { Logger } from '../utils/Logger';
import archiver from 'archiver';
const { serialize: nedbSerialize } = require('@seald-io/nedb/lib/model.js');

const memorystore = createMemoryStore(session);

const TACHI_BASE_URL = 'https://kamai.tachi.ac';
const FLOWER_BASE_URL = 'https://kailua.projectflower.eu';

const ADMIN_ONLY_PAGES = [
  'startup flags',
  'unlock events',
  'update webui assets',
  'weekly score attack',
  'custom charts admin',
];

const HIDDEN_NAV_PAGES = [
  'custom charts setup',
];

declare module 'express-session' {
  interface SessionData {
    user?: { username: string; cardNumber: string; admin: boolean };
  }
}

// Generate or load a persistent session secret
function getSessionSecret(): string {
  const secretPath = path.join(ARGS.savedata || 'savedata', '.session_secret');
  try {
    if (existsSync(secretPath)) {
      const stored = readFileSync(secretPath, 'utf8').trim();
      if (stored.length >= 32) return stored;
    }
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  try { writeFileSync(secretPath, secret, 'utf8'); } catch {}
  return secret;
}

export const webui = Router();
webui.use(
  session({
    cookie: { maxAge: 86400000, sameSite: 'lax', httpOnly: true },
    secret: getSessionSecret(),
    resave: true,
    saveUninitialized: false,
    store: new memorystore({ checkPeriod: 86400000 }),
  })
);
webui.use(cookies());

webui.use(flash());
webui.use(urlencoded({ extended: true, limit: '50mb' }));
let wrap =
  (fn: RequestHandler) =>
  (...args: any[]) =>
    (fn as any)(...args).catch(args[2]);

// Simple rate limiter for login attempts
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); // 15 min window
    return false;
  }
  entry.count++;
  return entry.count > 10; // Max 10 attempts per 15 minutes
}

// Auth routes (accessible without login)
webui.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: req.flash('authError')[0] || null });
});

webui.post(
  '/login',
  wrap(async (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    if (isRateLimited(clientIp)) {
      req.flash('authError', 'Too many login attempts. Please try again later.');
      return res.redirect('/login');
    }

    const { username, password } = req.body;
    if (!username || !password) {
      req.flash('authError', 'Please fill in all fields.');
      return res.redirect('/login');
    }

    const user = await AuthenticateUser(username, password);
    if (!user) {
      req.flash('authError', 'Invalid username or password.');
      return res.redirect('/login');
    }

    req.session.user = {
      username: user.username,
      cardNumber: user.cardNumber,
      admin: user.admin || false,
    };
    res.redirect('/');
  })
);

webui.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('signup', { error: req.flash('authError')[0] || null, old: {} });
});

webui.post(
  '/signup',
  wrap(async (req, res) => {
    const { username, password, confirmPassword, cardNumber } = req.body;
    const old = { username, cardNumber, password, confirmPassword };

    if (!username || !password || !confirmPassword || !cardNumber) {
      return res.render('signup', { error: 'Please fill in all fields.', old });
    }

    if (password !== confirmPassword) {
      return res.render('signup', { error: 'Passwords do not match.', old });
    }

    if (username.length < 3) {
      return res.render('signup', { error: 'Username must be at least 3 characters.', old });
    }

    if (password.length < 4) {
      return res.render('signup', { error: 'Password must be at least 4 characters.', old });
    }

    // Normalize: strip spaces/dashes, uppercase
    const normalized = cardNumber.replace(/[\s\-]/g, '').toUpperCase();

    // Determine NFC ID: if it looks like a hex NFC ID (16 hex chars), use directly;
    // otherwise treat as printed card number and convert to NFC ID
    let nfcId: string;
    try {
      if (/^[0-9A-F]{16}$/.test(normalized) && cardType(normalized) >= 0) {
        nfcId = normalized;
      } else {
        nfcId = card2nfc(normalized);
      }
    } catch {
      return res.render('signup', {
        error: 'Invalid card number format.',
        old,
      });
    }

    const card = await FindCard(nfcId);
    if (!card) {
      return res.render('signup', {
        error: 'Card number not found. You must have a registered card to sign up.',
        old,
      });
    }

    // Check if this card (or any other card on the same profile) is already owned by a user account
    if (card.__refid) {
      const profileCards = await FindCardsByRefid(card.__refid);
      if (profileCards && Array.isArray(profileCards)) {
        for (const c of profileCards) {
          const owner = await FindUserByCardNumber(c.cid);
          if (owner) {
            return res.render('signup', {
              error: 'This card number is already registered to an account.',
              old,
            });
          }
        }
      }
    } else {
      const existingAccount = await FindUserByCardNumber(nfcId);
      if (existingAccount) {
        return res.render('signup', {
          error: 'This card number is already registered to an account.',
          old,
        });
      }
    }

    const account = await CreateUserAccount(username, password, nfcId);
    if (!account) {
      return res.render('signup', { error: 'Username already exists.', old });
    }

    // Update the profile name to match the signup username
    if (card.__refid) {
      await UpdateProfile(card.__refid, { name: username });
    }

    req.session.user = { username, cardNumber: nfcId, admin: false };
    res.redirect('/');
  })
);

webui.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Help pages (accessible without login)
webui.get('/help/card-number', (_req, res) => {
  res.render('help_card_number');
});

// Tachi config endpoint (before auth middleware - needed by client-side JS)
webui.get('/tachi/config', (_req, res) => {
  res.json({ clientId: CONFIG.tachi_client_id || '' });
});

// Tachi OAuth callback (before auth middleware - opened in popup without session)
webui.get('/tachi/callback', (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing authorization code');
  // Sanitize code to prevent XSS: only allow alphanumeric + common OAuth chars
  const safeCode = code.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  res.send(`<html><body><script>
    console.log('[Tachi Callback] window.opener:', !!window.opener);
    if (window.opener) {
      window.opener.postMessage({ type: 'tachi-auth', code: '${safeCode}' }, window.location.origin);
      window.close();
    } else {
      document.getElementById('msg').innerHTML =
        '<strong>Authorization code received but could not communicate with the main window.</strong><br>' +
        'This can happen if popups are restricted. Please close this window and try again.';
    }
  </script><p id="msg">Authorization complete. You can close this window.</p></body></html>`);
});

// Project Flower config endpoint (before auth middleware)
webui.get('/flower/config', (_req, res) => {
  res.json({ clientId: CONFIG.flower_client_id || '' });
});

// Project Flower OAuth callback (before auth middleware - opened in popup without session)
webui.get('/flower/callback', (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing authorization code');
  const safeCode = code.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  res.send(`<html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'flower-auth', code: '${safeCode}' }, window.location.origin);
    }
    window.close();
  </script><p>Authorization complete. You can close this window.</p></body></html>`);
});

// =========================================
//             OAuth Provider (public endpoints)
// =========================================

// OAuth token endpoint - exchange authorization code for access token, or refresh
webui.post(
  '/oauth/token',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, refresh_token } = req.body;

    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !client_id || !client_secret) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      }

      const client = await GetOAuthClient(client_id);
      if (!client || client.clientSecret !== client_secret) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
      }

      const authCode = await ConsumeOAuthCode(code);
      if (!authCode) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
      }

      if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Code does not match request parameters' });
      }

      const tokens = await CreateOAuthAccessToken(client_id, authCode.username, authCode.scopes);
      if (!tokens) {
        return res.status(500).json({ error: 'server_error', error_description: 'Failed to create access token' });
      }

      return res.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: 86400,
        refresh_token: tokens.refreshToken,
        scope: authCode.scopes.join(' '),
      });
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token || !client_id || !client_secret) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      }

      const client = await GetOAuthClient(client_id);
      if (!client || client.clientSecret !== client_secret) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
      }

      const result = await RefreshOAuthAccessToken(refresh_token);
      if (!result) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
      }

      return res.json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Only authorization_code and refresh_token grant types are supported' });
  })
);

// OAuth token revocation (public, per RFC 7009)
webui.post(
  '/oauth/revoke',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { token } = req.body;
    if (token) await RevokeOAuthToken(token);
    // Always return 200 per spec
    res.json({ success: true });
  })
);

// API token auth - allows Bearer token authentication for API endpoints
// Checks both API tokens and OAuth access tokens
webui.use(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.substring(7);

  // Try API token first
  const user = await GetApiTokenByToken(token);
  if (user) {
    req.session.user = {
      username: user.username,
      cardNumber: user.cardNumber,
      admin: user.admin,
    };
    (req as any).isApiAuth = true;
    return next();
  }

  // Try OAuth access token
  const oauthUser = await GetOAuthAccessToken(token);
  if (oauthUser) {
    req.session.user = {
      username: oauthUser.username,
      cardNumber: oauthUser.cardNumber,
      admin: oauthUser.admin,
    };
    (req as any).isApiAuth = true;
    (req as any).oauthScopes = oauthUser.scopes;
    return next();
  }

  return res.status(401).json({ success: false, description: 'Invalid API token' });
});

// Internal render-token middleware. Used exclusively by the Puppeteer
// instance launched from /api/sdvx/vf-top-50/<refid>.png — that endpoint
// mints a one-shot token, gives the headless browser a cookie carrying
// it, then deletes the token after the screenshot. The middleware only
// honours the cookie when the request is from loopback so a leaked token
// can't impersonate a user from outside the host.
//
// We need this because the VF Top 50 page is gated behind the regular
// auth middleware and uses session cookies; Puppeteer doesn't have a
// session cookie of its own, so without this hook every sub-resource
// (the page itself, /static assets, the jacket route) would 302 to
// /login and the screenshot would be the login page.
const internalRenderTokens = new Map<
  string,
  { user: { username: string; cardNumber: string; admin: boolean }; expiresAt: number }
>();

export function createInternalRenderToken(user: {
  username: string;
  cardNumber: string;
  admin: boolean;
}): string {
  const now = Date.now();
  // Sweep expired entries so the map doesn't grow unbounded under heavy use.
  for (const [tok, entry] of internalRenderTokens) {
    if (entry.expiresAt < now) internalRenderTokens.delete(tok);
  }
  const token = require('crypto').randomBytes(32).toString('hex');
  internalRenderTokens.set(token, { user, expiresAt: now + 60_000 });
  return token;
}

export function consumeInternalRenderToken(token: string): void {
  internalRenderTokens.delete(token);
}

webui.use((req, res, next) => {
  const cookieToken = req.cookies && req.cookies._render_token;
  if (!cookieToken) return next();

  // Loopback-only. req.ip can show as ::ffff:127.0.0.1 with IPv4-mapped
  // IPv6, so cover both literals.
  const ip = req.ip || '';
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopback) return next();

  const entry = internalRenderTokens.get(cookieToken);
  if (!entry || entry.expiresAt < Date.now()) return next();

  req.session.user = entry.user;
  (req as any).isApiAuth = true;
  next();
});

// Nautica endpoints that must be accessible without auth (used by sync script)
webui.get(
  '/api/nautica/version',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    if (!gameRoot) return res.json({ version: null });

    const modBase = path.join(gameRoot, 'data_mods', mixName);
    if (!existsSync(modBase)) {
      require('fs').mkdirSync(modBase, { recursive: true });
    }

    const xmlPath = path.join(modBase, 'others', 'music_db.merged.xml');
    const musicBase = path.join(modBase, 'music');
    let hash = '0';
    try {
      const xmlStat = existsSync(xmlPath) ? require('fs').statSync(xmlPath) : null;
      const songFolders = existsSync(musicBase) ? readdirSync(musicBase).sort().join(',') : '';
      const raw = `${xmlStat ? xmlStat.mtimeMs : 0}|${songFolders}`;
      let h = 0;
      for (let i = 0; i < raw.length; i++) {
        h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
      }
      hash = Math.abs(h).toString(36);
    } catch {}

    res.json({ version: hash, mixName });
  })
);

webui.get(
  '/api/nautica/manifest',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';

    const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: false };
    const songs = (await APIFind(sdvxPlugin, { collection: 'nautica_song' })) as any[];
    const ready = (songs || []).filter(s => s.status === 'ready');

    const charts = ready.map(s => ({
      mid: s.mid,
      nauticaId: s.nauticaId,
      title: s.title,
      artist: s.artist,
      convertedAt: s.convertedAt || 0,
      driveFileId: s.driveFileId || null,
      size: s.driveFileSize || 0,
      downloadUrl: s.driveFileId
        ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(s.driveFileId)}`
        : null,
    }));

    res.json({ mixName, charts });
  })
);

webui.get(
  '/api/drive-oauth-start',
  wrap(async (req, res) => {
    if (!req.session.user?.admin) return res.sendStatus(403);

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const clientId = (sdvxConfig.sdvx_drive_oauth_client_id || '').trim();
    const clientSecret = (sdvxConfig.sdvx_drive_oauth_client_secret || '').trim();
    if (!clientId || !clientSecret) {
      return res.status(400).send('Drive OAuth Client ID and Client Secret must be set in plugin settings first.');
    }

    const redirectUri = `${req.protocol}://${req.get('host')}/api/drive-oauth-callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive',
      access_type: 'offline',
      prompt: 'consent',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  })
);

webui.get(
  '/api/drive-oauth-callback',
  wrap(async (req, res) => {
    if (!req.session.user?.admin) return res.status(403).send('Admin session required.');

    const code = req.query.code;
    const error = req.query.error;
    if (error) return res.status(400).send(`Google returned an error: ${error}`);
    if (!code || typeof code !== 'string') return res.status(400).send('Missing authorization code.');

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const clientId = (sdvxConfig.sdvx_drive_oauth_client_id || '').trim();
    const clientSecret = (sdvxConfig.sdvx_drive_oauth_client_secret || '').trim();
    if (!clientId || !clientSecret) return res.status(400).send('Drive OAuth client not configured.');

    const redirectUri = `${req.protocol}://${req.get('host')}/api/drive-oauth-callback`;

    try {
      const tokens = await exchangeAuthCodeForTokens(code, clientId, clientSecret, redirectUri);
      if (!tokens || !tokens.refresh_token) {
        return res.status(500).send(
          'Google did not return a refresh token. Revoke the app at https://myaccount.google.com/permissions and try again.'
        );
      }
      const section = CONFIG['sdvx@asphyxia'] || {};
      section.sdvx_drive_oauth_refresh_token = tokens.refresh_token;
      CONFIG['sdvx@asphyxia'] = section;
      SaveConfig();

      res.send(
        `<html><body style="font-family:sans-serif;padding:2rem;background:#1a1a1e;color:#ddd">
          <h2 style="color:#7cb">Google Drive authorized</h2>
          <p>Refresh token saved. You can close this window and return to the admin page.</p>
          <script>setTimeout(function(){window.close();},2000);</script>
        </body></html>`
      );
    } catch (err: any) {
      res.status(500).send(`OAuth exchange failed: ${err.message || err}`);
    }
  })
);

function exchangeAuthCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number } | null> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();

    const https = require('https');
    const req = https.request(
      {
        method: 'POST',
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`token endpoint returned HTTP ${res.statusCode}: ${text}`));
          }
          try { resolve(JSON.parse(text)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

webui.get(
  '/api/nautica/music-db-xml',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    if (!gameRoot) return res.status(400).json({ error: 'Game directory not configured' });

    const xmlPath = path.join(gameRoot, 'data_mods', mixName, 'others', 'music_db.merged.xml');
    if (!existsSync(xmlPath)) return res.sendStatus(404);

    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="music_db.merged.xml"`);
    res.sendFile(xmlPath);
  })
);

webui.get(
  '/api/nautica/download-all',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    if (!gameRoot) return res.status(400).json({ error: 'Game directory not configured' });

    const modBase = path.join(gameRoot, 'data_mods', mixName);
    const musicBase = path.join(modBase, 'music');
    if (!existsSync(musicBase) || readdirSync(musicBase).length === 0) {
      return res.status(404).json({ error: 'No custom charts available' });
    }

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${mixName}.zip"`);
    archive.pipe(res);
    archive.directory(modBase, `data_mods/${mixName}`);
    await archive.finalize();
  })
);

webui.get(
  '/api/nautica/sync-script',
  wrap(async (req, res) => {
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const templatePath = path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'sync_custom_charts.ps1');
    if (!existsSync(templatePath)) return res.status(404).send('Sync script template not found');
    const script = readFileSync(templatePath, 'utf8')
      .replace(/\$ServerUrl\s*=\s*"[^"]*"/, `$ServerUrl    = "${serverUrl}"`);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="sync_custom_charts.ps1"');
    res.send(script);
  })
);

webui.get(
  '/api/nautica/sync-script-bat',
  wrap(async (req, res) => {
    const bat = '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_custom_charts.ps1"\r\n';
    res.set('Content-Type', 'application/x-batch');
    res.set('Content-Disposition', 'attachment; filename="sync_and_play.bat"');
    res.send(bat);
  })
);

webui.get(
  '/api/nautica/sync-bundle',
  wrap(async (req, res) => {
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const templatePath = path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'sync_custom_charts.ps1');
    if (!existsSync(templatePath)) return res.status(404).send('Sync script template not found');

    const ps1 = readFileSync(templatePath, 'utf8')
      .replace(/\$ServerUrl\s*=\s*"[^"]*"/, `$ServerUrl    = "${serverUrl}"`);
    const bat = '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_custom_charts.ps1"\r\n';

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="custom_charts_sync.zip"');
    archive.pipe(res);
    archive.append(ps1, { name: 'sync_custom_charts.ps1' });
    archive.append(bat, { name: 'sync_and_play.bat' });
    await archive.finalize();
  })
);

// Auth middleware - all routes below require login
webui.use((req, res, next) => {
  if (!req.session.user) {
    // API requests get a JSON 401 instead of a redirect
    if (req.headers.authorization || req.headers.accept === 'application/json') {
      return res.status(401).json({ success: false, description: 'Authentication required' });
    }
    return res.redirect('/login');
  }
  next();
});

// Admin-only DELETE middleware - block all DELETE requests for non-admins
webui.use((req, res, next) => {
  if (req.method === 'DELETE' && !req.session.user!.admin) {
    return res.sendStatus(403);
  }
  next();
});

// Current user info (JSON, for API/OAuth consumers)
webui.get(
  '/api/me',
  wrap(async (req, res) => {
    const user = req.session.user!;
    const result: any = { success: true, username: user.username, admin: user.admin };

    if (user.cardNumber) {
      result.cardNumber = user.cardNumber;
      const card = await FindCard(user.cardNumber);
      if (card && card.__refid) {
        result.refid = card.__refid;
        const profile = await FindProfile(card.__refid);
        if (profile && profile.name) {
          result.playerName = profile.name;
        }
      }
    }

    res.json(result);
  })
);

// VoxCharger binary distribution. Serves whatever VoxCharger.exe is sitting
// in dist/ alongside the asphyxia binary, so server admins setting up a new
// host can grab the same converter version this server is built against
// without hunting for a release. Logged-in only — the binary is small but
// no reason to expose it anonymously.
webui.get(
  '/api/voxcharger/download',
  wrap(async (req, res) => {
    const candidates = [
      path.resolve(process.cwd(), 'VoxCharger.exe'),
      path.resolve(process.cwd(), '..', 'VoxCharger.exe'),
      path.resolve(__dirname, '..', '..', 'VoxCharger.exe'),
    ];
    const exePath = candidates.find(p => existsSync(p));
    if (!exePath) {
      return res
        .status(404)
        .type('text/plain')
        .send(
          'VoxCharger.exe not found alongside the server binary. Place ' +
          'VoxCharger.exe next to the asphyxia executable (or in this ' +
          'server\'s working directory) and retry.'
        );
    }
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="VoxCharger.exe"');
    res.sendFile(exePath);
  })
);

// Account settings
webui.get(
  '/account',
  wrap(async (req, res) => {
    res.render('account', data(req, 'Account', 'core'));
  })
);

webui.post(
  '/account',
  wrap(async (req, res) => {
    const { username, password, confirmPassword } = req.body;
    const currentUsername = req.session.user!.username;

    if (password && password !== confirmPassword) {
      req.flash('formWarn', 'Passwords do not match.');
      return res.redirect('/account');
    }

    if (password && password.length < 4) {
      req.flash('formWarn', 'Password must be at least 4 characters.');
      return res.redirect('/account');
    }

    const updateFields: { username?: string; password?: string } = {};

    if (username && username !== currentUsername) {
      if (username.length < 3) {
        req.flash('formWarn', 'Username must be at least 3 characters.');
        return res.redirect('/account');
      }
      const existing = await FindUserByUsername(username);
      if (existing) {
        req.flash('formWarn', 'Username already taken.');
        return res.redirect('/account');
      }
      updateFields.username = username;
    }

    if (password) {
      updateFields.password = password;
    }

    if (Object.keys(updateFields).length > 0) {
      await UpdateUserAccount(currentUsername, updateFields);
      if (updateFields.username) {
        req.session.user!.username = updateFields.username;
      }
      req.flash('formOk', 'Account updated.');
    }

    res.redirect('/account');
  })
);

// API token management
webui.post(
  '/account/api-token',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const token = await GenerateApiToken(req.session.user!.username);
    if (!token) {
      if (req.headers.accept === 'application/json' || (req as any).isApiAuth) {
        return res.status(500).json({ success: false, description: 'Failed to generate token' });
      }
      req.flash('formWarn', 'Failed to generate API token.');
      return res.redirect('/account');
    }

    if (req.headers.accept === 'application/json' || (req as any).isApiAuth) {
      return res.json({ success: true, token });
    }
    req.flash('formOk', `API token generated. Copy it now — it won't be shown again: ${token}`);
    res.redirect('/account');
  })
);

webui.post(
  '/account/api-token/revoke',
  wrap(async (req, res) => {
    await DeleteApiToken(req.session.user!.username);
    if (req.headers.accept === 'application/json' || (req as any).isApiAuth) {
      return res.json({ success: true });
    }
    req.flash('formOk', 'API token revoked.');
    res.redirect('/account');
  })
);

webui.get(
  '/account/api-token/status',
  wrap(async (req, res) => {
    const exists = await GetApiTokenExists(req.session.user!.username);
    res.json({ success: true, exists });
  })
);

// API documentation page
webui.get(
  '/api-docs',
  wrap(async (req, res) => {
    const host = req.headers.host || 'localhost:8083';
    const protocol = req.protocol;
    res.render('api_docs', data(req, 'API Documentation', 'core', {
      baseUrl: `${protocol}://${host}`,
      tachiEnabled: !!(CONFIG.tachi_client_id && CONFIG.tachi_client_secret),
      flowerEnabled: !!(CONFIG.flower_client_id && CONFIG.flower_client_secret),
    }));
  })
);

// =========================================
//             OAuth Provider (protected endpoints)
// =========================================

// OAuth authorization page - user sees this to approve/deny access
webui.get(
  '/oauth/authorize',
  wrap(async (req, res) => {
    const { response_type, client_id, redirect_uri, scope, state } = req.query as Record<string, string>;

    if (response_type !== 'code') {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Only response_type=code is supported.',
      }));
    }

    if (!client_id || !redirect_uri) {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Missing client_id or redirect_uri.',
      }));
    }

    const client = await GetOAuthClient(client_id);
    if (!client) {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Unknown application (invalid client_id).',
      }));
    }

    if (client.redirectUri !== redirect_uri) {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Redirect URI does not match the registered application.',
      }));
    }

    const scopes = scope ? scope.split(' ').filter(Boolean) : ['profile'];

    res.render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
      clientName: client.name,
      clientId: client_id,
      redirectUri: redirect_uri,
      scopes,
      state: state || '',
    }));
  })
);

// OAuth authorization decision - user approves or denies
webui.post(
  '/oauth/authorize',
  wrap(async (req, res) => {
    const { client_id, redirect_uri, scope, state, decision } = req.body;

    if (!client_id || !redirect_uri) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    const client = await GetOAuthClient(client_id);
    if (!client || client.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'Invalid client or redirect URI' });
    }

    const redirectUrl = new URL(redirect_uri);

    if (decision !== 'approve') {
      redirectUrl.searchParams.set('error', 'access_denied');
      if (state) redirectUrl.searchParams.set('state', state);
      return res.redirect(redirectUrl.toString());
    }

    const scopes = scope ? scope.split(' ').filter(Boolean) : ['profile'];
    const code = await CreateOAuthCode(client_id, req.session.user!.username, redirect_uri, scopes);
    if (!code) {
      redirectUrl.searchParams.set('error', 'server_error');
      if (state) redirectUrl.searchParams.set('state', state);
      return res.redirect(redirectUrl.toString());
    }

    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(redirectUrl.toString());
  })
);

// OAuth client management - create a new client application
webui.post(
  '/oauth/clients',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { name, redirect_uri } = req.body;
    if (!name || !redirect_uri) {
      return res.status(400).json({ success: false, description: 'Name and redirect_uri are required' });
    }

    try {
      new URL(redirect_uri);
    } catch {
      return res.status(400).json({ success: false, description: 'Invalid redirect_uri — must be a valid URL' });
    }

    const result = await CreateOAuthClient(name, redirect_uri, req.session.user!.username);
    if (!result) {
      return res.status(500).json({ success: false, description: 'Failed to create client' });
    }

    res.json({ success: true, clientId: result.clientId, clientSecret: result.clientSecret });
  })
);

// List user's OAuth clients
webui.get(
  '/oauth/clients',
  wrap(async (req, res) => {
    const clients = await GetOAuthClientsByUser(req.session.user!.username);
    res.json({
      success: true,
      clients: clients.map((c: any) => ({
        clientId: c.clientId,
        name: c.name,
        redirectUri: c.redirectUri,
      })),
    });
  })
);

// Delete an OAuth client
webui.delete(
  '/oauth/clients/:clientId',
  wrap(async (req, res) => {
    const username = req.session.user!.username;
    const { clientId } = req.params;

    const client = await GetOAuthClient(clientId);
    if (!client) {
      return res.status(404).json({ success: false, description: 'Client not found' });
    }
    // Allow owner or admin to delete
    if (client.createdBy !== username && !req.session.user!.admin) {
      return res.status(403).json({ success: false, description: 'Not authorized to delete this client' });
    }

    await DeleteOAuthClient(clientId, client.createdBy);
    res.json({ success: true });
  })
);

// List authorized apps for current user & revoke
webui.get(
  '/oauth/authorized',
  wrap(async (req, res) => {
    const tokens = await GetOAuthTokensByUser(req.session.user!.username);
    // Group by client and return unique client names
    const seen = new Set<string>();
    const apps: any[] = [];
    for (const t of tokens) {
      if (seen.has(t.clientId)) continue;
      seen.add(t.clientId);
      const client = await GetOAuthClient(t.clientId);
      apps.push({
        clientId: t.clientId,
        name: client ? client.name : 'Unknown App',
        scopes: t.scopes,
      });
    }
    res.json({ success: true, apps });
  })
);

webui.post(
  '/oauth/authorized/revoke',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ success: false, description: 'client_id is required' });
    await RevokeOAuthTokensByClientForUser(client_id, req.session.user!.username);
    res.json({ success: true });
  })
);

// =========================================
//             External API endpoints
// =========================================

webui.get(
  '/api/profile',
  wrap(async (req, res) => {
    const username = req.session.user!.username;
    const cardNumber = req.session.user!.cardNumber;
    let refid: string | null = null;

    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) refid = card.__refid;
    }

    res.json({ success: true, username, cardNumber, refid });
  })
);

webui.post(
  '/api/tachi/sync',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const username = req.session.user!.username;
    const cardNumber = req.session.user!.cardNumber;

    // Get Tachi token
    const tachiToken = await GetTachiToken(username);
    if (!tachiToken) {
      return res.status(400).json({ success: false, description: 'Not authorized with Tachi. Connect Tachi from the WebUI first.' });
    }

    // Resolve refid
    if (!cardNumber) {
      return res.status(400).json({ success: false, description: 'No card number linked to account' });
    }
    const card = await FindCard(cardNumber);
    if (!card || !card.__refid) {
      return res.status(400).json({ success: false, description: 'No profile found for card' });
    }
    const refid = card.__refid;

    // Get local SDVX scores
    const plugin = { identifier: 'sdvx@asphyxia', core: false };
    const allScores = await APIFind(plugin, refid, { collection: 'music' });
    if (!allScores || allScores.length === 0) {
      return res.json({ success: true, exported: 0, description: 'No scores to export' });
    }

    // Filter by export timestamp
    const lastExport = await GetTachiExportTimestamp(refid);
    const scoresToExport = lastExport
      ? allScores.filter((s: any) => {
          const updated = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
          const created = s.createdAt ? new Date(s.createdAt).getTime() : 0;
          return Math.max(updated, created) > lastExport;
        })
      : allScores;

    if (scoresToExport.length === 0) {
      return res.json({ success: true, exported: 0, description: 'No new scores since last export' });
    }

    // Detect version
    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    const isNabla = !!v7Profile;

    // Map scores to Tachi batch-manual format
    // SDVX clear types: EG(v6): 0=none,1=played,2=clear,3=excessive,4=uc,5=puc,6=mxv
    //                   Nabla(v7): 0=none,1=played,2=clear,3=excessive,4=mxv,5=uc,6=puc
    const EG_CLEAR_TO_LAMP: Record<number, string> = {
      0: 'FAILED', 1: 'FAILED', 2: 'CLEAR', 3: 'EXCESSIVE CLEAR',
      4: 'ULTIMATE CHAIN', 5: 'PERFECT ULTIMATE CHAIN', 6: 'MAXXIVE CLEAR',
    };
    const NABLA_CLEAR_TO_LAMP: Record<number, string> = {
      0: 'FAILED', 1: 'FAILED', 2: 'CLEAR', 3: 'EXCESSIVE CLEAR',
      4: 'MAXXIVE CLEAR', 5: 'ULTIMATE CHAIN', 6: 'PERFECT ULTIMATE CHAIN',
    };
    const clearToLamp = isNabla ? NABLA_CLEAR_TO_LAMP : EG_CLEAR_TO_LAMP;

    const TYPE_TO_DIFF: Record<number, string> = {
      0: 'NOV', 1: 'ADV', 2: 'EXH', 3: 'INF', 4: 'MXM', 5: 'ULT',
    };

    const tachiScores: any[] = [];
    for (const s of scoresToExport) {
      const lamp = clearToLamp[s.clear];
      const diff = TYPE_TO_DIFF[s.type];
      if (!lamp || diff === undefined) continue;
      if (s.score <= 0) continue; // Don't export zero-score entries

      const entry: any = {
        score: s.score,
        lamp,
        matchType: 'inGameID',
        identifier: String(s.mid),
        difficulty: diff,
      };
      if (s.timeAchieved || s.createdAt) {
        entry.timeAchieved = s.timeAchieved || new Date(s.createdAt).getTime();
      }
      if (s.exscore) entry.optional = { exScore: s.exscore };
      tachiScores.push(entry);
    }

    if (tachiScores.length === 0) {
      return res.json({ success: true, exported: 0, description: 'No valid scores to export' });
    }

    // Build batch-manual payload and send to Tachi
    const batchManual = JSON.stringify({
      meta: { game: 'sdvx', playtype: 'Single', service: 'Asphyxia' },
      scores: tachiScores,
    });

    const https = require('https');
    const boundary = '----AsphyxiaTachi' + Date.now();
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="importType"\r\n\r\n`,
      `file/batch-manual\r\n`,
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="scoreData"; filename="scores.json"\r\n`,
      `Content-Type: application/json\r\n\r\n`,
      batchManual + '\r\n',
      `--${boundary}--\r\n`,
    ];
    const postData = Buffer.from(bodyParts.join(''));

    const importResult: any = await new Promise((resolve, reject) => {
      const importReq = https.request(
        `${TACHI_BASE_URL}/api/v1/import/file`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tachiToken}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': postData.length,
            'X-User-Intent': 'true',
          },
        },
        (importRes: any) => {
          let body = '';
          importRes.on('data', (chunk: string) => (body += chunk));
          importRes.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('Failed to parse Tachi import response')); }
          });
        }
      );
      importReq.on('error', reject);
      importReq.write(postData);
      importReq.end();
    });

    if (importResult.success) {
      await SaveTachiExportTimestamp(refid, Date.now());
    }

    res.json({
      success: importResult.success,
      description: importResult.description || (importResult.success ? 'Export complete' : 'Export failed'),
      exported: tachiScores.length,
      body: importResult.body,
    });
  })
);

webui.post(
  '/api/flower/sync',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const username = req.session.user!.username;
    const cardNumber = req.session.user!.cardNumber;

    // Get Flower token
    const flowerToken = await GetFlowerToken(username);
    if (!flowerToken) {
      return res.status(400).json({ success: false, description: 'Not authorized with Project Flower. Connect from the WebUI first.' });
    }

    // Resolve refid
    if (!cardNumber) {
      return res.status(400).json({ success: false, description: 'No card number linked to account' });
    }
    const card = await FindCard(cardNumber);
    if (!card || !card.__refid) {
      return res.status(400).json({ success: false, description: 'No profile found for card' });
    }
    const refid = card.__refid;

    // Fetch player bests from Flower (with pagination)
    let allBests: any[] = [];
    let nextUrl: string | null = '/api/sdvx/v1/player_bests';

    while (nextUrl) {
      const result = await flowerApiRequest('GET', nextUrl, flowerToken);
      if (result.status !== 200 || !result.data) {
        return res.status(502).json({
          success: false,
          description: 'Failed to fetch scores from Project Flower (status ' + result.status + ')',
        });
      }

      const fdata = result.data;
      if (Array.isArray(fdata)) {
        allBests = allBests.concat(fdata);
      } else if (fdata && typeof fdata === 'object') {
        if (fdata._embedded) {
          for (const key of Object.keys(fdata._embedded)) {
            if (Array.isArray(fdata._embedded[key])) {
              allBests = allBests.concat(fdata._embedded[key]);
            }
          }
        } else {
          for (const key of ['_items', 'items', 'scores', 'data', 'results', 'records', 'bests', 'player_bests']) {
            if (Array.isArray(fdata[key])) {
              allBests = allBests.concat(fdata[key]);
              break;
            }
          }
        }
      }

      nextUrl = fdata?._links?._next || fdata?._links?.next?.href || null;
    }

    if (allBests.length === 0) {
      return res.json({ success: true, saved: 0, skipped: 0, description: 'No scores found on Project Flower' });
    }

    // Normalize scores from Flower format to internal format
    // Flower fields: music_id, music_difficulty (0-5), score, clear_type, grade
    const FLOWER_CLEAR: Record<string, number> = {
      'PLAYED': 1, 'COMP': 2, 'COMP_EX': 3, 'UC': 4, 'PUC': 5,
    };
    const FLOWER_DIFF: Record<string, number> = {
      'novice': 0, 'advanced': 1, 'exhaust': 2, 'infinite': 3, 'maximum': 4, 'ultimate': 5,
      'NOV': 0, 'ADV': 1, 'EXH': 2, 'INF': 3, 'MXM': 4, 'ULT': 5,
    };

    const scores: any[] = [];
    for (const b of allBests) {
      const mid = b.music_id || b.musicId || b.id;
      if (mid === undefined) continue;

      let type = b.music_difficulty ?? b.musicDifficulty ?? b.difficulty;
      if (typeof type === 'string') type = FLOWER_DIFF[type] ?? parseInt(type);
      if (type === undefined || type === null) continue;

      let clear = b.best_clear_type ?? b.clear_type ?? b.clearType ?? b.clear ?? 1;
      if (typeof clear === 'string') clear = FLOWER_CLEAR[clear] ?? 1;

      const score = b.best_score || b.score || 0;
      if (score <= 0) continue; // Skip entries with no actual score (e.g. Flower "PLAYED" placeholders)
      scores.push({ mid: Number(mid), type: Number(type), score, clear, exscore: b.ex_score || b.exScore || 0, timeAchieved: b.best_score_timestamp || null });
    }

    // Save scores using the same logic as /flower/save-scores
    const plugin = { identifier: 'sdvx@asphyxia', core: false };
    let saved = 0;
    let skipped = 0;

    // Load music_db for volforce
    const musicDbPath = path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'music_db.json');
    let mdb: any = null;
    if (existsSync(musicDbPath)) {
      mdb = JSON.parse(readFileSync(musicDbPath, 'utf8'));
      const customDbPath = path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'custom_music_db.json');
      if (existsSync(customDbPath)) {
        try {
          const customDb = JSON.parse(readFileSync(customDbPath, 'utf8'));
          if (customDb?.mdb?.music?.length) mdb.mdb.music = mdb.mdb.music.concat(customDb.mdb.music);
        } catch {}
      }
    }

    const diffName = ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate'];
    function getDiffLevel(mid: number, type: number): number {
      if (!mdb) return 0;
      const song = mdb.mdb.music.find((m: any) => m.id == mid);
      if (!song) return 0;
      return parseFloat(song.difficulty?.[diffName[type]]) || 0;
    }
    const medalCoef = [0, 0.5, 1.0, 1.02, 1.04, 1.06, 1.1];
    const gradeCoef = [0, 0.8, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.0, 1.02, 1.05];
    function computeForce(diff: number, score: number, medal: number, grade: number) {
      return Math.floor(diff * (score / 10000000) * (gradeCoef[grade] || 0.8) * (medalCoef[medal] || 0.5) * 20);
    }
    function gradeFromScore(score: number): number {
      if (score >= 9900000) return 10;
      if (score >= 9800000) return 9;
      if (score >= 9700000) return 8;
      if (score >= 9500000) return 7;
      if (score >= 9300000) return 6;
      if (score >= 9000000) return 5;
      if (score >= 8700000) return 4;
      if (score >= 7500000) return 3;
      if (score >= 6500000) return 2;
      return 1;
    }

    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    const targetVersion = v7Profile ? 7 : 6;

    // v6→v7 clear remap
    const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];
    if (targetVersion === 7) {
      for (const score of scores) {
        score.clear = nblClearLamp[score.clear] ?? score.clear;
      }
    }
    for (const score of scores) {
      if (score.clear === 6 && score.score < 10000000) score.clear = 4;
    }

    const NABLA_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    function clearRank(c: number) { return NABLA_CLEAR_RANK[c] ?? 0; }

    for (const score of scores) {
      try {
        const grade = gradeFromScore(score.score);
        let volforce = 0;
        if (targetVersion === 7) {
          const diffLevel = getDiffLevel(score.mid, score.type);
          if (diffLevel > 0) volforce = computeForce(diffLevel, score.score, score.clear, grade);
        }

        const existing = await APIFind(plugin, refid, {
          collection: 'music', mid: score.mid, type: score.type, version: targetVersion,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          if (score.score > ex.score || clearRank(score.clear) > clearRank(ex.clear) || (!ex.grade && grade)) {
            const update: any = {};
            if (score.score > ex.score) update.score = score.score;
            if (clearRank(score.clear) > clearRank(ex.clear)) update.clear = score.clear;
            if (grade && (!ex.grade || grade > ex.grade)) update.grade = grade;
            if (score.exscore && (!ex.exscore || score.exscore > ex.exscore)) update.exscore = score.exscore;
            if (volforce && (!ex.volforce || volforce > ex.volforce)) update.volforce = volforce;
            if (Object.keys(update).length > 0) {
              await APIUpdate(plugin, refid,
                { collection: 'music', mid: score.mid, type: score.type, version: targetVersion },
                { $set: update }
              );
              saved++;
            } else { skipped++; }
          } else { skipped++; }
          continue;
        }

        const doc: any = {
          collection: 'music', mid: score.mid, type: score.type, score: score.score,
          clear: score.clear, exscore: score.exscore || 0, grade,
          buttonRate: 0, longRate: 0, volRate: 0, volforce,
          version: targetVersion, dbver: 1,
        };
        if (score.timeAchieved) {
          doc.createdAt = new Date(score.timeAchieved);
          doc.updatedAt = new Date(score.timeAchieved);
        }
        await APIInsert(plugin, refid, doc);
        saved++;
      } catch (err) {
        Logger.error(`Failed to save Flower score mid=${score.mid} type=${score.type}: ${err}`);
      }
    }

    res.json({ success: true, saved, skipped, total: allBests.length });
  })
);

// User management (admin only)
webui.get(
  '/users',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.redirect('/');
    const users = await GetAllUsers();
    res.render('users', data(req, 'Users', 'core', { users }));
  })
);

webui.post(
  '/users/toggle-admin',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.sendStatus(403);
    const { username } = req.body;
    if (username === req.session.user!.username) return res.redirect('/users');

    const target = await FindUserByUsername(username);
    if (target) {
      await SetUserAdmin(username, !target.admin);
    }
    res.redirect('/users');
  })
);

// Tachi API endpoints
webui.post(
  '/tachi/exchange',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const code = req.body.code;
    if (!code) return res.status(400).json({ success: false, description: 'Missing code' });

    const https = require('https');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/tachi/callback`;
    const postData = JSON.stringify({
      client_id: CONFIG.tachi_client_id,
      client_secret: CONFIG.tachi_client_secret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });

    const tokenResult: any = await new Promise((resolve, reject) => {
      const tokenReq = https.request(
        `${TACHI_BASE_URL}/api/v1/oauth/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (tokenRes: any) => {
          let body = '';
          tokenRes.on('data', (chunk: string) => (body += chunk));
          tokenRes.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Failed to parse Tachi response'));
            }
          });
        }
      );
      tokenReq.on('error', reject);
      tokenReq.write(postData);
      tokenReq.end();
    });

    if (!tokenResult.success || !tokenResult.body || !tokenResult.body.token) {
      return res.json({
        success: false,
        description: tokenResult.description || 'Token exchange failed',
      });
    }

    await SaveTachiToken(req.session.user!.username, tokenResult.body.token);
    res.json({ success: true });
  })
);
webui.get(
  '/tachi/status',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token) return res.json({ authorized: false });

    // Validate token against Tachi
    const https = require('https');
    const valid: boolean = await new Promise(resolve => {
      https
        .get(
          `${TACHI_BASE_URL}/api/v1/users/me`,
          { headers: { Authorization: `Bearer ${token}` } },
          (r: any) => {
            let body = '';
            r.on('data', (c: string) => (body += c));
            r.on('end', () => {
              try {
                const data = JSON.parse(body);
                resolve(data.success === true);
              } catch {
                resolve(false);
              }
            });
          }
        )
        .on('error', () => resolve(false));
    });

    if (!valid) {
      await DeleteTachiToken(req.session.user!.username);
      return res.json({ authorized: false });
    }

    res.json({ authorized: true });
  })
);

webui.post(
  '/tachi/disconnect',
  wrap(async (req, res) => {
    // Clean up auto-export entries for this user's profiles
    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        await SaveTachiAutoExport(card.__refid, false);
        const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: false };
        await APIRemove(sdvxPlugin, { collection: 'tachi_auto_export', refid: card.__refid });
      }
    }
    await DeleteTachiToken(req.session.user!.username);
    res.json({ success: true });
  })
);

webui.get(
  '/tachi/export-ts',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const timestamp = await GetTachiExportTimestamp(refid);
    res.json({ success: true, timestamp });
  })
);

webui.post(
  '/tachi/save-export-ts',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid } = req.body;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    await SaveTachiExportTimestamp(refid, Date.now());
    res.json({ success: true });
  })
);

webui.get(
  '/tachi/auto-export',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const enabled = await GetTachiAutoExport(refid);
    res.json({ success: true, enabled });
  })
);

webui.post(
  '/tachi/auto-export',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid, enabled } = req.body;
    if (!refid || typeof enabled !== 'boolean')
      return res.status(400).json({ success: false, description: 'Missing refid or enabled' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    await SaveTachiAutoExport(refid, enabled);

    // Store/clear a copy of the Tachi token in the plugin DB so the saveScore
    // handler can access it without needing CoreDB
    const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: false };
    if (enabled) {
      const token = await GetTachiToken(req.session.user!.username);
      if (token) {
        await APIUpsert(
          sdvxPlugin,
          { collection: 'tachi_auto_export', refid },
          { collection: 'tachi_auto_export', refid, token }
        );
      }
    } else {
      await APIRemove(sdvxPlugin, { collection: 'tachi_auto_export', refid });
    }

    res.json({ success: true });
  })
);

webui.post(
  '/tachi/import',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token)
      return res.status(401).json({ success: false, description: 'Not authorized with Tachi' });

    const scores = req.body.scores;
    if (!scores || !Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({ success: false, description: 'No scores to import' });
    }

    const batchManual = JSON.stringify({
      meta: {
        game: 'sdvx',
        playtype: 'Single',
        service: 'Asphyxia',
      },
      scores,
    });

    const https = require('https');

    const boundary = '----AsphyxiaTachi' + Date.now();
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="importType"\r\n\r\n`,
      `file/batch-manual\r\n`,
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="scoreData"; filename="scores.json"\r\n`,
      `Content-Type: application/json\r\n\r\n`,
      batchManual + '\r\n',
      `--${boundary}--\r\n`,
    ];
    const postData = Buffer.from(bodyParts.join(''));

    const importResult: any = await new Promise((resolve, reject) => {
      const importReq = https.request(
        `${TACHI_BASE_URL}/api/v1/import/file`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': postData.length,
            'X-User-Intent': 'true',
          },
        },
        (importRes: any) => {
          let body = '';
          importRes.on('data', (chunk: string) => (body += chunk));
          importRes.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Failed to parse Tachi import response'));
            }
          });
        }
      );
      importReq.on('error', reject);
      importReq.write(postData);
      importReq.end();
    });

    res.json(importResult);
  })
);

webui.post(
  '/tachi/save-scores',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const { refid, scores } = req.body;
    if (!refid || !scores || !Array.isArray(scores)) {
      return res.status(400).json({ success: false, description: 'Missing refid or scores' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const plugin = { identifier: 'sdvx@asphyxia', core: false };
    let saved = 0;
    let skipped = 0;

    // Load music_db for difficulty levels (needed for volforce computation)
    const musicDbPath = path.join(
      PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'music_db.json'
    );
    let mdb: any = null;
    if (existsSync(musicDbPath)) {
      mdb = JSON.parse(readFileSync(musicDbPath, 'utf8'));
      const customDbPath = path.join(
        PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'custom_music_db.json'
      );
      if (existsSync(customDbPath)) {
        try {
          const customDb = JSON.parse(readFileSync(customDbPath, 'utf8'));
          if (customDb?.mdb?.music?.length) {
            mdb.mdb.music = mdb.mdb.music.concat(customDb.mdb.music);
          }
        } catch {}
      }
    }

    const diffName = ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate'];
    function getDiffLevel(mid: number, type: number): number {
      if (!mdb) return 0;
      const song = mdb.mdb.music.find((m: any) => m.id == mid);
      if (!song) return 0;
      const name = diffName[type];
      if (!name) return 0;
      return parseFloat(song.difficulty?.[name]) || 0;
    }

    const medalCoef = [0, 0.5, 1.0, 1.02, 1.04, 1.06, 1.1];
    const gradeCoef = [0, 0.8, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.0, 1.02, 1.05];
    function computeForce(diff: number, score: number, medal: number, grade: number) {
      return Math.floor(diff * (score / 10000000) * (gradeCoef[grade] || 0.8) * (medalCoef[medal] || 0.5) * 20);
    }

    function gradeFromScore(score: number): number {
      if (score >= 9900000) return 10;
      if (score >= 9800000) return 9;
      if (score >= 9700000) return 8;
      if (score >= 9500000) return 7;
      if (score >= 9300000) return 6;
      if (score >= 9000000) return 5;
      if (score >= 8700000) return 4;
      if (score >= 7500000) return 3;
      if (score >= 6500000) return 2;
      return 1;
    }

    // Detect if user has a v7 (Nabla) profile to determine target version
    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    const targetVersion = v7Profile ? 7 : 6;

    // v6→v7 clear type remapping (UC/PUC/MXV positions differ between versions)
    // EG (v6): 0=none, 1=played, 2=clear, 3=excessive, 4=uc, 5=puc, 6=mxv
    // Nabla (v7): 0=none, 1=played, 2=clear, 3=excessive, 4=mxv, 5=uc, 6=puc
    const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];

    // Convert incoming v6 clear types to v7 format for Nabla users
    if (targetVersion === 7) {
      for (const score of scores) {
        if (!score.version || score.version === 6) {
          score.clear = nblClearLamp[score.clear] ?? score.clear;
          score.version = 7;
        }
      }
    }

    // PUC (clear=6 in Nabla) requires a perfect 10,000,000 score;
    // Tachi PBs compose best lamp and best score independently, so the lamp
    // may be overstated — downgrade to MXV (clear=4) if score doesn't back it up
    for (const score of scores) {
      if (score.clear === 6 && score.score < 10000000) {
        score.clear = 4;
      }
    }

    // Normalize clear values to a comparable ranking
    const NABLA_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    function clearRank(c: number) {
      return NABLA_CLEAR_RANK[c] ?? 0;
    }

    for (const score of scores) {
      try {
        const grade = score.grade || gradeFromScore(score.score);

        let volforce = 0;
        if (targetVersion === 7) {
          const diffLevel = getDiffLevel(score.mid, score.type);
          if (diffLevel > 0) {
            volforce = computeForce(diffLevel, score.score, score.clear, grade);
          }
        }

        // Check if score already exists for this refid (filter by target version)
        const existing = await APIFind(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          version: targetVersion,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          // Update if incoming score is higher, or clear is better, or existing has missing grade
          if (
            score.score > ex.score ||
            clearRank(score.clear) > clearRank(ex.clear) ||
            (!ex.grade && grade)
          ) {
            const update: any = {};
            if (score.score > ex.score) update.score = score.score;
            if (clearRank(score.clear) > clearRank(ex.clear))
              update.clear = score.clear;
            if (grade && (!ex.grade || grade > ex.grade)) update.grade = grade;
            if (score.exscore && (!ex.exscore || score.exscore > ex.exscore))
              update.exscore = score.exscore;
            if (volforce && (!ex.volforce || volforce > ex.volforce))
              update.volforce = volforce;

            if (Object.keys(update).length > 0) {
              await APIUpdate(
                plugin,
                refid,
                { collection: 'music', mid: score.mid, type: score.type, version: targetVersion },
                { $set: update }
              );
              saved++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        // Insert new scores
        const doc: any = {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          score: score.score,
          clear: score.clear,
          exscore: score.exscore || 0,
          grade: grade,
          buttonRate: 0,
          longRate: 0,
          volRate: 0,
          volforce: volforce,
          version: targetVersion,
          dbver: 1,
        };
        if (score.timeAchieved) {
          doc.createdAt = new Date(score.timeAchieved);
          doc.updatedAt = new Date(score.timeAchieved);
        }
        await APIInsert(plugin, refid, doc);
        saved++;
      } catch (err) {
        Logger.error(`Failed to save Tachi score mid=${score.mid} type=${score.type}: ${err}`);
      }
    }

    res.json({ success: true, saved, skipped });
  })
);

webui.get(
  '/tachi/pbs',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token)
      return res.status(401).json({ success: false, description: 'Not authorized with Tachi' });

    const https = require('https');

    const tachiGet = (urlPath: string): Promise<any> =>
      new Promise((resolve, reject) => {
        https
          .get(
            `${TACHI_BASE_URL}${urlPath}`,
            { headers: { Authorization: `Bearer ${token}` } },
            (r: any) => {
              let body = '';
              r.on('data', (c: string) => (body += c));
              r.on('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  reject(new Error('Failed to parse Tachi response'));
                }
              });
            }
          )
          .on('error', reject);
      });

    const result = await tachiGet('/api/v1/users/me/games/sdvx/Single/pbs/all');
    if (!result.success) {
      return res.json({ success: false, description: result.description || 'Failed to fetch PBs' });
    }

    const { pbs, charts, songs } = result.body;

    const chartMap: Record<string, any> = {};
    for (const c of charts) chartMap[c.chartID] = c;

    const songMap: Record<number, any> = {};
    for (const s of songs) songMap[s.id] = s;

    // Tachi lamp to SDVX EG clear type mapping (reverse of export)
    // EG: 0=none, 1=played, 2=clear, 3=excessive, 4=uc, 5=puc, 6=mxv
    const LAMP_TO_CLEAR: Record<string, number> = {
      'FAILED': 1,
      'CLEAR': 2,
      'EXCESSIVE CLEAR': 3,
      'ULTIMATE CHAIN': 4,
      'PERFECT ULTIMATE CHAIN': 5,
      'MAXXIVE CLEAR': 6,
    };

    // Tachi grade to Asphyxia grade mapping
    const GRADE_MAP: Record<string, number> = {
      'D': 1,
      'C': 2,
      'B': 3,
      'A': 4,
      'A+': 5,
      'AA': 6,
      'AA+': 7,
      'AAA': 8,
      'AAA+': 9,
      'S': 10,
      'PUC': 10,
    };

    // Tachi difficulty to SDVX type mapping
    const DIFF_TO_TYPE: Record<string, number> = {
      NOV: 0,
      ADV: 1,
      EXH: 2,
      INF: 3,
      GRV: 3,
      HVN: 3,
      VVD: 3,
      XCD: 3,
      MXM: 4,
      ULT: 5,
    };

    const scores: any[] = [];
    for (let i = 0; i < pbs.length; i++) {
      const pb = pbs[i];
      const chart = chartMap[pb.chartID];
      const song = songMap[pb.songID];
      if (!chart || !song) continue;

      const clear = LAMP_TO_CLEAR[pb.scoreData.lamp];
      const type = DIFF_TO_TYPE[chart.difficulty];
      if (clear === undefined || type === undefined) continue;

      scores.push({
        mid: chart.data.inGameID,
        type,
        score: pb.scoreData.score,
        clear,
        grade: GRADE_MAP[pb.scoreData.grade] || 0,
        exscore: pb.scoreData.optional?.exScore || 0,
        timeAchieved: pb.timeAchieved || null,
        songName: song.title,
        difficulty: chart.difficulty,
        lamp: pb.scoreData.lamp,
      });
    }

    res.json({ success: true, scores });
  })
);

webui.get(
  '/tachi/pbs/best',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token)
      return res.status(401).json({ success: false, description: 'Not authorized with Tachi' });

    const https = require('https');

    const tachiGet = (urlPath: string): Promise<any> =>
      new Promise((resolve, reject) => {
        https
          .get(
            `${TACHI_BASE_URL}${urlPath}`,
            { headers: { Authorization: `Bearer ${token}` } },
            (r: any) => {
              let body = '';
              r.on('data', (c: string) => (body += c));
              r.on('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  reject(new Error('Failed to parse Tachi response'));
                }
              });
            }
          )
          .on('error', reject);
      });

    const result = await tachiGet('/api/v1/users/me/games/sdvx/Single/pbs/best');
    if (!result.success) {
      return res.json({ success: false, description: result.description || 'Failed to fetch PBs' });
    }

    const { pbs, charts, songs } = result.body;

    const chartMap: Record<string, any> = {};
    for (const c of charts) chartMap[c.chartID] = c;

    const songMap: Record<number, any> = {};
    for (const s of songs) songMap[s.id] = s;

    const scores: any[] = [];
    for (let i = 0; i < pbs.length; i++) {
      const pb = pbs[i];
      const chart = chartMap[pb.chartID];
      const song = chart ? songMap[chart.songID] : null;
      if (!chart || !song) continue;

      scores.push({
        score: pb.scoreData.score,
        lamp: pb.scoreData.lamp,
        grade: pb.scoreData.grade,
        songName: song.title,
        difficulty: chart.difficulty,
        level: chart.level,
        vf: pb.calculatedData?.VF6 || 0,
      });
    }

    res.json({ success: true, scores });
  })
);

// Project Flower API endpoints
function flowerApiRequest(
  method: string,
  urlPath: string,
  token: string,
  postData?: string
): Promise<any> {
  const https = require('https');
  const url = urlPath.startsWith('http') ? urlPath : `${FLOWER_BASE_URL}${urlPath}`;
  return new Promise((resolve, reject) => {
    const options: any = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    };
    if (postData) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request(url, options, (r: any) => {
      let body = '';
      r.on('data', (c: string) => (body += c));
      r.on('end', () => {
        try {
          resolve({ status: r.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: r.statusCode, data: null, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

webui.post(
  '/flower/exchange',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const code = req.body.code;
    if (!code) return res.status(400).json({ success: false, description: 'Missing code' });

    const https = require('https');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/flower/callback`;
    const postData = `client_id=${encodeURIComponent(CONFIG.flower_client_id)}&client_secret=${encodeURIComponent(CONFIG.flower_client_secret)}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`;

    const tokenResult: any = await new Promise((resolve, reject) => {
      const tokenReq = https.request(
        `${FLOWER_BASE_URL}/oauth/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (tokenRes: any) => {
          let body = '';
          tokenRes.on('data', (chunk: string) => (body += chunk));
          tokenRes.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Failed to parse Project Flower response'));
            }
          });
        }
      );
      tokenReq.on('error', reject);
      tokenReq.write(postData);
      tokenReq.end();
    });

    if (!tokenResult.access_token) {
      return res.json({
        success: false,
        description: tokenResult.error_description || tokenResult.error || 'Token exchange failed',
      });
    }

    await SaveFlowerToken(req.session.user!.username, tokenResult.access_token);
    res.json({ success: true });
  })
);

webui.get(
  '/flower/status',
  wrap(async (req, res) => {
    const token = await GetFlowerToken(req.session.user!.username);
    if (!token) return res.json({ authorized: false });

    try {
      const result = await flowerApiRequest('GET', '/api/account/v1/my_player', token);
      if (result.status === 200 && result.data) {
        return res.json({ authorized: true });
      }
    } catch {}

    await DeleteFlowerToken(req.session.user!.username);
    return res.json({ authorized: false });
  })
);

webui.post(
  '/flower/disconnect',
  wrap(async (req, res) => {
    await DeleteFlowerToken(req.session.user!.username);
    res.json({ success: true });
  })
);

// Fetch player bests from Project Flower SDVX API and return raw + normalized data
webui.get(
  '/flower/scores',
  wrap(async (req, res) => {
    const token = await GetFlowerToken(req.session.user!.username);
    if (!token) return res.json({ success: false, description: 'Not authorized with Project Flower' });

    try {
      // Fetch player bests - may be paginated via HAL _links.next
      let allBests: any[] = [];
      let nextUrl: string | null = '/api/sdvx/v1/player_bests';

      while (nextUrl) {
        const result = await flowerApiRequest('GET', nextUrl, token);
        if (result.status !== 200 || !result.data) {
          return res.json({
            success: false,
            description: 'Failed to fetch player bests (status ' + result.status + ')',
            debug: result.data,
          });
        }

        const data = result.data;

        // Try to extract the score array from whatever structure Flower returns
        let found = false;
        if (Array.isArray(data)) {
          allBests = allBests.concat(data);
          found = true;
        } else if (data && typeof data === 'object') {
          // Check _embedded (HAL standard)
          if (data._embedded) {
            const keys = Object.keys(data._embedded);
            for (const key of keys) {
              if (Array.isArray(data._embedded[key])) {
                allBests = allBests.concat(data._embedded[key]);
                found = true;
              }
            }
          }
          // Check common wrapper keys
          if (!found) {
            for (const key of ['_items', 'items', 'scores', 'data', 'results', 'records', 'bests', 'player_bests']) {
              if (Array.isArray(data[key])) {
                allBests = allBests.concat(data[key]);
                found = true;
                break;
              }
            }
          }
          // If still nothing found, return the raw structure for debugging
          if (!found) {
            return res.json({
              success: true,
              total: 0,
              scores: [],
              _raw: data,
              _keys: Object.keys(data),
              _debug: 'Could not find score array in response. Check _raw for the actual structure.',
            });
          }
        }

        // Follow pagination
        nextUrl = data?._links?._next || data?._links?.next?.href || null;
      }

      res.json({
        success: true,
        total: allBests.length,
        scores: allBests,
        // Include first few raw entries for debugging
        _sample: allBests.slice(0, 3),
      });
    } catch (err: any) {
      res.json({ success: false, description: err.message || 'Failed to fetch scores' });
    }
  })
);

// Save imported Project Flower scores with volforce computation
webui.post(
  '/flower/save-scores',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const { refid, scores } = req.body;
    if (!refid || !scores || !Array.isArray(scores)) {
      return res.status(400).json({ success: false, description: 'Missing refid or scores' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const plugin = { identifier: 'sdvx@asphyxia', core: false };
    let saved = 0;
    let skipped = 0;

    // Load music_db for difficulty levels (needed for volforce computation)
    const musicDbPath = path.join(
      PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'music_db.json'
    );
    let mdb: any = null;
    if (existsSync(musicDbPath)) {
      mdb = JSON.parse(readFileSync(musicDbPath, 'utf8'));
      // Merge custom songs if file exists
      const customDbPath = path.join(
        PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'custom_music_db.json'
      );
      if (existsSync(customDbPath)) {
        try {
          const customDb = JSON.parse(readFileSync(customDbPath, 'utf8'));
          if (customDb?.mdb?.music?.length) {
            mdb.mdb.music = mdb.mdb.music.concat(customDb.mdb.music);
          }
        } catch {}
      }
    }

    const diffName = ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate'];
    function getDiffLevel(mid: number, type: number): number {
      if (!mdb) return 0;
      const song = mdb.mdb.music.find((m: any) => m.id == mid);
      if (!song) return 0;
      const name = diffName[type];
      if (!name) return 0;
      return parseFloat(song.difficulty?.[name]) || 0;
    }

    // Volforce computation (Nabla v7 formula)
    const medalCoef = [0, 0.5, 1.0, 1.02, 1.04, 1.06, 1.1];
    const gradeCoef = [0, 0.8, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.0, 1.02, 1.05];
    function computeForce(diff: number, score: number, medal: number, grade: number) {
      return Math.floor(diff * (score / 10000000) * (gradeCoef[grade] || 0.8) * (medalCoef[medal] || 0.5) * 20);
    }

    // Compute grade from score (Flower doesn't provide grade)
    function gradeFromScore(score: number): number {
      if (score >= 9900000) return 10; // S
      if (score >= 9800000) return 9;  // AAA+
      if (score >= 9700000) return 8;  // AAA
      if (score >= 9500000) return 7;  // AA+
      if (score >= 9300000) return 6;  // AA
      if (score >= 9000000) return 5;  // A+
      if (score >= 8700000) return 4;  // A
      if (score >= 7500000) return 3;  // B
      if (score >= 6500000) return 2;  // C
      return 1; // D
    }

    // Detect if user has a v7 (Nabla) profile to determine target version
    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    const targetVersion = v7Profile ? 7 : 6;

    // Ensure mid is always stored as a number (CSV import may send strings)
    for (const score of scores) {
      if (typeof score.mid === 'string') score.mid = parseInt(score.mid) || score.mid;
    }

    // v6→v7 clear type remapping (UC/PUC/MXV positions differ between versions)
    // EG (v6): 0=none, 1=played, 2=clear, 3=excessive, 4=uc, 5=puc, 6=mxv
    // Nabla (v7): 0=none, 1=played, 2=clear, 3=excessive, 4=mxv, 5=uc, 6=puc
    const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];

    if (targetVersion === 7) {
      for (const score of scores) {
        if (!score.version || score.version === 6) {
          score.clear = nblClearLamp[score.clear] ?? score.clear;
          score.version = 7;
        }
      }
    }

    // PUC (clear=6 in Nabla) requires a perfect 10,000,000 score;
    // downgrade to MXV (clear=4) if score doesn't back it up
    for (const score of scores) {
      if (score.clear === 6 && score.score < 10000000) {
        score.clear = 4;
      }
    }

    const NABLA_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    function clearRank(c: number) {
      return NABLA_CLEAR_RANK[c] ?? 0;
    }

    for (const score of scores) {
      try {
        if (score.score <= 0) { skipped++; continue; } // Skip zero-score entries

        // Compute grade from score if not provided
        const grade = score.grade || gradeFromScore(score.score);

        // Compute volforce for v7
        let volforce = 0;
        if (targetVersion === 7) {
          const diffLevel = getDiffLevel(score.mid, score.type);
          if (diffLevel > 0) {
            volforce = computeForce(diffLevel, score.score, score.clear, grade);
          }
        }

        const existing = await APIFind(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          version: targetVersion,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          if (
            score.score > ex.score ||
            clearRank(score.clear) > clearRank(ex.clear) ||
            (!ex.grade && grade)
          ) {
            const update: any = {};
            if (score.score > ex.score) update.score = score.score;
            if (clearRank(score.clear) > clearRank(ex.clear)) update.clear = score.clear;
            if (grade && (!ex.grade || grade > ex.grade)) update.grade = grade;
            if (score.exscore && (!ex.exscore || score.exscore > ex.exscore))
              update.exscore = score.exscore;
            if (volforce && (!ex.volforce || volforce > ex.volforce))
              update.volforce = volforce;

            if (Object.keys(update).length > 0) {
              await APIUpdate(
                plugin,
                refid,
                { collection: 'music', mid: score.mid, type: score.type, version: targetVersion },
                { $set: update }
              );
              saved++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        const doc: any = {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          score: score.score,
          clear: score.clear,
          exscore: score.exscore || 0,
          grade: grade,
          buttonRate: 0,
          longRate: 0,
          volRate: 0,
          volforce: volforce,
          version: targetVersion,
          dbver: 1,
        };
        if (score.timeAchieved) {
          doc.createdAt = new Date(score.timeAchieved);
          doc.updatedAt = new Date(score.timeAchieved);
        }
        await APIInsert(plugin, refid, doc);
        saved++;
      } catch (err) {
        Logger.error(`Failed to save Flower score mid=${score.mid} type=${score.type}: ${err}`);
      }
    }

    res.json({ success: true, saved, skipped });
  })
);

// Nabla tools
webui.post(
  '/nabla/recalculate-vf',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid } = req.body;
    if (!refid) {
      return res.status(400).json({ success: false, description: 'Missing refid' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const musicDbPath = path.join(
      PLUGIN_PATH,
      'sdvx@asphyxia',
      'webui',
      'asset',
      'json',
      'music_db.json'
    );
    if (!existsSync(musicDbPath)) {
      return res
        .status(500)
        .json({ success: false, description: 'music_db.json not found in plugin folder' });
    }
    const mdb = JSON.parse(readFileSync(musicDbPath, 'utf8'));

    // Merge custom songs if file exists
    const customDbPath = path.join(
      PLUGIN_PATH,
      'sdvx@asphyxia',
      'webui',
      'asset',
      'json',
      'custom_music_db.json'
    );
    if (existsSync(customDbPath)) {
      try {
        const customDb = JSON.parse(readFileSync(customDbPath, 'utf8'));
        if (customDb?.mdb?.music?.length) {
          mdb.mdb.music = mdb.mdb.music.concat(customDb.mdb.music);
        }
      } catch {}
    }

    const medalCoef = [0, 0.5, 1.0, 1.02, 1.04, 1.06, 1.1];
    const gradeCoef = [0, 0.8, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.0, 1.02, 1.05];
    function computeForce(diff: number, score: number, medal: number, grade: number) {
      return Math.floor(diff * (score / 10000000) * gradeCoef[grade] * medalCoef[medal] * 20);
    }

    const diffName = ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate'];
    const plugin = { identifier: 'sdvx@asphyxia', core: false };

    // Check if v7 profile exists; if not, migrate from v6
    let migrated = false;
    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    if (!v7Profile) {
      const v6Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 6 });
      if (!v6Profile) {
        return res
          .status(400)
          .json({ success: false, description: 'No Exceed Gear (v6) profile found to migrate' });
      }

      // Migrate profile
      await APIUpsert(
        plugin,
        refid,
        { collection: 'profile', version: 7 },
        {
          $set: {
            pluginVer: 1,
            dbver: 1,
            collection: 'profile',
            version: 7,
            id: v6Profile.id,
            name: v6Profile.name,
            appeal: 0,
            akaname: 0,
            blocks: 0,
            packets: 0,
            arsOption: 0,
            drawAdjust: 0,
            earlyLateDisp: 0,
            effCLeft: v6Profile.effCLeft,
            effCRight: v6Profile.effCRight,
            gaugeOption: 0,
            hiSpeed: v6Profile.hiSpeed,
            laneSpeed: v6Profile.laneSpeed,
            narrowDown: 0,
            notesOption: 0,
            blasterEnergy: 0,
            bgm: v6Profile.bgm,
            subbg: v6Profile.subbg,
            nemsys: 0,
            stampA: v6Profile.stampA,
            stampB: v6Profile.stampB,
            stampC: v6Profile.stampC,
            stampD: v6Profile.stampD,
            stampRA: v6Profile.stampRA,
            stampRB: v6Profile.stampRB,
            stampRC: v6Profile.stampRC,
            stampRD: v6Profile.stampRD,
            sysBG: 0,
            headphone: 0,
            musicID: 0,
            musicType: 0,
            sortType: 0,
            expPoint: 0,
            mUserCnt: 0,
            boothFrame: [0, 0, 0, 0, 0],
            playCount: 0,
            dayCount: 0,
            todayCount: 0,
            playchain: 0,
            maxPlayChain: 0,
            weekCount: 0,
            weekPlayCount: 0,
            weekChain: 0,
            maxWeekChain: 0,
            bplSupport: v6Profile.bplSupport,
            creatorItem: v6Profile.creatorItem,
          },
        }
      );

      // Migrate items
      const v6Items = await APIFind(plugin, refid, { collection: 'item', version: 6 });
      for (const item of v6Items) {
        await APIUpsert(
          plugin,
          refid,
          { collection: 'item', version: 7, type: item.type, id: item.id },
          {
            $set: { param: item.param },
          }
        );
      }

      // Migrate params
      const v6Params = await APIFind(plugin, refid, { collection: 'param', version: 6 });
      for (const param of v6Params) {
        const paramData = [...(param.param || [])];
        if (param.type === 2 && param.id === 1 && paramData.length > 24) paramData[24] = 0;
        await APIUpsert(
          plugin,
          refid,
          { collection: 'param', version: 7, type: param.type, id: param.id },
          {
            $set: { param: paramData },
          }
        );
      }

      // Migrate scores with clear lamp remapping and volforce computation
      const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];
      const exScoreResetList = [
        { id: 360, type: 3 },
        { id: 580, type: 2 },
        { id: 1121, type: 4 },
        { id: 1185, type: 2 },
        { id: 1199, type: 4 },
        { id: 1738, type: 4 },
        { id: 2242, type: 0 },
      ];
      const levelDifOverride = [
        { mid: 1, type: 1, lvl: 10 },
        { mid: 18, type: 1, lvl: 8 },
        { mid: 18, type: 2, lvl: 10 },
        { mid: 73, type: 2, lvl: 17 },
        { mid: 48, type: 1, lvl: 8 },
        { mid: 75, type: 2, lvl: 12 },
        { mid: 124, type: 2, lvl: 16 },
        { mid: 65, type: 1, lvl: 7 },
        { mid: 66, type: 1, lvl: 8 },
        { mid: 27, type: 1, lvl: 7 },
        { mid: 27, type: 2, lvl: 12 },
        { mid: 68, type: 1, lvl: 9 },
        { mid: 6, type: 1, lvl: 7 },
        { mid: 6, type: 2, lvl: 12 },
        { mid: 16, type: 1, lvl: 7 },
        { mid: 2, type: 1, lvl: 10 },
        { mid: 60, type: 3, lvl: 17 },
        { mid: 5, type: 2, lvl: 13 },
        { mid: 128, type: 2, lvl: 13 },
        { mid: 9, type: 2, lvl: 1 },
        { mid: 340, type: 2, lvl: 13 },
        { mid: 247, type: 3, lvl: 18 },
        { mid: 282, type: 2, lvl: 17 },
        { mid: 288, type: 2, lvl: 13 },
        { mid: 699, type: 3, lvl: 18 },
        { mid: 595, type: 2, lvl: 17 },
        { mid: 507, type: 2, lvl: 17 },
        { mid: 1044, type: 2, lvl: 16 },
        { mid: 948, type: 4, lvl: 16 },
        { mid: 1115, type: 4, lvl: 16 },
        { mid: 1215, type: 2, lvl: 15 },
        { mid: 1152, type: 2, lvl: 15 },
        { mid: 1282, type: 3, lvl: 17.5 },
        { mid: 1343, type: 2, lvl: 16 },
        { mid: 1300, type: 3, lvl: 17.5 },
        { mid: 1938, type: 2, lvl: 18 },
      ];

      const v6Scores = await APIFind(plugin, refid, { collection: 'music', version: 6 });
      for (const rec of v6Scores) {
        const song = mdb.mdb.music.find((s: any) => String(s.id) === String(rec.mid));
        if (!song) continue;

        let diffLevel = parseFloat(song.difficulty[diffName[rec.type]]) || 0;
        const lvOverride = levelDifOverride.find(d => d.mid === rec.mid && d.type === rec.type);
        if (lvOverride) diffLevel = lvOverride.lvl;

        const resetExScore = exScoreResetList.some(d => d.id === rec.mid && d.type === rec.type);
        const exscore = resetExScore ? 0 : rec.exscore || 0;
        const clear = nblClearLamp[rec.clear] ?? rec.clear;

        await APIUpsert(
          plugin,
          refid,
          { collection: 'music', mid: rec.mid, type: rec.type, version: 7 },
          {
            $set: {
              score: rec.score,
              exscore,
              clear,
              grade: rec.grade,
              volforce: computeForce(diffLevel, rec.score, clear, rec.grade),
              buttonRate: rec.buttonRate,
              longRate: rec.longRate,
              volRate: rec.volRate,
            },
          }
        );
      }

      migrated = true;
    }

    const scores = await APIFind(plugin, refid, { collection: 'music', version: 7 });

    let updated = 0;
    for (const score of scores) {
      const song = mdb.mdb.music.find((s: any) => String(s.id) === String(score.mid));
      if (!song) continue;

      const typeIndex = score.type;
      const key =
        typeIndex === 4
          ? song.difficulty.maximum || song.difficulty.infinite
          : song.difficulty[diffName[typeIndex]];
      const diffLevel = parseFloat(key) || 0;
      if (diffLevel === 0) continue;

      const newVf = computeForce(diffLevel, score.score, score.clear, score.grade);
      if (newVf !== score.volforce) {
        await APIUpdate(
          plugin,
          refid,
          { collection: 'music', mid: score.mid, type: score.type, version: 7 },
          { $set: { volforce: newVf } }
        );
        updated++;
      }
    }

    res.json({ success: true, total: scores.length, updated, migrated });
  })
);

// Score migration from another Asphyxia server
webui.post(
  '/migrate/import-scores',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const { refid, scores } = req.body;
    if (!refid || !scores || !Array.isArray(scores)) {
      return res.status(400).json({ success: false, description: 'Missing refid or scores' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const plugin = { identifier: 'sdvx@asphyxia', core: false };
    let saved = 0;
    let skipped = 0;

    const EG_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 6: 4, 4: 5, 5: 6 };
    const NABLA_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    function clearRank(c: number, version?: number) {
      const map = version === 7 ? NABLA_CLEAR_RANK : EG_CLEAR_RANK;
      return map[c] ?? 0;
    }

    // PUC (clear=6 in Nabla) requires a perfect 10,000,000 score;
    // downgrade to MXV (clear=4) if score doesn't back it up
    for (const score of scores) {
      if ((score.version || 6) === 7 && score.clear === 6 && score.score < 10000000) {
        score.clear = 4;
      }
    }

    for (const score of scores) {
      try {
        const existing = await APIFind(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          version: score.version || 6,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          const update: any = {};
          if (score.score > ex.score) {
            update.score = score.score;
            update.buttonRate = score.buttonRate || 0;
            update.longRate = score.longRate || 0;
            update.volRate = score.volRate || 0;
          }
          if (clearRank(score.clear, score.version) > clearRank(ex.clear, ex.version))
            update.clear = score.clear;
          if (score.grade && (!ex.grade || score.grade > ex.grade)) update.grade = score.grade;
          if (score.exscore && (!ex.exscore || score.exscore > ex.exscore))
            update.exscore = score.exscore;
          if (score.volforce && (!ex.volforce || score.volforce > ex.volforce))
            update.volforce = score.volforce;

          if (Object.keys(update).length > 0) {
            await APIUpdate(
              plugin,
              refid,
              {
                collection: 'music',
                mid: score.mid,
                type: score.type,
                version: score.version || 6,
              },
              { $set: update }
            );
            saved++;
          } else {
            skipped++;
          }
          continue;
        }

        await APIInsert(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          score: score.score || 0,
          clear: score.clear || 0,
          exscore: score.exscore || 0,
          grade: score.grade || 0,
          buttonRate: score.buttonRate || 0,
          longRate: score.longRate || 0,
          volRate: score.volRate || 0,
          volforce: score.volforce || 0,
          version: score.version || 6,
          dbver: 1,
        });
        saved++;
      } catch (err) {
        Logger.error(`Failed to migrate score mid=${score.mid} type=${score.type}: ${err}`);
      }
    }

    res.json({ success: true, saved, skipped });
  })
);

// Export savedata for migration to another Asphyxia server
webui.get(
  '/migrate/export-savedata',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) {
      return res.status(400).json({ success: false, description: 'Missing refid' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    // Gather core.db documents (profile + cards)
    const profile = await FindProfile(refid);
    if (!profile) {
      return res.status(404).json({ success: false, description: 'Profile not found' });
    }
    const cards = await FindCardsByRefid(refid);

    // Gather sdvx@asphyxia.db documents (all plugin data for this refid)
    // core: true preserves __s, __refid, _id, createdAt, updatedAt fields
    const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: true };
    const pluginDocs = await APIFind(sdvxPlugin, refid, {});

    // Format as NeDB (one JSON per line, using NeDB's serialize for correct Date handling)
    const coreLines: string[] = [];
    coreLines.push(nedbSerialize(profile));
    if (cards && Array.isArray(cards)) {
      for (const card of cards) {
        coreLines.push(nedbSerialize(card));
      }
    }
    const coreContent = coreLines.join('\n') + '\n';

    const sdvxLines: string[] = [];
    if (pluginDocs && Array.isArray(pluginDocs)) {
      for (const doc of pluginDocs) {
        sdvxLines.push(nedbSerialize(doc));
      }
    }
    const sdvxContent = sdvxLines.join('\n') + '\n';

    // Create zip with maximum compression
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err: Error) => {
      Logger.error(`Export zip generation failed: ${err}`);
      if (!res.headersSent) {
        res.status(500).json({ success: false, description: 'Zip generation failed' });
      }
    });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="savedata.zip"');

    archive.pipe(res);
    archive.append(coreContent, { name: 'savedata/core.db' });
    archive.append(sdvxContent, { name: 'savedata/sdvx@asphyxia.db' });
    await archive.finalize();
  })
);

webui.use('/fun', fun);
webui.use('/', emit);

const markdown = new Converter({
  headerLevelStart: 3,
  strikethrough: true,
  tables: true,
  tasklists: true,
});

async function userOwnsProfile(req: Request, refid: string): Promise<boolean> {
  if (!req.session.user) return false;
  const cardNumber = req.session.user.cardNumber;
  if (!cardNumber) return false;
  const cards = await FindCardsByRefid(refid);
  if (!cards || !Array.isArray(cards)) return false;
  return cards.some((c: any) => c.cid === cardNumber || c.print === cardNumber);
}

function data(req: Request, title: string, plugin: string, attr?: any) {
  const formOk = req.flash('formOk');
  const formWarn = req.flash('formWarn');
  const aside = req.cookies.asidemenu == 'true';

  let formMessage = null;
  if (formOk.length > 0) {
    formMessage = { danger: false, message: formOk.join(' ') };
  } else if (formWarn.length > 0) {
    formMessage = { danger: true, message: formWarn.join(' ') };
  }

  return {
    title,
    aside,
    plugin,
    local: req.ip == '127.0.0.1' || req.ip == '::1',
    version: VERSION,
    user: req.session.user ? req.session.user.username : null,
    admin: req.session.user ? req.session.user.admin : false,
    formMessage,
    plugins: ROOT_CONTAINER.Plugins.map(p => {
      return {
        name: p.Name,
        id: p.Identifier,
        webOnly: p.GameCodes.length == 0,
        pages: p.Pages.filter(f => !HIDDEN_NAV_PAGES.includes(f) && (req.session.user?.admin || !ADMIN_ONLY_PAGES.includes(f))).map(
          f => ({ name: startCase(f), link: f })
        ),
      };
    }),
    ...attr,
  };
}

function validate(c: CONFIG_OPTIONS, current: any) {
  if (c.validator) {
    const msg = c.validator(current);
    if (typeof msg == 'string') {
      return msg.length == 0 ? 'Invalid value' : msg;
    }
  }

  if (c.range) {
    if (c.type == 'float' || c.type == 'integer') {
      if (current < c.range[0] || current > c.range[1]) {
        return `Value must be in between ${c.range[0]} and ${c.range[1]}.`;
      }
    }
  }

  if (c.options) {
    if (c.type == 'string') {
      if (c.options.indexOf(current) < 0) {
        return `Please select an option.`;
      }
    }
  }

  return null;
}

function ConfigData(plugin: string) {
  const config: CONFIG_DATA[] = [];
  const configMap = CONFIG_MAP[plugin];
  const configData = plugin == 'core' ? CONFIG : CONFIG[plugin];

  if (!configMap || !configData) {
    return [];
  }

  if (configMap) {
    for (const [key, c] of configMap) {
      const name = get(c, 'name', upperFirst(lowerCase(key)));
      const current = get(configData, key, c.default);
      let error = validate(c, current);

      config.push({
        key,
        ...c,
        current,
        name,
        error,
      });
    }
  }
  return config;
}

function DataFileCheck(plugin: string) {
  const files: FILE_CHECK[] = [];
  const fileMap = DATAFILE_MAP[plugin];

  if (!fileMap) {
    return [];
  }

  for (const [filepath, c] of fileMap) {
    const target = path.resolve(PLUGIN_PATH, plugin, filepath);
    const filename = path.basename(target);
    const uploaded = existsSync(target);
    const config = { ...c };
    if (!c.name) {
      config.name = filename;
    }
    files.push({ ...config, path: filepath, uploaded, filename });
  }

  return files;
}

webui.get('/favicon.ico', async (req, res) => {
  res.redirect('/static/favicon.ico');
});

webui.get(
  '/',
  wrap(async (req, res) => {
    const memory = `${(process.memoryUsage().rss / 1048576).toFixed(2)}MB`;
    const config = ConfigData('core');

    const changelog = markdown.makeHtml(ReadAssets('changelog.md'));

    const profiles = await GetProfileCount();
    res.render('index', data(req, 'Dashboard', 'core', { memory, config, changelog, profiles }));
  })
);

webui.get(
  '/my-profile',
  wrap(async (req, res) => {
    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        return res.redirect(`/profile/${card.__refid}`);
      }
    }
    return res.redirect('/');
  })
);

webui.get(
  '/profiles',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.redirect('/');
    const profiles = (await GetProfiles()) || [];
    const isAdmin = req.session.user!.admin;
    for (const profile of profiles) {
      profile.cards = await Count({ __s: 'card', __refid: profile.__refid });
      profile.isOwner = await userOwnsProfile(req, profile.__refid);
    }
    res.render('profiles', data(req, 'Profiles', 'core', { profiles, isAdmin }));
  })
);

webui.delete(
  '/profile/:refid',
  wrap(async (req, res) => {
    const refid = req.params['refid'];

    if (await PurgeProfile(refid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

webui.get(
  '/profile/:refid',
  wrap(async (req, res, next) => {
    const refid = req.params['refid'];

    const profile = await FindProfile(refid);
    if (!profile) {
      return next();
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.redirect('/');

    profile.cards = await FindCardsByRefid(refid);

    res.render(
      'profiles_profile',
      data(req, 'Profiles', 'core', { profile, subtitle: profile.name, isAdmin, isOwner })
    );
  })
);

webui.delete(
  '/card/:cid',
  wrap(async (req, res) => {
    const cid = req.params['cid'];

    if (await DeleteCard(cid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

webui.post(
  '/profile/:refid/card',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (!req.session.user!.admin && !(await userOwnsProfile(req, refid)))
      return res.sendStatus(403);
    const card = req.body.cid;

    try {
      const cid = card;
      const print = nfc2card(cid);

      if (!(await FindCard(cid))) {
        await CreateCard(cid, refid, print);
      }
    } catch {}

    try {
      const print = card
        .toUpperCase()
        .trim()
        .replace(/[\s\-]/g, '')
        .replace(/O/g, '0')
        .replace(/I/g, '1');
      const cid = card2nfc(print);
      if (cardType(cid) >= 0 && !(await FindCard(cid))) {
        await CreateCard(cid, refid, print);
      }
    } catch {}

    res.sendStatus(200);
  })
);

webui.post(
  '/profile/:refid',
  urlencoded({ extended: true, limit: '50mb' }),
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (!req.session.user!.admin && !(await userOwnsProfile(req, refid)))
      return res.sendStatus(403);
    const update: any = {};
    if (req.body.pin) {
      update.pin = req.body.pin;
    }
    if (req.body.name) {
      update.name = req.body.name;
    }

    await UpdateProfile(refid, update);
    req.flash('formOk', 'Updated');
    res.redirect(req.originalUrl);
  })
);

// Data Management
webui.get(
  '/data',
  wrap(async (req, res) => {
    if (!req.session.user?.admin) {
      return res.redirect('/');
    }
    const pluginStats = await PluginStats();
    const installed = ROOT_CONTAINER.Plugins.map(p => p.Identifier);
    res.render(
      'data',
      data(req, 'Data Management', 'core', { pluginStats, installed, dev: ARGS.dev })
    );
  })
);

webui.get(
  '/data/:plugin',
  wrap(async (req, res, next) => {
    if (!ARGS.dev) {
      next();
      return;
    }
    const pluginID = req.params['plugin'];

    res.render('data_plugin', data(req, 'Data Management', 'core', { subtitle: pluginID }));
  })
);

webui.post(
  '/data/db',
  json({ limit: '50mb' }),
  wrap(async (req, res, next) => {
    if (!ARGS.dev) {
      next();
      return;
    }
    const command = req.body.command;
    const args = req.body.args;
    const plugin = req.body.plugin;

    try {
      switch (command) {
        case 'FindOne':
          res.json(await (APIFindOne as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Find':
          res.json(await (APIFind as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Insert':
          res.json(await (APIInsert as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Remove':
          res.json(await (APIRemove as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Update':
          res.json(await (APIUpdate as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Upsert':
          res.json(await (APIUpsert as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Count':
          res.json(await (APICount as any)({ identifier: plugin, core: false }, ...args));
          break;
      }
    } catch (err) {
      res.json({ error: err.toString() });
    }
  })
);

webui.delete(
  '/data/:plugin',
  wrap(async (req, res) => {
    const pluginID = req.params['plugin'];
    if (pluginID && pluginID.length > 0) await PurgePlugin(pluginID);

    const plugin = ROOT_CONTAINER.getPluginByID(pluginID);
    if (plugin) {
      // Re-register for init data
      try {
        plugin.Register();
      } catch (err) {
        Logger.error(err, { plugin: pluginID });
      }
    }
    res.sendStatus(200);
  })
);

webui.get(
  '/about',
  wrap(async (req, res) => {
    const contributors = new Map<string, { name: string; link?: string }>();
    for (const plugin of ROOT_CONTAINER.Plugins) {
      for (const c of plugin.Contributors) {
        contributors.set(c.name, c);
      }
    }
    res.render(
      'about',
      data(req, 'About', 'core', { contributors: Array.from(contributors.values()) })
    );
  })
);

// SDVX jacket proxy — serves jackets from the configured game install so
// webui pages can display them without pre-copying. Reads the raw .ifs
// archive on first use (via src/utils/ifs.ts), caches its manifest, and
// streams out PNG-encoded textures on demand. Also honors pre-extracted
// folder layouts (so users who already ran `ifstools` still work).
import {
  openIfs,
  findTextureByBasename,
  extractTextureAsPng,
  extractNamedTextureAsPng,
  findTextureEntryByRealName,
  loadTextureList,
  readTextFile,
  IfsArchive,
} from '../utils/ifs';

const jacketMissCache = new Map<number, number>();
// Per-mid PNG memo. Encoding the PNG is the slow step, so a tiny 256-entry
// cache covers a typical VF-top-50 page with room to spare.
const jacketPngCache = new Map<number, Buffer>();
const JACKET_PNG_CACHE_MAX = 256;

function rememberJacketPng(mid: number, png: Buffer) {
  if (jacketPngCache.size >= JACKET_PNG_CACHE_MAX) {
    const firstKey = jacketPngCache.keys().next().value;
    if (firstKey !== undefined) jacketPngCache.delete(firstKey);
  }
  jacketPngCache.set(mid, png);
}

function findJacketInIfs(archives: IfsArchive[], padded: string): Buffer | null {
  // Jacket filenames inside the IFS are hashed (MD5Folder), so a straight
  // basename lookup won't hit. Instead we consult each archive's
  // `tex/texturelist.xml`, which maps real names (e.g. `jk_0001_0`) to the
  // hashed blob + the imgrect/uvrect the texture was authored with. Try the
  // common suffixes in descending preference order.
  const realNames = [
    `jk_${padded}_0`,
    `jk_${padded}_0_b`,
    `jk_${padded}_0_s`,
    `jk_${padded}_0_t`,
    `jk_${padded}_1`,
  ];
  for (const name of realNames) {
    try {
      const png = extractNamedTextureAsPng(archives, name);
      if (png) return png;
    } catch (err) {
      Logger.warn(`IFS texture extract failed for ${name}: ${(err as Error).message}`);
    }
  }
  // Last-resort: some archives don't use MD5Folder and expose the real name
  // directly in the outer manifest. Try a basename hit.
  for (const archive of archives) {
    for (const name of realNames) {
      const entry = findTextureByBasename(archive, name);
      if (entry && entry.imgrect) {
        try {
          return extractTextureAsPng(archive, entry);
        } catch (err) {
          Logger.warn(`IFS texture extract failed for ${entry.path}: ${(err as Error).message}`);
        }
      }
    }
  }
  return null;
}

// Admin-only IFS diagnostic — reports what the jacket route sees, so we can
// tell quickly whether the manifest parses at all and whether our filename
// lookups match real entries. Returns file counts, a sample of entry names,
// and — when a mid is supplied — the exact basenames that were searched.
webui.get(
  '/api/sdvx/ifs-debug',
  wrap(async (req, res) => {
    if (!req.session.user) return res.sendStatus(401);
    if (!req.session.user.admin) return res.sendStatus(403);

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    if (!gameRoot) return res.status(400).json({ error: 'sdvx_eg_root_dir not configured' });

    const ifsPaths = [
      path.join(gameRoot, 'data', 'graphics', 's_jacket00.ifs'),
      path.join(gameRoot, 'data', 'graphics', 's_jacket01.ifs'),
      path.join(gameRoot, 'data', 'graphics', 's_jacket02.ifs'),
    ];
    const report: any = { gameRoot, archives: [] };
    for (const p of ifsPaths) {
      const exists = existsSync(p);
      const entry: any = { path: p, exists };
      if (exists) {
        try {
          const archive = openIfs(p);
          entry.manifestEnd = archive.manifestEnd;
          entry.fileCount = archive.files.length;
          entry.sampleFiles = archive.files.slice(0, 20).map(f => ({
            path: f.path,
            dataOffset: f.dataOffset,
            dataSize: f.dataSize,
            imgrect: f.imgrect,
            uvrect: f.uvrect,
          }));
          entry.sampleBasenames = Array.from(archive.byBasename.keys()).slice(0, 20);

          // Show a slice of the MD5Folder texturelist (if present) so we
          // can confirm the real asset names parsed out of texturelist.xml.
          const texList = loadTextureList(archive);
          if (texList) {
            entry.textureListSize = texList.size;
            entry.textureListSample = Array.from(texList.keys()).slice(0, 20);
          } else {
            entry.textureListSize = null;
          }

          // Also dump the first ~2KB of the raw texturelist.xml so we can
          // see its structure directly when parsing goes sideways.
          const listEntry = archive.files.find(f => f.path === 'tex/texturelist.xml');
          if (listEntry && req.query.dumpXml === '1') {
            try {
              const xmlText = readTextFile(archive, listEntry);
              entry.textureListXmlPreview = xmlText.slice(0, 2048);
              entry.textureListXmlLength = xmlText.length;
            } catch (err) {
              entry.textureListXmlError = (err as Error).message;
            }
          }

          const probeMid = req.query.mid ? parseInt(String(req.query.mid)) : null;
          if (probeMid) {
            const padded = String(probeMid).padStart(4, '0');
            const realNames = [
              `jk_${padded}_0`,
              `jk_${padded}_0_b`,
              `jk_${padded}_0_s`,
              `jk_${padded}_0_t`,
              `jk_${padded}_1`,
            ];
            entry.probe = {
              mid: probeMid,
              padded,
              realNames: realNames.map(name => {
                const hit = findTextureEntryByRealName([archive], name);
                return {
                  name,
                  foundInTextureList: !!hit,
                  imgrect: hit?.entry.imgrect,
                  fileSize: hit?.entry.file.dataSize,
                };
              }),
              basenameHits: realNames.map(name => ({
                name,
                hit: !!findTextureByBasename(archive, name),
              })),
            };
          }
        } catch (err) {
          entry.error = (err as Error).message;
        }
      }
      report.archives.push(entry);
    }
    return res.json(report);
  })
);

webui.get(
  '/api/sdvx/jacket/:mid.png',
  wrap(async (req, res) => {
    if (!req.session.user) return res.sendStatus(401);
    const mid = parseInt(req.params.mid);
    if (isNaN(mid) || mid <= 0) return res.sendStatus(400);

    // SDVX stores per-difficulty jackets — `jk_<padded>_<diffIdx>_t.png` where
    // diffIdx is 1-indexed (NOV=1, ADV=2, EXH=3, INF/MXM=4, ULT=5). The
    // VF Top 50 page knows the chart's `type` (0..5) and passes it in the
    // query so we can pick the right art per row. Default to 4 (the
    // INF/MXM slot, where most VF-relevant charts live) when the caller
    // doesn't supply a type.
    let type = parseInt(String(req.query.type ?? ''));
    if (!Number.isFinite(type) || type < 0 || type > 5) type = 3;

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    if (!gameRoot) return res.sendStatus(404);

    // Cache key includes type — the same mid can resolve to different
    // PNGs depending on which difficulty's art was requested.
    const cacheKey = mid * 10 + type;

    const cached = jacketPngCache.get(cacheKey);
    if (cached) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

    const cachedMiss = jacketMissCache.get(cacheKey);
    if (cachedMiss && Date.now() - cachedMiss < 60_000) return res.sendStatus(404);

    const padded = String(mid).padStart(4, '0');
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    const preferredDiffIdx = type + 1; // SDVX file naming is 1-indexed

    // 1) Plugin asset folder — where the "Extract Jackets" handler now puts
    //    everything, so the game install stays clean. This is the
    //    primary location.
    // 2) Pre-extracted game-folder layouts (legacy / users who ran ifstools
    //    by hand into data/graphics/s_jacket0X_ifs/tex/ before the move).
    // 3) Custom-chart mix folder, asphyxia's own data_mods area.
    const graphicsDir = path.join(gameRoot, 'data', 'graphics');
    const preextractedDirs: string[] = [
      path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'jackets'),
    ];
    try {
      if (existsSync(graphicsDir)) {
        for (const entry of readdirSync(graphicsDir)) {
          if (/^s_jacket\d+_ifs$/i.test(entry)) {
            preextractedDirs.push(path.join(graphicsDir, entry, 'tex'));
            preextractedDirs.push(path.join(graphicsDir, entry)); // fallback for non-ifstools layouts
          }
        }
      }
    } catch { /* fall through to IFS path */ }
    preextractedDirs.push(path.join(gameRoot, 'data', 'graphics', 's_jacket00'));
    preextractedDirs.push(path.join(gameRoot, 'data_mods', mixName, 'graphics', 's_jacket00_ifs'));
    preextractedDirs.push(path.join(gameRoot, 'data_mods', mixName, 'graphics', 's_jacket00_ifs', 'tex'));

    // Try the preferred difficulty first, then any other difficulty as a
    // fallback (some songs only ship a subset). Within each difficulty,
    // prefer the thumbnail (_t) since that's what ifstools extracts and
    // what the VF Top 50 grid renders at small size, then fall back to
    // full-size variants.
    const diffOrder = [preferredDiffIdx];
    for (let i = 1; i <= 6; i++) if (i !== preferredDiffIdx) diffOrder.push(i);
    // Also try the bare `_0` legacy naming (older extractions / custom mixes).
    const suffixVariants = (idx: number) => [
      `_${idx}_t.png`,
      `_${idx}.png`,
      `_${idx}_b.png`,
      `_${idx}_s.png`,
    ];
    const legacySuffixes = ['_0.png', '_0_b.png', '_0_s.png', '_0_t.png'];

    const tried: string[] = [];
    for (const dir of preextractedDirs) {
      for (const idx of diffOrder) {
        for (const suffix of suffixVariants(idx)) {
          const file = path.join(dir, `jk_${padded}${suffix}`);
          tried.push(file);
          if (existsSync(file)) {
            res.set('Cache-Control', 'public, max-age=86400');
            return res.sendFile(file);
          }
        }
      }
      for (const suffix of legacySuffixes) {
        const file = path.join(dir, `jk_${padded}${suffix}`);
        tried.push(file);
        if (existsSync(file)) {
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(file);
        }
      }
    }

    // 2) Fall back to reading the .ifs archives directly. Same dynamic
    //    discovery — pick up every s_jacket*.ifs in the graphics dir.
    let ifsPaths: string[] = [];
    try {
      if (existsSync(graphicsDir)) {
        ifsPaths = readdirSync(graphicsDir)
          .filter(f => /^s_jacket\d+\.ifs$/i.test(f))
          .map(f => path.join(graphicsDir, f));
      }
    } catch { /* leave empty */ }

    if (ifsPaths.length === 0) {
      jacketMissCache.set(cacheKey, Date.now());
      Logger.warn(
        `sdvx jacket not found for mid=${mid} type=${type} — neither pre-extracted jacket files nor an s_jacket*.ifs archive exist under ${graphicsDir}. First few paths tried:\n  - ${tried
          .slice(0, 5)
          .join('\n  - ')}`,
        { plugin: 'sdvx@asphyxia' }
      );
      return res.sendStatus(404);
    }

    try {
      const archives = ifsPaths.map(p => openIfs(p));
      const png = findJacketInIfs(archives, padded);
      if (png) {
        rememberJacketPng(cacheKey, png);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(png);
      }
    } catch (err) {
      Logger.error(`sdvx jacket IFS read failed for mid=${mid}: ${(err as Error).message}`, {
        plugin: 'sdvx@asphyxia',
      });
      return res.sendStatus(500);
    }

    jacketMissCache.set(cacheKey, Date.now());
    Logger.warn(
      `sdvx jacket not found in IFS for mid=${mid} (padded=${padded}, type=${type}). Archives scanned: ${ifsPaths.join(
        ', '
      )}`,
      { plugin: 'sdvx@asphyxia' }
    );
    return res.sendStatus(404);
  })
);

// Auto-detect a Chromium-compatible browser executable. Used by the VF Top
// 50 PNG render endpoint when the operator hasn't set sdvx_chrome_path
// explicitly. Covers Chrome's three Windows install locations + the system
// Edge fallback (Edge ships pre-installed on Windows 10/11), plus the
// canonical macOS / Linux paths so the same code works on a non-Windows
// asphyxia host.
function autoDetectChromePath(): string | null {
  const env = process.env;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    if (env.ProgramFiles) {
      candidates.push(path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    const pf86 = env['ProgramFiles(x86)'];
    if (pf86) {
      candidates.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/google-chrome-stable');
    candidates.push('/usr/bin/chromium-browser');
    candidates.push('/usr/bin/chromium');
    candidates.push('/snap/bin/chromium');
    candidates.push('/usr/bin/microsoft-edge');
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch { /* ignore bad path */ }
  }
  return null;
}

// VF Top 50 PNG renderer. Designed for a Discord bot or other automation:
// the bot authenticates with an OAuth bearer token (the same token any
// other API endpoint accepts — see the OAuth middleware at the top of
// this file), the endpoint launches puppeteer-core against an
// auto-detected Chrome, opens the existing VF Top 50 page on loopback,
// and returns the rendered PNG.
//
// We reuse the existing pug page instead of re-implementing the layout
// in node-canvas so any CSS / font tweak that lands on the page applies
// automatically. Auth is handled with a one-shot internal render token
// (loopback-only — see the middleware further up) so puppeteer doesn't
// need to forward the bot's OAuth bearer to every sub-resource.
webui.get(
  '/api/sdvx/vf-top-50/:refid.png',
  wrap(async (req, res) => {
    if (!req.session.user) return res.sendStatus(401);

    const refid = req.params.refid;
    if (!refid || refid.length < 8) {
      return res.status(400).json({ success: false, error: 'invalid refid' });
    }

    const isAdmin = !!req.session.user.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    let version = parseInt(String(req.query.version ?? ''));
    if (!Number.isFinite(version) || version < 1 || version > 7) version = 7;

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const explicitChrome = (sdvxConfig.sdvx_chrome_path || '').toString().trim();
    const chromePath = explicitChrome || autoDetectChromePath();
    if (!chromePath) {
      return res.status(500).json({
        success: false,
        error:
          'No Chromium-based browser found on this host. Install Google Chrome (or Microsoft Edge), or set `sdvx_chrome_path` in the plugin config to an explicit executable path.',
      });
    }
    if (explicitChrome && !existsSync(explicitChrome)) {
      return res.status(500).json({
        success: false,
        error: `sdvx_chrome_path is set but does not point at an existing file: ${explicitChrome}`,
      });
    }

    const internalToken = createInternalRenderToken({
      username: req.session.user.username,
      cardNumber: req.session.user.cardNumber || '',
      admin: req.session.user.admin,
    });

    const port = req.socket.localPort || CONFIG.port;
    const targetUrl =
      `http://127.0.0.1:${port}/plugin/sdvx@asphyxia/profile?refid=${encodeURIComponent(refid)}` +
      `&page=------vf_top_50&version=${version}`;

    const puppeteer = require('puppeteer-core');
    let browser: any = null;
    try {
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--hide-scrollbars',
        ],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 1600, deviceScaleFactor: 1 });
      await page.setCookie({
        name: '_render_token',
        value: internalToken,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
      });
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

      // Wait for the canvas root to render with all entries plus their
      // jacket <img>s loaded (or marked broken by onerror — we don't want
      // to hang forever if a single jacket 404s). Also wait on font
      // loading so the export doesn't fall back to the generic sans.
      await page
        .waitForFunction(
          () => {
            const root = document.querySelector('#vf_top50_canvas_root');
            if (!root) return false;
            const entries = root.querySelectorAll('.vf-entry');
            if (entries.length === 0) return false;
            const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
            return imgs.every(img => img.complete);
          },
          { timeout: 15_000 }
        )
        .catch(() => { /* fall through and screenshot whatever rendered */ });
      await page.evaluate(() => (document as any).fonts && (document as any).fonts.ready).catch(() => {});

      const handle = await page.$('#vf_top50_canvas_root');
      if (!handle) {
        throw new Error('VF Top 50 canvas root not found in rendered page');
      }
      const png = await handle.screenshot({ type: 'png' });

      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `inline; filename="vf-top-50-${refid}-v${version}.png"`);
      res.send(png);
    } catch (err: any) {
      Logger.error(`VF Top 50 render failed for refid=${refid}: ${err.message || err}`);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: err.message || 'Render failed',
        });
      }
    } finally {
      consumeInternalRenderToken(internalToken);
      if (browser) {
        try { await browser.close(); } catch { /* best effort */ }
      }
    }
  })
);

// Plugin Overview
webui.get(
  '/plugin/:plugin',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const readmePath = path.join(PLUGIN_PATH, plugin.Identifier, 'README.md');
    let readme = null;
    try {
      if (existsSync(readmePath)) {
        readme = markdown.makeHtml(readFileSync(readmePath, { encoding: 'utf-8' }));
      }
    } catch {
      readme = null;
    }

    const config = ConfigData(plugin.Identifier);
    const datafile = DataFileCheck(plugin.Identifier);
    const contributors = plugin ? plugin.Contributors : [];
    const gameCodes = plugin ? plugin.GameCodes : [];

    res.render(
      'plugin',
      data(req, plugin.Name, plugin.Identifier, {
        readme,
        config,
        datafile,
        contributors,
        gameCodes,
        subtitle: 'Overview',
        subidentifier: 'overview',
      })
    );
  })
);

webui.delete(
  '/plugin/:plugin/profile/:refid',
  wrap(async (req, res) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return res.sendStatus(404);
    }

    const refid = req.params['refid'];
    if (!refid || refid.length < 0) {
      return res.sendStatus(400);
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    if (await APIRemove({ identifier: plugin.Identifier, core: true }, refid, {})) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

// Nautica custom chart downloads
webui.get(
  '/api/nautica/download/:musicId',
  wrap(async (req, res) => {
    if (!req.session.user) return res.sendStatus(401);
    const musicId = parseInt(req.params.musicId);
    if (isNaN(musicId)) return res.sendStatus(400);

    const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: false };
    const song: any = await APIFindOne(sdvxPlugin, { collection: 'nautica_song', mid: musicId });
    if (song && song.driveFileId) {
      return res.redirect(302, `https://drive.google.com/uc?export=download&id=${encodeURIComponent(song.driveFileId)}`);
    }

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    if (!gameRoot) return res.status(400).json({ error: 'Game directory not configured' });

    const modBase = path.join(gameRoot, 'data_mods', mixName);
    const musicBase = path.join(modBase, 'music');
    if (!existsSync(musicBase)) return res.sendStatus(404);

    const idStr = String(musicId).padStart(4, '0');
    const dirs = readdirSync(musicBase);
    const songFolder = dirs.find((d: string) => d.startsWith(idStr + '_'));
    if (!songFolder) return res.sendStatus(404);

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });
    const prefix = `data_mods/${mixName}`;

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="custom_${idStr}.zip"`);
    archive.pipe(res);

    // Music folder
    archive.directory(path.join(musicBase, songFolder), `${prefix}/music/${songFolder}`);

    // Jacket thumbnails
    const thumbDir = path.join(modBase, 'graphics', 's_jacket00_ifs');
    if (existsSync(thumbDir)) {
      const thumbs = readdirSync(thumbDir).filter((f: string) => f.startsWith(`jk_${idStr}_`));
      for (const t of thumbs) {
        archive.file(path.join(thumbDir, t), { name: `${prefix}/graphics/s_jacket00_ifs/${t}` });
      }
    }

    // music_db.merged.xml
    const xmlPath = path.join(modBase, 'others', 'music_db.merged.xml');
    if (existsSync(xmlPath)) {
      archive.file(xmlPath, { name: `${prefix}/others/music_db.merged.xml` });
    }

    await archive.finalize();
  })
);

// Plugin statics
webui.get(
  '/plugin/:plugin/static/*',
  wrap(async (req, res, next) => {
    const data = req.params[0];

    if (data.startsWith('.')) {
      return next();
    }

    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const file = path.join(PLUGIN_PATH, plugin.Identifier, 'webui', data);

    res.sendFile(file, {}, err => {
      if (err) {
        next();
      }
    });
  })
);

// Plugin My Profile (redirect to own profile)
webui.get(
  '/plugin/:plugin/my-profile',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);
    if (!plugin) return next();

    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        return res.redirect(`/plugin/${req.params['plugin']}/profile?refid=${card.__refid}`);
      }
    }
    return res.redirect(`/plugin/${req.params['plugin']}`);
  })
);

// Plugin Profiles
webui.get(
  '/plugin/:plugin/profiles',
  wrap(async (req, res, next) => {
    if (!req.session.user!.admin) return res.redirect('/');

    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const profiles = groupBy(
      await APIFind({ identifier: plugin.Identifier, core: true }, null, {}),
      '__refid'
    );

    const profileData: any[] = [];
    for (const refid in profiles) {
      let name = undefined;
      for (const doc of profiles[refid]) {
        if (doc.__refid == null) {
          PurgeProfile(doc.__refid);
          break;
        }
        if (typeof doc.name == 'string') {
          name = doc.name;
          break;
        }
      }

      profileData.push({
        refid,
        name,
        dataSize: sizeof(profiles[refid], true),
        coreProfile: await FindProfile(refid),
        isOwner: await userOwnsProfile(req, refid),
      });
    }

    const isAdmin = req.session.user!.admin;

    res.render(
      'plugin_profiles',
      data(req, plugin.Name, plugin.Identifier, {
        subtitle: 'Profiles',
        subidentifier: 'profiles',
        hasCustomPage: plugin.FirstProfilePage != null,
        profiles: profileData,
        isAdmin,
      })
    );
  })
);

// Plugin Profile Page
webui.get(
  '/plugin/:plugin/profile',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const refid = req.query['refid'];

    if (refid == null) {
      return next();
    }

    const pageName = req.query['page'];

    let page = null;
    if (pageName == null) {
      page = plugin.FirstProfilePage;
    } else {
      page = `profile_${pageName.toString()}`;
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid.toString());

    const ownerOnlyPages = ['profile_import', 'profile_export', 'profile_nabla'];
    if (ownerOnlyPages.includes(page) && !isAdmin && !isOwner) {
      return res.redirect(`/plugin/${req.params['plugin']}/profile?refid=${refid}`);
    }

    const content = await plugin.render(page, { query: req.query }, refid.toString());
    if (content == null) {
      return next();
    }

    const tabs = plugin.ProfilePages.filter(
      p => !ownerOnlyPages.includes(p) || isAdmin || isOwner
    ).map(p => ({
      name: startCase(p.substr(8)),
      link: p.substr(8),
    }));

    res.render(
      'custom_profile',
      data(req, plugin.Name, plugin.Identifier, {
        content,
        tabs,
        subtitle: 'Profiles',
        subidentifier: 'profiles',
        subsubtitle: startCase(page.substr(8)),
        subsubidentifier: page.substr(8),
        refid: refid.toString(),
        isAdmin,
        isOwner,
      })
    );
  })
);

// Plugin Custom Pages
webui.get(
  '/plugin/:plugin/:page',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const pageName = req.params['page'];

    if (ADMIN_ONLY_PAGES.includes(pageName) && !req.session.user!.admin) {
      return res.redirect('/');
    }

    const content = await plugin.render(pageName, { query: req.query });
    if (content == null) {
      return next();
    }

    res.render(
      'custom',
      data(req, plugin.Name, plugin.Identifier, {
        content,
        subtitle: startCase(pageName),
        subidentifier: pageName,
      })
    );
  })
);

// General setting update
webui.post(
  '*',
  urlencoded({ extended: true, limit: '50mb' }),
  wrap(async (req, res) => {
    const page = req.query.page;

    if (isEmpty(req.body)) {
      res.sendStatus(400);
      return;
    }

    let plugin: string = null;
    if (req.path == '/') {
      plugin = 'core';
    } else if (req.path.startsWith('/plugin/')) {
      plugin = path.basename(req.path);
    }

    if (plugin == null) {
      res.redirect(req.originalUrl);
      return;
    }

    if (page) {
      // Custom page form
    } else {
      const configMap = CONFIG_MAP[plugin];
      const configData = plugin == 'core' ? CONFIG : CONFIG[plugin];

      if (configMap == null || configData == null) {
        res.redirect(req.originalUrl);
        return;
      }

      let needRestart = false;

      for (const [key, config] of configMap) {
        const current = configData[key];
        if (config.type == 'boolean') {
          configData[key] = req.body[key] ? true : false;
        }
        if (config.type == 'float') {
          configData[key] = parseFloat(req.body[key]);
          if (isNaN(configData[key])) {
            configData[key] = config.default;
          }
        }
        if (config.type == 'integer') {
          configData[key] = parseInt(req.body[key]);
          if (isNaN(configData[key])) {
            configData[key] = config.default;
          }
        }
        if (config.type == 'string') {
          configData[key] = req.body[key];
        }

        if (current !== configData[key]) {
          if (!validate(config, configData[key])) {
            if (config.needRestart) {
              needRestart = true;
            }
          }
        }
      }

      if (needRestart) {
        req.flash('formWarn', 'Some settings require a restart to be applied.');
      } else {
        req.flash('formOk', 'Updated');
      }

      SaveConfig();
    }

    res.redirect(req.originalUrl);
  })
);

// 404
webui.use(async (req, res, next) => {
  return res.status(404).render('404', data(req, '404 - Are you lost?', 'core'));
});

// 500 - Any server error
webui.use((err: any, req: any, res: any, next: any) => {
  return res.status(500).render('500', data(req, '500 - Oops', 'core', { err }));
});
