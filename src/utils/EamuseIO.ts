import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFile,
  readFile,
  readdir,
  unlink,
  WriteFileOptions,
} from 'fs';

import { Logger } from './Logger';
import path from 'path';
import { SqliteStore } from './SqliteStore';
import { nfc2card } from './CardCipher';
import hashids from 'hashids/cjs';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { NAMES } from './Consts';
import { CONFIG, ARGS } from './ArgConfig';
import { isArray, get, isPlainObject, sortBy } from 'lodash';
import { PluginDetect } from '../eamuse/ExternalPluginLoader';
import { ROOT_CONTAINER } from '../eamuse';
import { promises as fsp } from 'fs';
import prettyBytes from 'pretty-bytes';

const pkg: boolean = (process as any).pkg;
const EXEC_PATH = path.resolve(pkg ? path.dirname(process.argv0) : process.cwd());

export const PLUGIN_PATH = path.join(EXEC_PATH, 'plugins');
export const ASSETS_PATH = path.join(pkg ? __dirname : `../build-env`, 'assets');

export const SAVE_PATH = path.resolve(EXEC_PATH, ARGS.savedata);
const COREDB_FILE = path.join(SAVE_PATH, 'core.db');

// Sniff a file's first 16 bytes to detect leftover NeDB / NDJSON saves.
// SQLite files start with the literal "SQLite format 3\0"; legacy NeDB
// `.db` files are line-delimited JSON whose first byte is '{'. If we see
// the legacy format, exit with a clear message pointing at the migration
// script so users don't end up with a half-loaded server.
const isLegacyNedbFile = (file: string): boolean => {
  try {
    const fd = require('fs').openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const n = require('fs').readSync(fd, buf, 0, 16, 0);
    require('fs').closeSync(fd);
    if (n <= 0) return false;
    if (buf.toString('ascii', 0, 15) === 'SQLite format 3') return false;
    // First non-whitespace byte: '{' indicates NDJSON.
    for (let i = 0; i < n; i++) {
      const c = buf[i];
      if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20) continue;
      return c === 0x7b; // '{'
    }
    return false;
  } catch {
    return false;
  }
};

const LoadDatabase = async (file: string) => {
  const filename = path.basename(file);

  if (existsSync(file) && isLegacyNedbFile(file)) {
    Logger.error(
      `Savedata "${filename}" is in the legacy NeDB format. Run "node scripts/migrate-nedb-to-sqlite.js" to convert your savedata directory before starting the server.`
    );
    process.exit(1);
  }

  let DB: SqliteStore;
  try {
    DB = new SqliteStore({ filename: file, timestampData: true });
    await DB.loadDatabaseAsync();
    if (filename != 'core.db') Logger.info(`Database loaded: ${filename}`, { plugin: 'db' });
  } catch (err) {
    Logger.error(`Can not load database "${filename}":`);
    Logger.error(err);
    return null;
  }

  // Carryover from the NeDB era — old code re-asserted indices on every
  // boot. SqliteStore creates the covering indices on construction, so
  // these calls are no-ops; kept for surface compatibility with anything
  // that still calls ensureIndexAsync directly.
  try {
    await DB.ensureIndexAsync({ fieldName: '__s' });
    await DB.ensureIndexAsync({ fieldName: '__refid' });
  } catch (err) {
    Logger.error(err);
  }

  try {
    await DB.removeAsync({ __s: 'plugins_profile', __refid: { $exists: false } }, { multi: true });
  } catch (err) {
    Logger.error(err);
  }

  return DB;
};

let CoreDB: SqliteStore = null;
export const LoadCoreDB = async () => {
  CoreDB = await LoadDatabase(COREDB_FILE);

  if (!CoreDB) {
    process.exit(1);
  }

  try {
    await CoreDB.ensureIndexAsync({ fieldName: 'cid' });
    await CoreDB.ensureIndexAsync({ fieldName: 'username' });
  } catch (err) {
    Logger.error(err);
  }
};

