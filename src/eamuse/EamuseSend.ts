import { EamuseSendOption } from './EamuseModuleContainer';

export class EamuseSend {
  success: (options?: EamuseSendOption) => Promise<void>;
  deny: (options?: EamuseSendOption) => Promise<void>;
  status: (code: number, options?: EamuseSendOption) => Promise<void>;
  object: (res: any, options?: EamuseSendOption) => Promise<void>;
  xml: (res: string, data?: any, options?: EamuseSendOption) => Promise<void>;
  pug: (res: string, data?: any, options?: EamuseSendOption) => Promise<void>;
  xmlFile: (file: string, data?: any, options?: EamuseSendOption) => Promise<void>;
  pugFile: (file: string, data?: any, options?: EamuseSendOption) => Promise<void>;
}
