import { EamuseModuleContainer, EamuseModuleRoute } from './EamuseModuleContainer';
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
import { ARGS } from '../utils/ArgParser';
import { KDataReader } from '../utils/KDataReader';
import { ReadSave, MODULE_PATH, WriteSave, WriteFile, GetCallerModule } from '../utils/EamuseIO';
import { readdirSync, existsSync } from 'fs';
import { AddProfileCheck } from './Core/CardManager';

/* Exposing API */
const $: any = global;
const MODULE_ROUTER = new EamuseModuleContainer();

const tsconfig = path.join(MODULE_PATH, 'tsconfig.json');
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
  Route: (gameCode: string, method: string, handler: EamuseModuleRoute | boolean) => {
    if (gameCode === '*') return;
    MODULE_ROUTER.add(gameCode, method, handler);
  },
  Unhandled: (gameCode: string, handler?: EamuseModuleRoute) => {
    if (gameCode === '*') return;
    MODULE_ROUTER.unhandled(gameCode, handler);
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
$.$.toXML = dataToXML;

$.K = {
  ATTR: kattr,
  ITEM: kitem,
  ARRAY: karray,
};

$.IO = {
  ReadSave,
  WriteSave,
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
    const mod = GetCallerModule();
    if (mod) {
      Logger.info(msgs.join(' '), { module: mod.name });
    } else {
      Logger.info(msgs.join(' '));
    }
  };
  $.console.debug = $.console.log;
  $.console.info = $.console.log;
  $.console.warn = (...msgs: any[]) => {
    const mod = GetCallerModule();
    if (mod) {
      Logger.warn(msgs.join(' '), { module: mod.name });
    } else {
      Logger.warn(msgs.join(' '));
    }
  };
  $.console.error = (...msgs: any[]) => {
    const mod = GetCallerModule();
    if (mod) {
      Logger.error(msgs.join(' '), { module: mod.name });
    } else {
      Logger.error(msgs.join(' '));
    }
  };
}

export function LoadExternalModules() {
  const loadedModules = [];
  try {
    const modules = readdirSync(MODULE_PATH);
    for (const mod of modules) {
      const modulePath = path.resolve(MODULE_PATH, mod);
      const moduleExt = path.extname(modulePath);

      if (
        modulePath.endsWith('.d.ts') ||
        mod.startsWith('_') ||
        mod.startsWith('core') ||
        mod == 'node_modules' ||
        (moduleExt !== '' && moduleExt !== '.ts' && moduleExt !== '.js')
      )
        continue;

      try {
        let instance = require(modulePath);
        if (instance && instance.default != null) {
          instance = instance.default;
        }

        loadedModules.push({ name: path.basename(mod), instance });
      } catch (err) {
        Logger.error(`failed to load`, { module: mod });
        Logger.error(err);
      }
    }

    for (const loaded of loadedModules) {
      try {
        loaded.instance.register();
      } catch (err) {
        Logger.error(`${err}`, { module: loaded.name });
      }
    }
  } catch (err) {
    Logger.warn(`can not find "modules" directory.`);
    Logger.warn(`make sure your modules are installed under: ${MODULE_PATH}`);
  }

  /* Disable route registering after external module has been loaded */
  for (const prop in $.R) {
    $.R[prop] = () => {};
  }

  return {
    modules: loadedModules,
    router: MODULE_ROUTER,
  };
}