// =========================================
//        Hot-path TTL cache for cards/profiles
// =========================================
// NeDB indexes already make these lookups O(log n), but games call inquire/load
// on every boot, so a short TTL cache collapses the per-boot flurry into a
// single hit. Negative results (null) are cached too so missing cards don't
// re-query on each retry. Invalidated on every write path below.

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const cardCache = new Map<string, CacheEntry<any>>();
const profileCache = new Map<string, CacheEntry<any>>();

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): { hit: boolean; value?: T } {
  const entry = cache.get(key);
  if (!entry) return { hit: false };
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const evict = cache.size - Math.floor(CACHE_MAX_ENTRIES * 0.9);
    const it = cache.keys();
    for (let i = 0; i < evict; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      cache.delete(k);
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function invalidateCard(cid: string) {
  cardCache.delete(cid);
}

function invalidateProfile(refid: string) {
  profileCache.delete(refid);
}

function invalidateCardsByRefid(refid: string) {
  for (const [cid, entry] of cardCache) {
    if (entry.value && entry.value.__refid === refid) cardCache.delete(cid);
  }
}

const DBInstances: { [key: string]: SqliteStore } = {};

const GET_DB = async (affiliation: string) => {
  if (!DBInstances[affiliation]) {
    DBInstances[affiliation] = await LoadDatabase(path.join(SAVE_PATH, `${affiliation}.db`));
    if (!DBInstances[affiliation]) {
      delete DBInstances[affiliation];
      return null;
    }
  }

  return DBInstances[affiliation];
};

const ID_GEN = new hashids('AsphyxiaCORE', 15, '0123456789ABCDEF');

export function PrepareDirectory(dir: string = ''): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return dir;
}

export function ReadAssets(file: string): any {
  let fullFile = path.join(ASSETS_PATH, `${file}`);

  try {
    if (!existsSync(fullFile)) {
      return null;
    }
    const data = readFileSync(fullFile, {
      encoding: 'utf-8',
    });
    return data;
  } catch (err) {
    return null;
  }
}

// =========================================
//                Public IO
// =========================================
export function Resolve(plugin: PluginDetect, file: string) {
  return path.resolve(PLUGIN_PATH, plugin.identifier, file);
}

export async function ReadDir(plugin: PluginDetect, file: string) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  return new Promise<{ name: string; type: 'file' | 'dir' | 'unsupported' }[]>(resolve => {
    readdir(target, { encoding: 'utf8', withFileTypes: true }, (err, files) => {
      if (err) {
        Logger.error(`File writing failed: ${err}`, { plugin });
        return resolve([]);
      }
      resolve(
        files.map(file => ({
          name: file.name,
          type: file.isFile() ? 'file' : file.isDirectory() ? 'dir' : 'unsupported',
        }))
      );
    });
  });
}

export function Exists(plugin: PluginDetect, file: string) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);
  return existsSync(target);
}

export async function WriteFile(
  plugin: PluginDetect,
  file: string,
  data: string | Buffer,
  options: WriteFileOptions
) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  PrepareDirectory(path.dirname(target));

  return new Promise<void>(resolve => {
    if (options == null) {
      writeFile(target, data, err => {
        if (err) {
          Logger.error(`File writing failed: ${err}`, { plugin });
        }
        resolve();
      });
    } else {
      writeFile(target, data, options, err => {
        if (err) {
          Logger.error(`File writing failed: ${err}`, { plugin: plugin });
        }
        resolve();
      });
    }
  });
}

export async function DeleteFile(plugin: PluginDetect, file: string) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  return new Promise<void>(resolve => {
    unlink(target, err => {
      if (err) {
        Logger.error(`File writing failed: ${err}`, { plugin });
      }
      resolve();
    });
  });
}

export async function ReadFile(
  plugin: PluginDetect,
  file: string,
  options: { encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | undefined | null
) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  return new Promise<string | Buffer>(resolve => {
    if (options == null) {
      readFile(target, (err, data) => {
        if (err) {
          Logger.error(`File reading failed: ${err}`, { plugin: plugin });
          return resolve(null);
        }
        return resolve(data);
      });
    } else {
      readFile(target, options, (err, data) => {
        if (err) {
          Logger.error(`File reading failed: ${err}`, { plugin: plugin });
          return resolve(null);
        }
        return resolve(data);
      });
    }
  });
}

