# Writing Plugins for Asphyxia CORE

A practical, example-driven guide. The official typedoc reference is the exhaustive list of every type; this document is the mental model and recipes you actually need to write a plugin.

---

## 1. What a plugin is

A plugin is a **folder under `plugins/`** whose name contains an `@` (e.g. `sdvx@asphyxia`, `iidx@myname`). It exports a single `register()` function from `index.ts`. CORE auto-discovers and loads it on startup via `src/eamuse/ExternalPluginLoader.ts`.

Inside `register()`, CORE has injected a set of **globals** — you don't import them, they're just available. The two big ones:

- `R` — the registrar. You tell CORE what to do by calling methods on it.
- `DB`, `U`, `K`, `IO`, `$`, `_` — runtime helpers you use from inside handlers.

CORE speaks to the arcade game over HTTP using Konami's binary XML protocol ("KBin"). Your plugin's job is to register **routes** that handle specific `module.method` calls from the game — plus optionally a web UI for administrators.

The two game-facing plugins shipped in this fork are:

- `plugins/sdvx@asphyxia/` — SOUND VOLTEX, full-featured reference
- `plugins/_example@identifier/` — empty placeholder (ignore)

Read `sdvx@asphyxia/index.ts` alongside this guide — everything here is demonstrated there.

---

## 2. Hello-world plugin

Create `plugins/hello@you/index.ts`:

```typescript
export function register() {
  R.Contributor('Your Name');
  R.GameCode('XYZ');

  R.Route('test.ping', (info, data, send) => {
    send.object({
      '@attr': { message: 'pong' },
    });
  });
}
```

Start CORE. The log will show your plugin loaded. That's the entire contract.

Notes:

- Folder names starting with `_`, `.`, or `core` are skipped.
- The text before `@` is the plugin's human name, the text after is your identifier/namespace — together they form the plugin ID used for its database file (`savedata/hello@you.db`) and the URL (`/plugin/hello@you/...`).
- No `package.json` needed per plugin. Plugins share `plugins/package.json` for dependencies.
- You write TypeScript directly; CORE uses ts-node to load plugins.

### Getting type hints

CORE's injected globals (`R`, `DB`, `U`, `K`, …) have a type declaration file tracked at `plugins/asphyxia-core.d.ts`. If it's missing from your checkout (this fork shows it deleted in `git status`), restore it:

```
git checkout HEAD -- plugins/asphyxia-core.d.ts
```

The file declares `R`, `DB`, `U`, `K`, `IO`, `$`, `_`, `CORE_VERSION`, and every type you'll touch. With it in place, your editor will autocomplete everything.

---

## 3. How a game request becomes your handler

Understanding this is 80% of the battle. Open `src/middlewares/EamuseMiddleware.ts` and `src/eamuse/EamuseRouteContainer.ts` to follow along if curious.

1. The cabinet POSTs encrypted + LZ77-compressed KBin XML to CORE.
2. Middleware decrypts, decompresses, parses, and extracts the call: `<call model="KFC:J:A:A:2024...."><game method="sv7_load">...payload...</game></call>`.
3. CORE builds an `info` object: `{ gameCode: 'KFC', module: 'game', method: 'sv7_load', model: '...' }`.
4. CORE looks up a handler registered under that `gameCode` + `module.method` combo. If multiple `method` words exist (e.g. `<cardmng method="inquire">`), they're joined with `.`
5. Your handler runs with `(info, data, send)` and must call a method on `send` exactly once.

### The handler signature

```typescript
R.Route('game.sv7_load', async (info, data, send) => {
  // info.gameCode, info.module, info.method, info.model
  // data  — the parsed inner XML as a plain object (the <game> contents)
  // send  — response helper; you MUST eventually call send.object / send.success / send.deny / send.status
});
```

### Reading incoming data with `$`

The raw `data` object mirrors the XML tree. Use the `$` helper to pull values out with type coercion and defaults — this is what `sdvx@asphyxia/handlers/profiles.ts` does throughout:

```typescript
const refid  = $(data).str('refid');                 // <refid>...</refid>
const score  = $(data).number('sc', 0);              // <sc __type="s32">...</sc>, default 0
const tracks = $(data).elements('track');            // array of <track> children
const attr   = $(data).attr().dataid;                // read XML attributes
```

### Sending a response with `send.object` + `K`

Responses are plain JS objects. Use the `K.*` helpers to annotate values with the typed XML encoding the game expects. From `sdvx@asphyxia/index.ts:126-128`:

```typescript
send.object({
  nxt_time: K.ITEM('u32', 1000 * 5 * 60),  // <nxt_time __type="u32">300000</nxt_time>
});
```

