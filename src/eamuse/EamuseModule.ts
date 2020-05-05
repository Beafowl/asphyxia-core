import { Logger } from '../utils/Logger';
import path from 'path';

export class EamuseModule {
  private instance: any;
  private dir: string;

  constructor(moduleDir: string) {
    var localPath = process.cwd();
    if ((process as any).pkg) {
      localPath = path.dirname(process.argv0);
    }
    this.dir = moduleDir;

    try {
      const modulePath = path.join(localPath, 'modules', moduleDir);

      this.instance = require(modulePath);
      if (this.instance && this.instance.default != null) {
        this.instance = this.instance.default;
      }
    } catch (err) {
      Logger.error(`Failed to load module "${this.dir}"`);
      Logger.error(err);
    }
  }

  moduleDirname() {
    return this.dir;
  }

  register() {
    if (this.instance && typeof this.instance.register === 'function') {
      this.instance.register();
    } else {
      Logger.warning(`register() in module "${this.dir}" is not implemented`);
    }
  }
}
