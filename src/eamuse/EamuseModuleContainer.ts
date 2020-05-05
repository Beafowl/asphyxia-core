import { isNil } from 'lodash';

import { KBinEncoding } from '../utils/KBinJSON';
import { EamuseInfo } from '../middlewares/EamuseMiddleware';

export interface EamuseSendOption {
  status?: number;
  encoding?: KBinEncoding;
  rootName?: string;
  attr?: any;
}

export interface EamuseSend {
  success: (options?: EamuseSendOption) => Promise<void>;
  deny: (options?: EamuseSendOption) => Promise<void>;
  status: (code: number, options?: EamuseSendOption) => Promise<void>;
  object: (res: any, options?: EamuseSendOption) => Promise<void>;
  xml: (res: string, data?: any, options?: EamuseSendOption) => Promise<void>;
  pug: (res: string, data?: any, options?: EamuseSendOption) => Promise<void>;
  xmlFile: (file: string, data?: any, options?: EamuseSendOption) => Promise<void>;
  pugFile: (file: string, data?: any, options?: EamuseSendOption) => Promise<void>;
}

export type EamuseModuleRoute = (req: EamuseInfo, data: any, send: EamuseSend) => Promise<any>;

export class EamuseModuleContainer {
  private modules: {
    [key: string]: boolean | EamuseModuleRoute;
  };

  constructor() {
    this.modules = {};
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
      this.modules = { ...this.modules, ...gameCode.modules };
    }
  }

  public async run(
    gameCode: string,
    moduleName: string,
    method: string,
    info: EamuseInfo,
    data: any,
    send: EamuseSend
  ): Promise<void> {
    let handler = this.modules[`${moduleName}.${method}`];
    if (isNil(handler)) handler = this.modules[`${gameCode}:${moduleName}.${method}`];
    if (isNil(handler)) {
      return await send.deny();
    }

    if (typeof handler === 'boolean') {
      if (handler) {
        return await send.success();
      } else {
        return await send.deny();
      }
    }

    await handler(info, data, send);
    return;
  }
}