// =========================================
//                DB Wrapper
// =========================================

export async function GetUniqueInt() {
  try {
    const doc = await CoreDB.findOneAsync<any>({
      __s: 'counter',
    });
    const result = doc ? doc.value : 0;
    await CoreDB.updateAsync(
      {
        __s: 'counter',
      },
      { $inc: { value: 1 } },
      { upsert: true }
    );
    return result;
  } catch (err) {
    Logger.error(err);
    return -1;
  }
}

export async function PluginStats(): Promise<
  {
    name: string;
    id: string;
    dataSize: string;
    hasData: boolean;
  }[]
> {
  const list = await fsp.readdir(SAVE_PATH);
  const result = [];

  for (const installed of ROOT_CONTAINER.Plugins.map(e => e.Identifier)) {
    if (list.indexOf(`${installed}.db`) < 0) {
      result.push({
        name: installed.split('@')[0].toUpperCase(),
        id: installed,
        dataSize: 'No Data',
        hasData: false,
      });
    }
  }

  for (const savefile of list) {
    if (savefile.startsWith('_') || savefile.startsWith('.') || savefile.startsWith('core')) {
      continue;
    }

    try {
      const filestat = await fsp.stat(path.join(SAVE_PATH, savefile));

      const basename = path.basename(savefile, '.db');
      result.push({
        name: basename.split('@')[0].toUpperCase(),
        id: basename,
        dataSize: prettyBytes(filestat.size),
        hasData: true,
      });
    } catch (err) {
      Logger.error(`Cannot read savefile ${savefile}:`);
      Logger.error(err);
    }
  }

  return sortBy(result, 'id');
}

export async function PurgePlugin(affiliation: string) {
  try {
    if (DBInstances[affiliation]) {
      delete DBInstances[affiliation];
    }
    await fsp.unlink(path.join(SAVE_PATH, `${affiliation}.db`));
  } catch (err) {
    Logger.error(`Cannot delete savefile ${affiliation}.db:`);
    Logger.error(err);
  }
}

export async function Count(doc: any) {
  try {
    return await CoreDB.countAsync(doc);
  } catch (err) {
    Logger.error(err);
    return -1;
  }
}

export async function GetProfileCount() {
  return await Count({ __s: 'profile' });
}