Cheat sheet:

| Helper | What it produces |
|---|---|
| `K.ITEM('s32', 42)` | `<x __type="s32">42</x>` — typed scalar |
| `K.ITEM('str', 'hi')` | string leaf (default when you just use a string) |
| `K.ARRAY('u32', [1,2,3])` | typed array |
| `K.ATTR({a: '1'}, { inner: 'x' })` | `<x a="1"><inner>x</inner></x>` — attributes + children |

Numeric types: `s8`, `u8`, `s16`, `u16`, `s32`, `u32`, `s64`, `u64`, `float`, `double`, `bool`, `time`, `ip4`. Group types like `3s32`, `4f`, `vb` also exist — see `asphyxia-core.d.ts` for the full list.

### Other send methods

- `send.success()` — status 0, empty body
- `send.deny()` — status 1
- `send.status(code)` — arbitrary status (e.g. `112` from `cardmng.inquire`)
- `send.xml('template', data)` / `send.pug('template', data)` — render an EJS/Pug template
- `send.xmlFile(path)` / `send.pugFile(path)` — render a file from the plugin folder
- You can also pass `{status, encoding, rootName, compress, kencode, encrypt}` as a second arg

### The `MultiRoute` pattern

Games ship multiple protocol versions (SDVX Exceed Gear is `sv6`, ∇ is `sv7`). Rather than registering twice by hand, define a helper:

```typescript
const MultiRoute = (method: string, handler: any) => {
  R.Route(`game.sv6_${method}`, handler);
  R.Route(`game.sv7_${method}`, handler);
};
MultiRoute('common', common);
MultiRoute('load', load);
```

### The `R.Unhandled` fallback

```typescript
R.Unhandled(undefined);   // silently accept anything you didn't register
```

Without this, unregistered routes return an error to the game. Most plugins set `R.Unhandled(undefined)` at the end of `register()` so unrecognized calls are harmless no-ops.

---

## 4. Persistence — the `DB` API

CORE wraps [NeDB](https://github.com/seald/nedb) with a thin per-plugin split:

- **Plugin space** — per-plugin data, no user attached (e.g. "list of curated charts").
- **Profile space** — per-user data, keyed by the user's `refid` (e.g. "this user's highscores").

The form of the query chooses the space:

```typescript
// PLUGIN SPACE
await DB.Insert({ collection: 'custom_charts', title: 'Hello', mid: 1234 });
await DB.Find({ collection: 'custom_charts' });
await DB.FindOne({ collection: 'custom_charts', mid: 1234 });
await DB.Update({ collection: 'custom_charts', mid: 1234 }, { $set: { title: 'New' } });
await DB.Remove({ collection: 'custom_charts', mid: 1234 });
await DB.Count({ collection: 'custom_charts' });

// PROFILE SPACE — first arg is the refid
await DB.Insert(refid, { collection: 'music', mid: 1234, score: 9_500_000 });
await DB.Find(refid, { collection: 'music' });
await DB.FindOne(refid, { collection: 'music', mid: 1234 });
await DB.Upsert(refid, { collection: 'music', mid: 1234 }, { $set: { score: 10_000_000 } });

// PROFILE SPACE across all users (admin-ish queries) — pass null
await DB.Find(null, { collection: 'music', mid: 1234 });
```

Rules and gotchas:

- **Pick a `collection` name** and always include it in queries. It's purely a convention — NeDB just stores whatever fields you give it — but every collection sharing the DB file is filtered by this string. (The code base uses `collection`; `sdvx@asphyxia`'s models like `music_record.ts`, `nautica_song.ts` show the discriminator pattern.)
- **Never use `__`-prefixed field names.** They're reserved by CORE (`__s`, `__refid`). Queries or docs with underscored fields will throw.
- **Update uses MongoDB-style operators**: `$set`, `$inc`, `$push`, `$addToSet`, `$pull`, `$unset`. No operator → direct replacement (rarely what you want).
- **Models for type safety.** Declare an interface with the `collection` literal baked in, then pass it as a generic — see `plugins/sdvx@asphyxia/models/`:

```typescript
export interface CustomChart {
  collection: 'custom_charts';
  mid: number;
  title: string;
  artist: string;
}

const song = await DB.FindOne<CustomChart>({ collection: 'custom_charts', mid: 1234 });
```

---

## 5. Config options

Register with `R.Config(key, options)` inside `register()`:

