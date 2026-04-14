## Fork

### Core - Nautica Custom Charts System
- **CORE**: Added Nautica (ksm.dev) integration for browsing and importing custom KSM charts
- **CORE**: Added VoxCharger `--full-import` and `--bulk-import` CLI modes for complete chart conversion (KSH → game-ready files)
- **CORE**: Added custom chart download endpoints (`/api/nautica/download-all`, `/api/nautica/download/:musicId`)
- **CORE**: Added pre-launch sync script endpoint (`/api/nautica/sync-script`) with auto-filled server URL
- **CORE**: Added chart version endpoint (`/api/nautica/version`) for sync script change detection
- **CORE**: Added VoxCharger download endpoint (`/api/nautica/voxcharger`)
- **CORE**: Added chart nomination system — users can nominate Nautica charts for admin review
- **CORE**: Added playtesting pipeline with voting and feedback (thumbs up/down + comments)
- **CORE**: Added staging server mode (`sdvx_nomination_mode` config) for auto-converting charts in testing
- **CORE**: Custom songs (ID 2800+) are now included in the game's `music_limited` song list with unlocked status
- **CORE**: Added sync bundle endpoint (`/api/nautica/sync-bundle`) — single ZIP with sync script + launcher
- **CORE**: Download-all endpoint returns 404 when no custom charts exist
- **CORE**: Added "How to Play Custom Charts" setup guide page
- **CORE**: Discovered game music ID limit: IDs >= 3072 crash soundvoltex.dll (internal array overflow)

### Core - Security Hardening
- **CORE**: Fixed XSS vulnerability in Tachi and Flower OAuth callback endpoints
- **CORE**: Session secret is now randomly generated on first run and persisted (replaced hardcoded secret)
- **CORE**: Added `httpOnly` flag and fixed `sameSite` on session cookies
- **CORE**: Added login rate limiting (10 attempts per 15 minutes per IP)
- **CORE**: Admin-only WebUI events are now enforced server-side in the emit handler
- **CORE**: Nautica download URL validation restricts to ksm.dev CDN only (SSRF prevention)
- **CORE**: Authenticated username is now injected server-side (`__username`) to prevent identity spoofing
- **CORE**: OAuth callbacks now use `window.location.origin` instead of wildcard `*` for postMessage
- **CORE**: Error handler no longer leaks stack traces to the client

### Core - Flower Import Fixes
- **CORE**: Fixed Flower import creating score=0 entries for "PLAYED" placeholder scores
- **CORE**: Fixed Flower API field mapping (`best_score`, `best_clear_type`, `best_score_timestamp`)
- **CORE**: Added `best_score_timestamp` passthrough for proper score timestamps in `/api/flower/sync`

### Core - UI Improvements
- **CORE**: Separated inline styles and scripts from all pug templates into external CSS/JS files
- **CORE**: Added `custom charts admin` page to the admin-only pages list
- **CORE**: Fixed spacing between API token status text and buttons on account page
- **CORE**: Fixed "FREE" text missing whitespace on dashboard information card

### Core - Authentication & Access Control
- **CORE**: Added user authentication system (signup, login, account management)
- **CORE**: Added admin role with user management capabilities
- **CORE**: Added access control for profile ownership and admin-only pages
- **CORE**: Restricted Data Management page to admin users only
- **WebUI**: Hidden data delete buttons for non-admin users
- **WebUI**: Removed Process dropdown and Shutdown button from navbar
- **WebUI**: Added card number help page for signup

### Core - Configuration
- **CORE**: Server name and client tag are now configurable via `config.ini`
- **CORE**: Fixed config loading order to prevent null error on startup

### Core - Backup
- **CORE**: Added savedata backup button to the server dashboard (admin only)

### Core - SDVX Plugin Support
- **CORE**: Added Tachi OAuth client ID and secret to `config.ini` (for SDVX plugin Tachi integration)
- **CORE**: Added Nabla volforce recalculation endpoint
- **CORE**: Added Tachi export timestamp tracking and v7 score export support
- **CORE**: Fixed clear comparison to use proper Exceed Gear ranking order (MXV < UC < PUC)
- **CORE**: Hidden admin-only plugin pages, restricted Tachi tab to profile owner, added Tachi token validation

## v1.60a
- **CORE**: Core is now open-source.
- **CORE**: Removed 16 profile count limit.

## v1.50e
- **CORE**: Change country code from `AX` to `JP` in `facility.get`

## v1.50d
- **CORE**: Fix a problem where `kencode` would crash if any array is empty

## v1.50c

- **CORE**: Fix a problem where undefined database is being loaded when using the Query Shell under `--dev` mode

## v1.50b

- **CORE**: Swapped the `nedb` dependency to `@seald-io/nedb`

