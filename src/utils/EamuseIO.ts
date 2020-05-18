import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { Logger } from './Logger';
import path from 'path';
import nedb from 'nedb';

const pkg: boolean = (process as any).pkg;
export const EXEC_PATH = pkg ? path.dirname(process.argv0) : process.cwd();
export const PLUGIN_PATH = path.join(EXEC_PATH, 'plugins');
export const SAVE_PATH = path.join(EXEC_PATH, 'savedata');
export const ASSETS_PATH = path.join(pkg ? __dirname : `../build-env`, 'assets');
export const CONFIG_PATH = path.join(EXEC_PATH, 'config.ini');

export const DB = new nedb({ filename: path.join(SAVE_PATH, 'core.db'), autoload: true });

export function GetCallerPlugin(): { name: string; single: boolean } {
  const oldPrepareStackTrace = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  const stack = new Error().stack as any;
  Error.prepareStackTrace = oldPrepareStackTrace;
  if (stack !== null && typeof stack === 'object') {
    let inPlugin = false;
    let entryFile = null;
    for (const file of stack) {
      const filename: string = file.getFileName();
      if (filename.startsWith(PLUGIN_PATH)) {
        entryFile = path.relative(PLUGIN_PATH, filename);
        inPlugin = true;
      } else {
        if (inPlugin) {
          break;
        }
      }
    }

    if (entryFile !== null) {
      const plugin = entryFile.split(path.sep)[0];
      if (plugin.endsWith('.js') || plugin.endsWith('.ts')) {
        return { name: plugin.substr(0, plugin.length - 3), single: true };
      } else {
        return { name: plugin, single: false };
      }
    } else {
      return null;
    }
  }
  return null;
}

export function PrepareDirectory(dir: string = ''): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return dir;
}

export function WriteFile(file: string, data: string) {
  const plugin = GetCallerPlugin();
  if (!plugin) return;

  let target = file;
  if (!path.isAbsolute(file)) {
    target = path.resolve(PLUGIN_PATH, plugin.name, file);
  }

  try {
    PrepareDirectory(path.dirname(target));
    writeFileSync(target, data);
  } catch (err) {
    Logger.error(`file writing failed: ${err}`, { plugin: plugin.name });
  }
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
