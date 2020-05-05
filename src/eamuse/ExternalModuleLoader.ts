import { EamuseModuleContainer, EamuseModuleRoute } from './EamuseModuleContainer';
import { kitem, karray, kattr } from '../utils/KBinJSON';
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
  getFirst,
  getNumber,
  getNumbers,
  getStr,
} from '../utils/KBinJSON';
import fs from 'fs';
import { Logger } from '../utils/Logger';
import { ARGS } from '../utils/ArgParser';

var localPath = process.cwd();
if ((process as any).pkg) {
  localPath = path.dirname(process.argv0);
}

/* Exposing API */
const $: any = global;
const MODULE_ROUTER = new EamuseModuleContainer();
$.MODULE_PATH = path.join(localPath, 'modules');

const tsconfig = path.join($.MODULE_PATH, 'tsconfig.json');
/* ncc/pkg hack */
// require('typescript');
const ts_node = require('ts-node');
if (fs.existsSync(tsconfig)) {
  /* Inject ts-node */
  ts_node.register({ project: tsconfig });
} else {
  ts_node.register();
}

$.RegisterRoute = (gameCode: string, method: string, handler: EamuseModuleRoute | boolean) => {
  if (gameCode === '*') return;
  MODULE_ROUTER.add(gameCode, method, handler);
};
$.$ = {
  ATTR: getAttr,
  BIGINT: getBigInt,
  BIGINTS: getBigInts,
  BOOL: getBool,
  BUFFER: getBuffer,
  CONTENT: getContent,
  ELEMENT: getElement,
  ELEMENTS: getElements,
  FIRST: getFirst,
  NUMBER: getNumber,
  NUMBERS: getNumbers,
  STR: getStr,
};

$.K = {
  ATTR: kattr,
  ITEM: kitem,
  ARRAY: karray,
};

if (!ARGS.dev) {
  $.console.log = () => {};
  $.console.warn = () => {};
  $.console.error = () => {};
}

export function LoadExternalModules() {
  const loadedModules = [];
  try {
    const modules = fs.readdirSync($.MODULE_PATH);
    for (const mod of modules) {
      const modulePath = path.join(localPath, 'modules', mod);
      const moduleExt = path.extname(modulePath);

      if (
        modulePath.endsWith('.d.ts') ||
        mod == 'node_modules' ||
        (moduleExt !== '' && moduleExt !== '.ts' && moduleExt !== '.js')
      )
        continue;

      try {
        this.instance = require(modulePath);
        if (this.instance && this.instance.default != null) {
          this.instance = this.instance.default;
        }

        this.instance.register();
        loadedModules.push(path.basename(mod));
      } catch (err) {
        Logger.error(`failed to load module "${mod}"`);
        Logger.error(err);
      }
    }
  } catch {
    Logger.warn(`can not find "modules" directory.`);
    Logger.warn(`make sure your modules are installed under: ${path.join(localPath, 'modules')}`);
  }
  return {
    modules: loadedModules,
    router: MODULE_ROUTER,
  };
}