## v1.50a

- **API**: Extended `R.WebUIEvent` to allow the handler to respond with data
- **WebUI**: `emit()` function now returns an axios promise, in which you can grab the response data

## v1.40d

- **API**: Added `R.ExtraModuleHandler` to allow plugins to define extra modules
- **Misc**: Fixed a problem where binary data was accidentally treated as card number

## v1.31d

- **CORE**: Fixed a issue where plugins have problem updating migrated data
- **CORE**: Added a configurable ICMP IP target for keepalive
- **CORE**: Fixed a problem where the nfcid checker is detecting non nfcids
- **CORE**: Now, nfcid checker will provide both refid and cardid to plugins
- **CORE**: Fixed a problem where the xml parser fails on empty attributes
- **API**: Added `U.EncodeString` and `U.DecodeString`

## v1.30f

- **WebUI**: Fixed a problem where sometime the database is shown twice
- **CORE**: Fixed an issue where the command line options are ignored
- **PluginLoader**: Fixed an error during card-in if the current gamecode is not registered by any plugins
- **Misc**: Upgrade TypeScript to 4.2.3
- **Misc**: Plugins are now targeting es2017 to make sure TypeScript correctly transpile newer ES features for NodeJS 10 and 12
- **PluginLoader**: Migrate to new database files, now each database has it's own db file. Please backup your old `savedata.db`
- **WebUI**: Emit handlers now take body size up to 50M

## v1.20f

- **Misc**: Auto startup now respects bind address and supports IPv6 better
- **Misc**: Fixed an issue where submitting config change sometimes leads to bad request error
- **CORE**: `kencode` parser now tries to print the path of failure
- **WebUI**: Fixed a problem that `POST /emit/<event_name>` fails
- **API**: Added `IO.Exists` for checking whether a file exists
- **API**: Added `U.NFC2Card` and `U.Card2NFC` for card number conversion
- **WebUI**: Removed "Game Support" section in plugins' overview if no game support is registered
- **WebUI**: Minor WebUI visual update

## v1.19

- **WebUI**: Query shell is now available for all installed plugins even if there are no DB data of them
- **WebUI**: Fixed a issue where the WebUI of plugins with uppercase letter cannot be accessed
- **WebUI**: Custom WebUI pages now works without `//DATA//` section.
- **API**: Fixed a typechecking issue where `{ exists: true }` query is only allowed on number/string fields
- **API**: Provided API `R.DataFile` to allow users to upload their data to the plugins folder
- **API**: `DB.Upsert` now rejects null as refid
- **API**: Added `CORE_VERSION`, `CORE_VERSION_MAJOR` and `CORE_VERSION_MINOR` constants

## v1.18

- **CORE**: Fixed an access issue when binding 0.0.0.0

## v1.17 release candidate

- **WebUI**: URL queries is now exposed as `query` for custom WebUI pug files
- **WebUI**: `emit` function is now available directly in pug files

## v1.16 beta

- **WebUI**: Improved experience on mobile
- **PluginLoader**: Fixed a problem where plugin API fails if CORE is launched in shell
- **PluginLoader**: Fixed a problem where API wrapped in node built-in functions may fail
- **API**: Now `$()` rejects non-plain objects as data
- **API**: `$.ELEMENTS` and `$().elements` now always return valid arrays
- **API**: DB queries now ignore `__refid` fields instead of throwing errors
- **API**: The default handler of `R.Unhandled()` now correctly log plugins' identifiers
- **API**: `K.ITEM()`, `K.ARRAY()` and `K.ATTR()` now have proper typings for TypeScript

## v1.15 beta

- **API**: Lodash (`_`) is now exposed as API.
- **WebUI**: Added a query shell for plugins. You need to enable developer mode to use it
- **WebUI**: Added a dark mode which follows system's color preference

## v1.14 beta

- **WebUI**: Deleting any data now requires an additional step to prevent accidental deletion
- **WebUI**: You can now delete plugins' data in the "Data Management" page

## v1.13 beta

- **PluginLoader**: Now a gamecode can not be registered by multiple plugins
- **Router**: Errors in plugins now print stack
- **Typescript**: Updated to 3.9.3
- **Typescript**: Typescript will now skip type checking if CORE is not in Developer Mode
- **CORE**: Fixed a problem where kencoded-message parsing fails if the message contains arrays

## v1.12 beta

- **Router**: Errors in plugins are now properly reported
- **PluginLoader**: Fixed pug doctype
- **CORE**: CardManager now uses plugins' profile data to determine binded attribute
- **WebUI**: Edit buttons in plugin's profiles page will not appear if no custom profile pages exist

## v1.10 beta

- First WebUI public beta
