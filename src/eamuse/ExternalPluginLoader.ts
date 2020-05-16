import { EamusePluginContainer, EamusePluginRoute } from './EamusePluginContainer';
import { kitem, karray, kattr, dataToXML } from '../utils/KBinJSON';
import path from 'path';
import {
  getAttr,
  getBigInt,
  getBigInts,
  getBool,
  getBuffer,
  getContent,
  getElement,
  getElements,
  getNumber,
  getNumbers,
  getStr,
} from '../utils/KBinJSON';
import { Logger } from '../utils/Logger';
import { KDataReader } from '../utils/KDataReader';
import { PLUGIN_PATH, WriteFile, GetCallerPlugin } from '../utils/EamuseIO';
import { readdirSync, existsSync } from 'fs';
import { AddProfileCheck } from './Core/CardManager';
import { ARGS } from '../utils/ArgConfig';

/* Exposing API */
const $: any = global;
const PLUGIN_ROUTER = new EamusePluginContainer();

const tsconfig = path.join(PLUGIN_PATH, 'tsconfig.json');
/* ncc/pkg hack */
// require('typescript');
const ts_node = require('ts-node');
if (existsSync(tsconfig)) {
  /* Inject ts-node */
  ts_node.register({ project: tsconfig });
} else {
  ts_node.register();
}

$.R = {
  Route: (gameCode: string, method: string, handler: EamusePluginRoute | boolean) => {
    if (gameCode === '*') return;
    PLUGIN_ROUTER.add(gameCode, method, handler);
  },
  Unhandled: (gameCode: string, handler?: EamusePluginRoute) => {
    if (gameCode === '*') return;
    PLUGIN_ROUTER.unhandled(gameCode, handler);
  },
  ProfileCheck: (gameCode: string, handler: () => boolean) => {
    if (gameCode === '*') return;
    AddProfileCheck(gameCode, handler);
  },
};
$.$ = (data: any) => {
  return new KDataReader(data);
};
$.$.ATTR = getAttr;
$.$.BIGINT = getBigInt;
$.$.BIGINTS = getBigInts;
$.$.BOOL = getBool;
$.$.BUFFER = getBuffer;
$.$.CONTENT = getContent;
$.$.ELEMENT = getElement;
$.$.ELEMENTS = getElements;
$.$.NUMBER = getNumber;
$.$.NUMBERS = getNumbers;
$.$.STR = getStr;

$.K = {
  ATTR: kattr,
  ITEM: kitem,
  ARRAY: karray,
};

$.DB = {};

$.U = {
  toXML: dataToXML,
  WriteFile,
};

if (!ARGS.dev) {
  $.console.log = () => {};
  $.console.warn = () => {};
  $.console.error = () => {};
  $.console.debug = () => {};
  $.console.info = () => {};
} else {
  $.console.log = (...msgs: any[]) => {
    const plugin = GetCallerPlugin();
    if (plugin) {
      Logger.info(msgs.join(' '), { plugin: plugin.name });
    } else {
      Logger.info(msgs.join(' '));
    }
  };
  $.console.debug = $.console.log;
  $.console.info = $.console.log;
  $.console.warn = (...msgs: any[]) => {
    const plugin = GetCallerPlugin();
    if (plugin) {
      Logger.warn(msgs.join(' '), { plugin: plugin.name });
    } else {
      Logger.warn(msgs.join(' '));
    }
  };
  $.console.error = (...msgs: any[]) => {
    const plugin = GetCallerPlugin();
    if (plugin) {
      Logger.error(msgs.join(' '), { plugin: plugin.name });
    } else {
      Logger.error(msgs.join(' '));
    }
  };
}

export function LoadExternalPlugins() {
  const loadedPlugins = [];
  try {
    const plugins = readdirSync(PLUGIN_PATH);
    for (const mod of plugins) {
      const name = path.basename(mod);
      const pluginPath = path.resolve(PLUGIN_PATH, mod);
      const pluginExt = path.extname(pluginPath);

      if (
        pluginPath.endsWith('.d.ts') ||
        mod.startsWith('_') ||
        mod.startsWith('core') ||
        mod == 'node_modules' ||
        (pluginExt !== '' && pluginExt !== '.ts' && pluginExt !== '.js')
      )
        continue;

      try {
        let instance = require(pluginPath);
        if (instance && instance.default != null) {
          instance = instance.default;
        }

        loadedPlugins.push({ name, instance });
      } catch (err) {
        Logger.error(`failed to load`, { plugin: name });
        Logger.error(err);
      }
    }

    for (const loaded of loadedPlugins) {
      try {
        loaded.instance.register();
      } catch (err) {
        Logger.error(`${err}`, { plugin: loaded.name });
      }
    }
  } catch (err) {
    Logger.warn(`can not find "plugins" directory.`);
    Logger.warn(`make sure your plugins are installed under: ${PLUGIN_PATH}`);
  }

  /* Disable route registering after external module has been loaded */
  for (const prop in $.R) {
    $.R[prop] = () => {};
  }

  return {
    plugins: loadedPlugins,
    router: PLUGIN_ROUTER,
  };
}
