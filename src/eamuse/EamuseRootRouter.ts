import { EamuseRouteContainer, EamuseRouteHandler } from './EamuseRouteContainer';
import { EamusePlugin } from './EamusePlugin';
import { EamuseInfo } from '../middlewares/EamuseMiddleware';
import { EamuseSend } from './EamuseSend';

export class EamuseRootRouter {
  private core: EamuseRouteContainer;
  private pluginMap: {
    [gameCode: string]: EamusePlugin[];
  };
  private pluginMapID: {
    [name: string]: EamusePlugin;
  };
  private plugins: EamusePlugin[];

  constructor() {
    this.core = new EamuseRouteContainer();
    this.pluginMap = {};
    this.pluginMapID = {};
  }

  public add(method: string): void;
  public add(method: string, handler: EamuseRouteHandler | boolean): void;
  public add(method: EamuseRouteContainer): void;
  public add(method: string | EamuseRouteContainer, handler?: EamuseRouteHandler | boolean): void {
    this.core.add(method, handler);
  }

  public plugin(plugins: EamusePlugin[]) {
    this.plugins = plugins;
    for (const plugin of plugins) {
      for (const code of plugin.GameCodes) {
        if (this.pluginMap[code]) {
          this.pluginMap[code].push(plugin);
        } else {
          this.pluginMap[code] = [plugin];
        }
      }
      this.pluginMapID[plugin.Identifier] = plugin;
    }
  }

  public async run(
    gameCode: string,
    moduleName: string,
    method: string,
    info: EamuseInfo,
    data: any,
    send: EamuseSend
  ) {
    if (await this.core.run(moduleName, method, info, data, send)) return;
    if (this.pluginMap[gameCode]) {
      let success = false;
      for (const plugin of this.pluginMap[gameCode]) {
        const res = await plugin.run(moduleName, method, info, data, send);
        success = success || res;
      }
      if (success) return;
    }

    send.deny();
    return;
  }

  public getPluginByCode(gameCode: string) {
    return this.pluginMap[gameCode];
  }

  public getPluginByName(name: string) {
    return this.pluginMapID[name];
  }

  public get Plugins() {
    return this.plugins;
  }
}
