import { ArgumentParser } from 'argparse';
import { VERSION } from './Consts';
import { GetCallerPlugin, CONFIG_PATH } from './EamuseIO';
import { Logger } from './Logger';
import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from 'ini';

const parser = new ArgumentParser({
  version: VERSION,
  addHelp: true,
  description: 'AsphyxiaCore: A Rhythm Game Helper',
  prog: 'asphyxia_core',
});

parser.addArgument(['-p', '--port'], {
  help: 'Set listening port. (default: 8083)',
  defaultValue: 8083,
  type: 'int',
  metavar: 'PORT',
  dest: 'port',
});

parser.addArgument(['-b', '--bind'], {
  help: 'Hostname binding. In case you need to access it through LAN. (default: "localhost")',
  defaultValue: 'localhost',
  metavar: 'HOST',
  dest: 'bind',
});

// parser.addArgument(['-uip', '--webui-port'], {
//   help: 'Set WebUI port. (default: 8084)',
//   defaultValue: 8084,
//   type: 'int',
//   metavar: 'PORT',
//   dest: 'ui_port',
// });

// parser.addArgument(['-uib', '--webui-bind'], {
//   help: 'WebUI Hostname binding. (default: "localhost")',
//   defaultValue: 'localhost',
//   metavar: 'HOST',
//   dest: 'ui_bind',
// });

parser.addArgument(['-m', '--matching-port'], {
  help: 'Set matching port. (default: 5700)',
  defaultValue: 5700,
  type: 'int',
  dest: 'matching_port',
  metavar: 'PORT',
});

// parser.addArgument(['-s', '--save-path'], {
//   help: 'Set custom savedata directory',
//   dest: 'save_path',
//   metavar: 'PATH',
// });

parser.addArgument(['--console'], {
  help: 'Enable console for plugins.',
  defaultValue: false,
  dest: 'dev',
  action: 'storeTrue',
});

parser.addArgument(['--no-tray'], {
  help: 'Disable system tray icon',
  defaultValue: false,
  dest: 'no-tray',
  action: 'storeTrue',
});

export const ARGS = parser.parseArgs();

export interface CONFIG_OPTIONS {
  name?: string;
  desc?: string;
  type: 'string' | 'integer' | 'float' | 'boolean';
  range?: [number, number];
  validator?: (data: string) => boolean;
  onchange?: (key: string, value: string) => void;
  slider?: boolean;
  options?: string[];
  default: any;
}

let INI: any = null;

const CONFIG_MAP: {
  [key: string]: {
    [key: string]: CONFIG_OPTIONS;
  };
} = {
  core: {
    port: { type: 'integer', range: [0, 65535], default: 8083 },
    bind: { type: 'string', default: 'localhost' },
    matching_port: { type: 'integer', range: [0, 65535], default: 5700 },
    systray: { type: 'boolean', default: false },
    webui_enabled: { name: 'Enable WebUI', type: 'boolean', default: true },
  },
};

export function PluginRegisterConfig(key: string, options: CONFIG_OPTIONS) {
  const plugin = GetCallerPlugin();
  if (!plugin) {
    Logger.error('failed to register config entry: unknown plugin');
    return;
  }

  if (!options) {
    Logger.error(`failed to register config entry ${key}: config options not specified`, {
      plugin: plugin.name,
    });
  }

  if (!options.default) {
    Logger.error(`failed to register config entry ${key}: default value not specified`, {
      plugin: plugin.name,
    });
  }

  if (!options.type) {
    Logger.error(`failed to register config entry ${key}: value type not specified`, {
      plugin: plugin.name,
    });
  }

  if (!CONFIG_MAP[plugin.name]) {
    CONFIG_MAP[plugin.name] = {};
  }

  CONFIG_MAP[plugin.name][key] = options;
}

export function ReadConfig() {
  try {
    const file = readFileSync(CONFIG_PATH, { encoding: 'utf-8' });
    INI = parse(file);
  } catch (err) {
    INI = {};
  }

  for (const mod in CONFIG_MAP) {
    let section = INI;
    if (mod != 'core') {
      if (!INI[mod]) {
        INI[mod] = {};
      }
      section = INI[mod];
    }

    for (const op in CONFIG_MAP[mod]) {
      const option = CONFIG_MAP[mod][op];
      if (!section[op]) {
        section[op] = option.default;
      } else {
        if (option.type == 'boolean') {
          section[op] = section[op].toString() == 'true';
        } else if (option.type == 'integer') {
          section[op] = parseInt(section[op]);
          if (isNaN(section[op])) {
            section[op] = option.default;
          }
        } else if (option.type == 'float') {
          section[op] = parseFloat(section[op]);
          if (isNaN(section[op])) {
            section[op] = option.default;
          }
        } else {
          section[op] = section[op].toString();
        }
      }
    }
  }
}

export function SaveConfig() {
  try {
    writeFileSync(CONFIG_PATH, stringify(INI));
  } catch (err) {
    Logger.error(`failed to write config: ${err}`);
  }
}

export const CONFIG: any = new Proxy(
  {},
  {
    get: (_, prop) => {
      return ARGS.prop || INI[prop];
    },
    set: () => {
      return true;
    },
  }
);
