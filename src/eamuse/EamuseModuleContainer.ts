import { isNil } from 'lodash';

import { EamuseInfo } from '../middlewares/EamuseMiddleware';
import { GetCallerModule } from '../utils/EamuseIO';
import { Logger } from '../utils/Logger';
import { EamuseSend } from './EamuseSend';

export type EamuseModuleRoute = (info: EamuseInfo, data: any, send: EamuseSend) => Promise<any>;

export class EamuseModuleContainer {
  private modules: {
    [key: string]: boolean | EamuseModuleRoute;
  };

  private fallback: {
    [key: string]: EamuseModuleRoute;
  };

  private children: EamuseModuleContainer[];

  constructor() {
    this.modules = {};
    this.fallback = {};
    this.children = [];
  }

  public add(gameCode: string, method: string): void;
  public add(gameCode: string, method: string, handler: EamuseModuleRoute | boolean): void;
  public add(gameCode: EamuseModuleContainer): void;
  public add(
    gameCode: string | EamuseModuleContainer,
    method?: string,
    handler?: EamuseModuleRoute | boolean
  ): void {
    if (typeof gameCode === 'string' && method !== null && typeof method === 'string') {
      let key = `${gameCode}:${method}`;
      if (gameCode === '*') {
        key = `${method}`;
      }
      if (handler) {
        this.modules[key] = handler;
      } else {
        this.modules[key] = false;
      }
    }

    if (gameCode instanceof EamuseModuleContainer) {
      this.children.push(gameCode);
    }
  }

  public unhandled(gameCode: string, handler?: EamuseModuleRoute) {
    const mod = GetCallerModule();
    if (typeof handler === 'function') {
      this.fallback[gameCode] = handler;
    } else {
      this.fallback[gameCode] = async (info, data, send) => {
        Logger.warn(`unhandled method ${info.module}.${info.method}`, { module: mod.name });
        send.deny();
      };
    }
  }

  public removeHandler(gameCode: string, method: string) {
    delete this.modules[`${gameCode}:${method}`];
  }

  public removeUnhandled(gameCode: string) {
    delete this.fallback[`${gameCode}`];
  }

  public clear() {
    delete this.modules;
    delete this.fallback;
    delete this.children;
    this.modules = {};
    this.fallback = {};
    this.children = [];
  }

  public run(
    gameCode: string,
    moduleName: string,
    method: string,
    info: EamuseInfo,
    data: any,
    send: EamuseSend,
    root: boolean = true
  ): boolean {
    let handler = this.modules[`${moduleName}.${method}`];
    if (isNil(handler)) handler = this.modules[`${gameCode}:${moduleName}.${method}`];

    if (isNil(handler)) {
      if (this.fallback[gameCode]) {
        this.fallback[gameCode](info, data, send);
        return true;
      } else {
        for (const child of this.children) {
          if (child.run(gameCode, moduleName, method, info, data, send, false)) return true;
        }

        if (root) send.deny();
        return false;
      }
    }

    if (typeof handler === 'boolean') {
      if (handler) {
        send.success();
        return true;
      } else {
        send.deny();
        return true;
      }
    }

    handler(info, data, send);
    return true;
  }
}