```typescript
R.Config('my_api_url', {
  type: 'string',
  default: 'https://example.com',
  name: 'My API URL',
  desc: 'Where to POST scores',
  needRestart: false,
});

R.Config('max_items', {
  type: 'integer',
  default: 100,
  range: [1, 1000],
  name: 'Max items per page',
});

R.Config('mode', {
  type: 'string',
  options: ['production', 'staging'],
  default: 'production',
  name: 'Mode',
});
```

Config option fields:

| Field | Type | Notes |
|---|---|---|
| `type` | `'string' \| 'integer' \| 'float' \| 'boolean'` | required |
| `default` | any | required |
| `name` | string | display label in admin UI (defaults to key) |
| `desc` | string | description shown in admin UI |
| `options` | `string[]` | turns the input into a dropdown (string only) |
| `range` | `[min, max]` | numeric types only |
| `validator` | `(value) => true \| string` | return `true` to accept, a string to reject with message |
| `needRestart` | boolean | shows a "restart required" indicator |

Read the value at runtime:

```typescript
const url = U.GetConfig('my_api_url');
```

Config storage lives in `config.ini` at the repo root and is editable from the admin web UI.

---

## 6. The admin web UI

### Pages

Drop `.pug` files under `plugins/<id>/webui/`. They're rendered by CORE at `/plugin/<id>/<file>` and auto-appear in the plugin's sidebar.

- `webui/home.pug` → sidebar entry "Home"
- `webui/settings.pug` → sidebar entry "Settings"
- `webui/profile_stats.pug` → per-user profile tab (requires a selected refid)
- Files starting with `_` are partials/ignored
- Special reserved names: `profiles.pug`, `profile.pug`, `static.pug`

### Data fetched at render time

Pug templates can embed a data block that runs server-side before render. The expressions have `DB`, `U`, `$`, `_` available and receive the current `refid` for profile pages:

```pug
//DATA//
  profile: DB.FindOne(refid, { collection: 'profile' })
  scores: DB.Find(refid, { collection: 'music' })

h1 Hi #{profile.name}
table
  each score in scores
    tr
      td= score.mid
      td= score.score
```

### Server-side RPCs: `R.WebUIEvent`

For interactive actions (admin buttons, AJAX), register events that the browser calls over HTTP:

```typescript
// plugin code
R.WebUIEvent('getStats', async (data, send) => {
  const count = await DB.Count({ collection: 'custom_charts' });
  send.json({ success: true, count });
});

R.WebUIEvent('deleteChart', async (data, send) => {
  // data.__username and data.__isAdmin are injected by the auth middleware
  if (!data.__isAdmin) { send.json({ error: 'Admin only' }); return; }
  await DB.Remove({ collection: 'custom_charts', mid: data.mid });
  send.json({ success: true });
});
```

`send` for WebUI events has `.json(obj)`, `.text(str)`, `.buffer(buf)`, `.file(path)`, `.redirect(url)`, `.error(code, msg)`.

