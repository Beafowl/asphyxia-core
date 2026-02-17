# Asphyxia Core (Fork)

A fork of [asphyxia-core](https://github.com/asphyxia-core/core) with additional features.

This repository also includes a modified version of the [SDVX plugin](https://github.com/22vv0/asphyxia_plugins) by 22vv0 (itself a fork of the [official Asphyxia plugins](https://github.com/asphyxia-core/plugins)). The plugin lives in `plugins/sdvx@asphyxia` and has been modified alongside the core — the changes listed under "SDVX Plugin" below are specific to this fork.

## Credits

- **[Team Asphyxia](https://github.com/asphyxia-core)** - Original Asphyxia Core and plugins
- **[22vv0](https://github.com/22vv0/asphyxia_plugins)** - Forked SDVX plugin (with LatoWolf)

## Setup

### 1. Configure `config.ini`

Edit `config.ini` in the root directory to match your environment:

```ini
port=8083
bind=localhost
ping_ip=127.0.0.1
matching_port=5700
allow_register=true
maintenance_mode=false
enable_paseli=true
webui_on_startup=true
server_name=Asphyxia Core
server_tag=CORE
```

| Option | Description |
|---|---|
| `port` | Port the server listens on |
| `bind` | Address to bind to (`localhost` for local only, `0.0.0.0` for all interfaces) |
| `ping_ip` | IP address returned to clients for ping |
| `matching_port` | Port used for matching |
| `allow_register` | Allow new user registration (`true`/`false`) |
| `maintenance_mode` | Enable maintenance mode (`true`/`false`) |
| `enable_paseli` | Enable PASELI support (`true`/`false`) |
| `webui_on_startup` | Open the WebUI in browser on startup (`true`/`false`) |
| `server_name` | Display name of the server |
| `server_tag` | Client tag shown in-game |

### 2. Change the default admin password

On first launch, a default admin account is created with the credentials:

- **Username:** `admin`
- **Password:** `admin`

Log in to the WebUI and change the admin password immediately. If your server is exposed to a network, leaving the default credentials is a security risk.

## Changes from upstream

### Core
- User authentication system (signup, login, account management)
- Admin role with user management
- Access control (profile ownership, admin-only pages)
- Server name and client tag configurable via `config.ini`

### SDVX Plugin - Tachi Integration
- OAuth flow for [Kamaitachi](https://kamai.tachi.ac) score sync
- Bidirectional score import/export with Tachi API
- Automatic score export to Tachi on each play (opt-in toggle)
- Best 50 PB comparison (Asphyxia vs Tachi)
- Arcade-size controller warning on Tachi tab

### SDVX Plugin - Score Management
- Database migration tool to import scores from another Asphyxia server
- Nabla volforce recalculation tool
- Version-aware clear ranking (EG v6 / Nabla v7 MXV ordering)

### WebUI
- Removed shutdown/process controls from navbar
- Hidden data delete buttons for non-admin users
