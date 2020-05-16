import { isNil } from 'lodash';

import { EamuseInfo } from '../middlewares/EamuseMiddleware';
import { GetCallerPlugin } from '../utils/EamuseIO';
import { Logger } from '../utils/Logger';
import { EamuseSend } from './EamuseSend';

export type EamusePluginRoute = (info: EamuseInfo, data: any, send: EamuseSend) => Promise<any>;

export class EamusePluginContainer {
  private plugins: {
    [key: string]: boolean | EamusePluginRoute;
  };

  private fallback: {
    [key: string]: EamusePluginRoute;
  };

  private children: EamusePluginContainer[];

  constructor() {
    this.plugins = {};
    this.fallback = {};
    this.children = [];
  }

  public add(gameCode: string, method: string): void;
  public add(gameCode: string, method: string, handler: EamusePluginRoute | boolean): void;
  public add(gameCode: EamusePluginContainer): void;
  public add(
    gameCode: string | EamusePluginContainer,
    method?: string,
    handler?: EamusePluginRoute | boolean
  ): void {
    if (typeof gameCode === 'string' && method !== null && typeof method === 'string') {
      let key = `${gameCode}:${method}`;
      if (gameCode === '*') {
        key = `${method}`;
      }
      if (handler) {
        this.plugins[key] = handler;
      } else {
        this.plugins[key] = false;
      }
    }

    if (gameCode instanceof EamusePluginContainer) {
      this.children.push(gameCode);
    }
  }

  public unhandled(gameCode: string, handler?: EamusePluginRoute) {
    const plugin = GetCallerPlugin();
    if (typeof handler === 'function') {
      this.fallback[gameCode] = handler;
    } else {
      this.fallback[gameCode] = async (info, data, send) => {
        Logger.warn(`unhandled method ${info.module}.${info.method}`, { plugin: plugin.name });
        send.deny();
      };
    }
  }

  public removeHandler(gameCode: string, method: string) {
    delete this.plugins[`${gameCode}:${method}`];
  }

  public removeUnhandled(gameCode: string) {
    delete this.fallback[`${gameCode}`];
  }

  public clear() {
    delete this.plugins;
    delete this.fallback;
    delete this.children;
    this.plugins = {};
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
    let handler = this.plugins[`${moduleName}.${method}`];
    if (isNil(handler)) handler = this.plugins[`${gameCode}:${moduleName}.${method}`];

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