export async function FindCard(cid: string) {
  const cached = cacheGet(cardCache, cid);
  if (cached.hit) return cached.value;
  try {
    const result = await CoreDB.findOneAsync<any>({ __s: 'card', cid });
    cacheSet(cardCache, cid, result);
    return result;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function FindCardsByRefid(refid: string) {
  try {
    return await CoreDB.findAsync<any>({ __s: 'card', __refid: refid })
      .sort({ createdAt: 1 })
      .execAsync();
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function CreateCard(cid: string, refid: string, forcePrint?: string) {
  let print = '<Invalid Card>';

  if (forcePrint) {
    print = forcePrint;
  } else {
    try {
      print = nfc2card(cid);
    } catch (err) {
      print = '<Invalid Card>';
    }
  }

  try {
    const result = await CoreDB.insertAsync<any>({ __s: 'card', __refid: refid, print, cid });
    invalidateCard(cid);
    return result;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function DeleteCard(cid: string) {
  try {
    await CoreDB.removeAsync({ __s: 'card', cid }, { multi: true });
    invalidateCard(cid);
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function FindProfile(refid: string) {
  const cached = cacheGet(profileCache, refid);
  if (cached.hit) return cached.value;
  try {
    const result = await CoreDB.findOneAsync<any>({
      __s: 'profile',
      __refid: refid,
    });
    cacheSet(profileCache, refid, result);
    return result;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function CreateProfile(pin: string, gameCode: string) {
  if (!CONFIG.allow_register) return false;

  const count = await GetUniqueInt();
  if (count < 0) return false;

  const refid = 'A' + ID_GEN.encode(count * 16 + Math.floor(Math.random() * 16));
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];

  try {
    const result = await CoreDB.insertAsync({
      __s: 'profile',
      __refid: refid,
      pin,
      name,
      models: [gameCode],
    });
    invalidateProfile(refid);
    return result;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function UpdateProfile(refid: string, update: any, upsert: boolean = false) {
  try {
    await CoreDB.updateAsync(
      {
        __s: 'profile',
        __refid: refid,
      },
      {
        $set: update,
      },
      { upsert }
    );
    invalidateProfile(refid);
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function PurgeProfile(refid: string) {
  try {
    await CoreDB.removeAsync({ __refid: refid }, { multi: true });
    invalidateProfile(refid);
    invalidateCardsByRefid(refid);
  } catch (err) {
    Logger.error(err);
    return false;
  }

  const list = await fsp.readdir(SAVE_PATH);
  for (const savefile of list) {
    if (savefile.startsWith('_') || savefile.startsWith('.') || savefile.startsWith('core')) {
      continue;
    }

    const affiliation = path.basename(savefile, '.db');

    const DB = await GET_DB(affiliation);
    if (DB) {
      try {
        await DB.removeAsync({ __refid: refid }, { multi: true });
      } catch (err) {
        Logger.error(err);
      }
    }
  }

  return true;
}

export async function BindProfile(refid: string, gameCode: string) {
  try {
    const result = await CoreDB.updateAsync(
      {
        __s: 'profile',
        __refid: refid,
      },
      { $addToSet: { models: gameCode } }
    );
    invalidateProfile(refid);
    return result;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

// =========================================
//             User Accounts
// =========================================

export async function SeedDefaultAdmin() {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'user_account', admin: true });
    if (existing) return;

    const hash = await bcrypt.hash('admin', 10);
    await CoreDB.insertAsync({
      __s: 'user_account',
      username: 'admin',
      password: hash,
      cardNumber: '',
      admin: true,
    });
    Logger.info('Default admin account created (username: admin, password: admin)');
  } catch (err) {
    Logger.error(err);
  }
}

export async function CreateUserAccount(
  username: string,
  password: string,
  cardNumber: string,
  admin: boolean = false
) {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'user_account', username });
    if (existing) return null;

    const hash = await bcrypt.hash(password, 10);
    return await CoreDB.insertAsync({
      __s: 'user_account',
      username,
      password: hash,
      cardNumber,
      admin,
    });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function AuthenticateUser(username: string, password: string) {
  try {
    const user = await CoreDB.findOneAsync<any>({ __s: 'user_account', username });
    if (!user) return null;

    const match = await bcrypt.compare(password, user.password);
    return match ? user : null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function UpdateUserAccount(
  username: string,
  update: { username?: string; password?: string }
) {
  try {
    const setFields: any = {};
    if (update.username) setFields.username = update.username;
    if (update.password) setFields.password = await bcrypt.hash(update.password, 10);

    await CoreDB.updateAsync({ __s: 'user_account', username }, { $set: setFields });
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetAllUsers(): Promise<any[]> {
  try {
    return await CoreDB.findAsync<any>({ __s: 'user_account' }).sort({ createdAt: 1 }).execAsync();
  } catch (err) {
    Logger.error(err);
    return [];
  }
}

export async function SetUserAdmin(username: string, admin: boolean) {
  try {
    await CoreDB.updateAsync({ __s: 'user_account', username }, { $set: { admin } });
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function FindUserByUsername(username: string) {
  try {
    return await CoreDB.findOneAsync<any>({ __s: 'user_account', username });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function FindUserByCardNumber(cardNumber: string) {
  try {
    return await CoreDB.findOneAsync<any>({ __s: 'user_account', cardNumber });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function SaveTachiToken(username: string, token: string) {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'tachi_token', username });
    if (existing) {
      await CoreDB.updateAsync({ __s: 'tachi_token', username }, { $set: { token } });
    } else {
      await CoreDB.insertAsync({ __s: 'tachi_token', username, token });
    }
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiToken(username: string): Promise<string | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'tachi_token', username });
    return doc ? doc.token : null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function DeleteTachiToken(username: string) {
  try {
    await CoreDB.removeAsync({ __s: 'tachi_token', username }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function SaveTachiExportTimestamp(refid: string, timestamp: number) {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'tachi_export_ts', refid });
    if (existing) {
      await CoreDB.updateAsync({ __s: 'tachi_export_ts', refid }, { $set: { timestamp } });
    } else {
      await CoreDB.insertAsync({ __s: 'tachi_export_ts', refid, timestamp });
    }
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiExportTimestamp(refid: string): Promise<number | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'tachi_export_ts', refid });
    return doc ? doc.timestamp : null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function SaveTachiAutoExport(refid: string, enabled: boolean) {
  try {
    await CoreDB.updateAsync(
      { __s: 'tachi_auto_export', refid },
      { __s: 'tachi_auto_export', refid, enabled },
      { upsert: true }
    );
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiAutoExport(refid: string): Promise<boolean> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'tachi_auto_export', refid });
    return doc ? doc.enabled : false;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiTokenByRefid(refid: string): Promise<string | null> {
  try {
    const cards = await FindCardsByRefid(refid);
    if (!cards || !Array.isArray(cards) || cards.length === 0) return null;
    for (const card of cards) {
      const user = await FindUserByCardNumber(card.cid);
      if (user) {
        const token = await GetTachiToken(user.username);
        if (token) return token;
      }
    }
    return null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function SaveFlowerToken(username: string, token: string) {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'flower_token', username });
    if (existing) {
      await CoreDB.updateAsync({ __s: 'flower_token', username }, { $set: { token } });
    } else {
      await CoreDB.insertAsync({ __s: 'flower_token', username, token });
    }
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetFlowerToken(username: string): Promise<string | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'flower_token', username });
    return doc ? doc.token : null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function DeleteFlowerToken(username: string) {
  try {
    await CoreDB.removeAsync({ __s: 'flower_token', username }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

// =========================================
//             API Tokens
// =========================================

export async function GenerateApiToken(username: string): Promise<string | null> {
  try {
    const token = randomBytes(32).toString('hex');
    const existing = await CoreDB.findOneAsync<any>({ __s: 'api_token', username });
    if (existing) {
      await CoreDB.updateAsync({ __s: 'api_token', username }, { $set: { token } });
    } else {
      await CoreDB.insertAsync({ __s: 'api_token', username, token });
    }
    return token;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetApiTokenByToken(
  token: string
): Promise<{ username: string; cardNumber: string; admin: boolean } | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'api_token', token });
    if (!doc) return null;
    const user = await FindUserByUsername(doc.username);
    if (!user) return null;
    return { username: user.username, cardNumber: user.cardNumber, admin: user.admin };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetApiTokenExists(username: string): Promise<boolean> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'api_token', username });
    return !!doc;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function DeleteApiToken(username: string): Promise<boolean> {
  try {
    await CoreDB.removeAsync({ __s: 'api_token', username }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

// =========================================
//             OAuth Provider
// =========================================

export async function CreateOAuthClient(
  name: string,
  redirectUri: string,
  createdBy: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const clientId = randomBytes(16).toString('hex');
    const clientSecret = randomBytes(32).toString('hex');
    await CoreDB.insertAsync({
      __s: 'oauth_client',
      clientId,
      clientSecret,
      name,
      redirectUri,
      createdBy,
    });
    return { clientId, clientSecret };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetOAuthClient(clientId: string) {
  try {
    return await CoreDB.findOneAsync<any>({ __s: 'oauth_client', clientId });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetOAuthClientsByUser(username: string): Promise<any[]> {
  try {
    return await CoreDB.findAsync<any>({ __s: 'oauth_client', createdBy: username });
  } catch (err) {
    Logger.error(err);
    return [];
  }
}

export async function DeleteOAuthClient(clientId: string, username: string): Promise<boolean> {
  try {
    // Also clean up any tokens and codes issued for this client
    await CoreDB.removeAsync({ __s: 'oauth_code', clientId }, { multi: true });
    await CoreDB.removeAsync({ __s: 'oauth_access_token', clientId }, { multi: true });
    await CoreDB.removeAsync({ __s: 'oauth_client', clientId, createdBy: username }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function CreateOAuthCode(
  clientId: string,
  username: string,
  redirectUri: string,
  scopes: string[]
): Promise<string | null> {
  try {
    const code = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    await CoreDB.insertAsync({
      __s: 'oauth_code',
      code,
      clientId,
      username,
      redirectUri,
      scopes,
      expiresAt,
    });
    return code;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function ConsumeOAuthCode(code: string) {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'oauth_code', code });
    if (!doc) return null;
    await CoreDB.removeAsync({ __s: 'oauth_code', code }, {});
    if (doc.expiresAt < Date.now()) return null;
    return doc;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function CreateOAuthAccessToken(
  clientId: string,
  username: string,
  scopes: string[]
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    await CoreDB.insertAsync({
      __s: 'oauth_access_token',
      accessToken,
      refreshToken,
      clientId,
      username,
      scopes,
      expiresAt,
    });
    return { accessToken, refreshToken };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetOAuthAccessToken(
  token: string
): Promise<{ username: string; cardNumber: string; admin: boolean; scopes: string[] } | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'oauth_access_token', accessToken: token });
    if (!doc) return null;
    if (doc.expiresAt < Date.now()) {
      await CoreDB.removeAsync({ __s: 'oauth_access_token', accessToken: token }, {});
      return null;
    }
    const user = await FindUserByUsername(doc.username);
    if (!user) return null;
    return { username: user.username, cardNumber: user.cardNumber, admin: user.admin, scopes: doc.scopes };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function RefreshOAuthAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'oauth_access_token', refreshToken });
    if (!doc) return null;

    const newAccessToken = randomBytes(32).toString('hex');
    const newRefreshToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    await CoreDB.updateAsync(
      { __s: 'oauth_access_token', refreshToken },
      { $set: { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresAt } }
    );
    return { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: 86400 };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function RevokeOAuthToken(token: string): Promise<boolean> {
  try {
    await CoreDB.removeAsync({ __s: 'oauth_access_token', accessToken: token }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetOAuthTokensByUser(username: string): Promise<any[]> {
  try {
    return await CoreDB.findAsync<any>({ __s: 'oauth_access_token', username });
  } catch (err) {
    Logger.error(err);
    return [];
  }
}

export async function RevokeOAuthTokensByClientForUser(clientId: string, username: string): Promise<boolean> {
  try {
    await CoreDB.removeAsync({ __s: 'oauth_access_token', clientId, username }, { multi: true });
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetProfiles() {
  try {
    return (await CoreDB.findAsync<any>({
      __s: 'profile',
    })
      .sort({ createdAt: 1 })
      .execAsync()) as any[];
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

// Public API
function CheckQuery(query: any): any {
  const sanitized: any = {};
  if (isPlainObject(query)) {
    for (const key in query) {
      if (key == '__refid') continue; // ignore __refid
      if (key.startsWith('__')) throw new Error('query or doc field can not starts with "__"');

      sanitized[key] = CheckQuery(query[key]);
    }
    return sanitized;
  } else {
    return query;
  }
}

function CleanDoc(doc: any) {
  if (Array.isArray(doc)) {
    for (const item of doc) {
      CleanDoc(item);
    }
  } else {
    for (const prop in doc) {
      if (prop.startsWith('__') && prop != '__refid') {
        delete doc[prop];
      }
    }
  }
  return doc;
}

export async function APIFindOne(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;

  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid FindOne query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const result = await DB.findOneAsync(query, {});
  return plugin.core ? result : CleanDoc(result);
}

export async function APIFind(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Find query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const result = await DB.findAsync<any>(query, {}).sort({ createdAt: 1 }).execAsync();
  return plugin.core ? result : (CleanDoc(result) as any[]);
}

export async function APIInsert(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let doc: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    if (!plugin.core) {
      const profile = await FindProfile(arg1);
      if (profile == null) {
        Logger.warn('refid does not exists, insert operation canceled', {
          plugin: plugin.identifier,
        });
        return null;
      }
    }
    doc = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    throw new Error('refid must be specified for Insert Query');
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    doc = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Insert query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const result = await DB.insertAsync<any>(doc);
  return plugin.core ? result : CleanDoc(result);
}

export async function APIUpdate(plugin: PluginDetect, arg1: string | any, arg2: any, arg3?: any) {
  let query: any = null;
  let update: any = null;
  let signature: any = {};
  if (typeof arg1 == 'string' && typeof arg2 == 'object' && typeof arg3 == 'object') {
    arg2 = CheckQuery(arg2);
    arg3 = CheckQuery(arg3);
    query = arg2;
    update = arg3;
    signature.__s = 'plugins_profile';
    signature.__refid = arg1;
  } else if (arg1 == null && typeof arg2 == 'object' && typeof arg3 == 'object') {
    arg2 = CheckQuery(arg2);
    arg3 = CheckQuery(arg3);
    query = arg2;
    update = arg3;
    signature.__s = 'plugins_profile';
  } else if (typeof arg1 == 'object' && typeof arg2 == 'object') {
    arg1 = CheckQuery(arg1);
    arg2 = CheckQuery(arg2);
    query = arg1;
    update = arg2;
    signature.__s = 'plugins';
  } else {
    throw new Error('invalid Update query');
  }

  query = { ...query, ...signature };

  if (!get(Object.keys(update), '0', '').startsWith('$')) {
    update = {
      ...update,
      ...signature,
    };
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const docs = await DB.updateAsync<any>(query, update, {
    upsert: false,
    multi: true,
    returnUpdatedDocs: true,
  });

  return {
    updated: (docs as any).length,
    docs: isArray(docs)
      ? docs.map(d => (plugin.core ? d : CleanDoc(d)))
      : [plugin.core ? docs : CleanDoc(docs)],
  };
}

export async function APIUpsert(plugin: PluginDetect, arg1: string | any, arg2: any, arg3?: any) {
  let query: any = null;
  let update: any = null;
  let signature: any = {};
  if (typeof arg1 == 'string' && typeof arg2 == 'object' && typeof arg3 == 'object') {
    arg2 = CheckQuery(arg2);
    arg3 = CheckQuery(arg3);
    if (!plugin.core) {
      const profile = await FindProfile(arg1);
      if (profile == null) {
        Logger.warn('refid does not exists, upsert operation canceled', {
          plugin: plugin.identifier,
        });
        return { updated: 0, docs: [], upsert: false };
      }
    }
    query = arg2;
    update = arg3;
    signature.__s = 'plugins_profile';
    signature.__refid = arg1;
  } else if (arg1 == null && typeof arg2 == 'object') {
    throw new Error('refid must be specified for Upsert Query');
  } else if (typeof arg1 == 'object' && typeof arg2 == 'object') {
    arg1 = CheckQuery(arg1);
    arg2 = CheckQuery(arg2);
    query = arg1;
    update = arg2;
    signature.__s = 'plugins';
  } else {
    throw new Error('invalid Upsert query');
  }

  query = { ...query, ...signature };

  if (!get(Object.keys(update), '0', '').startsWith('$')) {
    update = {
      ...update,
      ...signature,
    };
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const docs = await DB.updateAsync<any>(query, update, {
    upsert: true,
    multi: true,
    returnUpdatedDocs: true,
  });

  return {
    updated: (docs as any).length,
    docs: isArray(docs)
      ? docs.map(d => (plugin.core ? d : CleanDoc(d)))
      : [plugin.core ? docs : CleanDoc(docs)],
    upsert: true,
  };
}

export async function APIRemove(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Remove query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  return await DB.removeAsync(query, { multi: true });
}

export async function APICount(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Count query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  return await DB.countAsync(query);
}