Calling from the browser (inside a `.pug` file's inline script):

```javascript
emit('getStats', {}).then(function(response) {
  console.log(response.data.count);
});

emit('deleteChart', { mid: 1234 }).then(function(response) {
  if (response.data.error) alert(response.data.error);
});
```

`emit` is a helper CORE injects into the WebUI runtime — it POSTs to `/emit/<eventName>`.

### Restricting events to admins

Non-admin requests reach your handler by default. To lock an event to admins, either:

1. Check `data.__isAdmin` at the top of the handler and return an error early (this is what new events in this fork do), **or**
2. Add the event name to the `ADMIN_ONLY_EVENTS` list in `src/webui/emit.ts` — requests from non-admins then get a `403` before your handler runs.

Use (2) for anything that mutates data you don't want regular users touching.

### File uploads

Declare expected data files with `R.DataFile(path, { name, desc, accept?, required? })`. The admin UI will then show an upload slot that writes to that path inside your plugin folder.

---

## 7. Other `R.*` you'll see

| Call | Purpose |
|---|---|
| `R.Contributor(name, link?)` | Credited in the plugin about page |
| `R.GameCode(code)` | Associate your plugin with a cabinet game code (e.g. `'KFC'` for SDVX) — used to route calls and by `ROOT_CONTAINER.getPluginByCode` |
| `R.Route(method, handler)` | Register an eamuse route. `handler === true` means "always reply success" |
| `R.Unhandled(handler)` | Fallback for unregistered methods. Pass `undefined` to silently accept |
| `R.Config(key, opts)` | Register a config option |
| `R.DataFile(path, opts)` | Register a data file the admin can upload |
| `R.WebUIEvent(name, fn)` | Register an AJAX endpoint for the admin UI |
| `R.ExtraModuleHandler(fn)` | Low-level: handle non-standard protocol modules |

---

## 8. Utility helpers (`U`, `IO`, `_`)

`U` — small utility grab-bag:

- `U.GetConfig(key)` — read a config value (plugin-scoped)
- `U.toXML(obj)` / `U.parseXML(xml, simplify?)` — manual XML conversion
- `U.NFC2Card(nfc)` / `U.Card2NFC(card)` — card number format conversion
- `U.EncodeString(str, encoding)` / `U.DecodeString(buf, encoding)` — `shift_jis`, `utf8`, `euc-jp`, `ascii`, `iso-8859-1`

`IO` — plugin-scoped filesystem (paths are relative to `plugins/<your-id>/`):

- `IO.Resolve(path)` — absolute path to a plugin-relative file
- `IO.ReadFile(path, options?)` / `IO.WriteFile(path, data, options?)`
- `IO.ReadDir(path)` / `IO.Exists(path)`

`_` — [lodash](https://lodash.com/docs/), globally available.

---

## 9. Common recipes

### Handle a game "load" call and return highscores

```typescript
R.Route('game.sv7_load_m', async (info, data, send) => {
  const refid = $(data).str('refid');
  const scores = await DB.Find(refid, { collection: 'music' });

  send.object({
    music: scores.map(s => ({
      '@attr': { music_id: s.mid },
      score: K.ITEM('u32', s.score),
      clear: K.ITEM('u8', s.clear),
    })),
  });
});
```

### Persist a save

```typescript
R.Route('game.sv7_save_m', async (info, data, send) => {
  const refid = $(data).str('refid');
  for (const track of $(data).elements('track')) {
    await DB.Upsert(
      refid,
      { collection: 'music', mid: $(track).number('mid') },
      { $max: { score: $(track).number('sc', 0) } }  // keep highest score
    );
  }
  send.success();
});
```

### An admin-only JSON endpoint

```typescript
R.WebUIEvent('purgeStats', async (data, send) => {
  if (!data.__isAdmin) { send.json({ error: 'Admin only' }); return; }
  const { updated } = await DB.Remove({ collection: 'stats' }) as any;
  send.json({ success: true, removed: updated });
});
```

Remember to also add `'purgeStats'` to `ADMIN_ONLY_EVENTS` in `src/webui/emit.ts` if you want belt-and-suspenders admin enforcement.

### Call an external HTTP API from a handler

Nothing plugin-specific here — plugins are just Node. Use the built-in `https` module or install `node-fetch` in `plugins/package.json`. See `plugins/sdvx@asphyxia/handlers/nautica.ts` for a working example using `https.get`.

---

## 10. Debugging checklist

When your plugin isn't doing what you expect:

1. **Did CORE actually load it?** Run with `npm run dev`; the startup log prints each plugin identifier. No mention = folder name issue (missing `@`, starts with `_`, etc.).
2. **Is your route being hit?** CORE debug-logs the incoming `module.method` + full XML when not running from a packaged binary. Add the route name to `src/middlewares/EamuseMiddleware.ts:141` logic if needed.
3. **Is `send` being called exactly once?** Forgetting to call send hangs the request; calling it twice throws.
4. **Is your XML shape right?** Compare against what a real server sends. The `sdvx@asphyxia` plugin is the richest reference for typed response structures.
5. **Check the traffic summary.** Every 5 minutes CORE logs top endpoints by total time (see `src/middlewares/EamuseMiddleware.ts`). If your route never appears there, it's never being called.
6. **Cache on reads.** The injected `DB` is already lightly cached for core lookups (see `src/utils/EamuseIO.ts`). If you need your own cache, a module-level `Map` with TTL is enough — see the pattern in `EamuseIO.ts`.

---

## 11. Further reading inside the repo

| File | Why |
|---|---|
| `plugins/sdvx@asphyxia/index.ts` | Canonical example of `register()` |
| `plugins/sdvx@asphyxia/handlers/*.ts` | Full spectrum of route handlers |
| `plugins/sdvx@asphyxia/models/*.ts` | Typed `collection` model pattern |
| `plugins/sdvx@asphyxia/webui/*.pug` | WebUI page examples |
| `plugins/asphyxia-core.d.ts` | Full type declarations for all globals |
| `src/eamuse/ExternalPluginLoader.ts` | How globals (`R`, `DB`, `U`, etc.) get injected |
| `src/middlewares/EamuseMiddleware.ts` | Request pipeline + per-request timing |
| `src/utils/EamuseIO.ts` | `DB.*` implementation |
| `src/eamuse/EamuseSend.ts` | `send.*` implementation |
