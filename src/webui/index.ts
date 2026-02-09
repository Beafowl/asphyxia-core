import { Router, RequestHandler, Request } from 'express';
import { existsSync, readFileSync } from 'fs';
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

const memorystore = createMemoryStore(session);

declare module 'express-session' {
  interface SessionData {
    user?: { username: string; cardNumber: string; admin: boolean };
  }
}

export const webui = Router();
webui.use(
  session({
    cookie: { maxAge: 86400000, sameSite: true },
    secret: 'c0dedeadc0debeef',
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

// Auth routes (accessible without login)
webui.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: req.flash('authError')[0] || null });
});

webui.post(
  '/login',
  wrap(async (req, res) => {
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

    const existingAccount = await FindUserByCardNumber(nfcId);
    if (existingAccount) {
      return res.render('signup', {
        error: 'This card number is already registered to an account.',
        old,
      });
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

// Tachi OAuth callback (before auth middleware - opened in popup without session)
webui.get('/tachi/callback', (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing authorization code');
  res.send(`<html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'tachi-auth', code: '${code}' }, '*');
    }
    window.close();
  </script><p>Authorization complete. You can close this window.</p></body></html>`);
});

// Auth middleware - all routes below require login
webui.use((req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
});

// Admin-only DELETE middleware - block all DELETE requests for non-admins
webui.use((req, res, next) => {
  if (req.method === 'DELETE' && !req.session.user!.admin) {
    return res.sendStatus(403);
  }
  next();
});

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
const TACHI_CLIENT_ID = 'CI9339507b051068964d992b471e1d051bfda25e65';
const TACHI_CLIENT_SECRET = 'CS75ceb8312e17588e6a3061ddd928f431f61897b8';
const TACHI_BASE_URL = 'https://kamai.tachi.ac';

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
      client_id: TACHI_CLIENT_ID,
      client_secret: TACHI_CLIENT_SECRET,
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
    res.json({ authorized: !!token });
  })
);

webui.post(
  '/tachi/disconnect',
  wrap(async (req, res) => {
    await DeleteTachiToken(req.session.user!.username);
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

    for (const score of scores) {
      try {
        // Check if score already exists for this refid
        const existing = await APIFind(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          // Update if incoming score is higher, or existing has missing grade
          if (score.score > ex.score || score.clear > ex.clear || (!ex.grade && score.grade)) {
            const update: any = {};
            if (score.score > ex.score) update.score = score.score;
            if (score.clear > ex.clear) update.clear = score.clear;
            if (score.grade && (!ex.grade || score.grade > ex.grade)) update.grade = score.grade;
            if (score.exscore && (!ex.exscore || score.exscore > ex.exscore))
              update.exscore = score.exscore;

            if (Object.keys(update).length > 0) {
              await APIUpdate(
                plugin,
                refid,
                { collection: 'music', mid: score.mid, type: score.type },
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
        await APIInsert(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          score: score.score,
          clear: score.clear,
          exscore: score.exscore || 0,
          grade: score.grade || 0,
          buttonRate: 0,
          longRate: 0,
          volRate: 0,
          version: score.version || 6,
          dbver: 1,
        });
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

    const result = await tachiGet('/api/v1/users/me/games/sdvx/Single/pbs/best');
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
    const limit = Math.min(pbs.length, 50);
    for (let i = 0; i < limit; i++) {
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
        songName: song.title,
        difficulty: chart.difficulty,
        lamp: pb.scoreData.lamp,
      });
    }

    res.json({ success: true, scores });
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
        pages: p.Pages.map(f => ({ name: startCase(f), link: f })),
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
  '/profiles',
  wrap(async (req, res) => {
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
    if (!isAdmin && !isOwner) return res.redirect('/profiles');

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

// Plugin Profiles
webui.get(
  '/plugin/:plugin/profiles',
  wrap(async (req, res, next) => {
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

    const content = await plugin.render(page, { query: req.query }, refid.toString());
    if (content == null) {
      return next();
    }

    const tabs = plugin.ProfilePages.map(p => ({
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
