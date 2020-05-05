import path from 'path';
import { render as ejs, renderFile as ejsFile } from 'ejs';
import { render as pug, renderFile as pugFile } from 'pug';
import getCallerFile from 'get-caller-file';

import { RequestHandler } from 'express';
import { findKey, get, has, defaultTo, set } from 'lodash';

import { isKBin, kdecode, kencode, xmlToData } from '../utils/KBinJSON';
import { KonmaiEncrypt } from '../utils/KonmaiEncrypt';
import LzKN from '../utils/LzKN';
import { Logger } from '../utils/Logger';
import { EamuseSendOption, EamuseModuleContainer } from '../eamuse/EamuseModuleContainer';

const ACCEPT_AGENTS = ['EAMUSE.XRPC/1.0', 'EAMUSE.Httpac/1.0'];

export interface EABody {
  data: object;
  buffer: Buffer;
  module: string;
  method: string;
  encrypted: boolean;
  compress: 'none' | 'lz77' | 'forcenone';
  model: string;
}

export interface EamuseInfo {
  module: string;
  method: string;
  model: string;
}

export const EamuseMiddleware: RequestHandler = async (req, res, next) => {
  res.set('X-Powered-By', 'Asphyxia');

  const agent = req.headers['user-agent'];
  if (ACCEPT_AGENTS.indexOf(agent) < 0) {
    Logger.debug(`EAM: Unsupported agent: ${agent}`);
    res.sendStatus(404);
    return;
  }

  const eamuseInfo = req.headers['x-eamuse-info'];

  let compress = req.headers['x-compress'];

  if (!compress) {
    compress = 'none';
  }

  const chunks: Buffer[] = [];

  req.on('data', chunk => {
    chunks.push(Buffer.from(chunk));
  });

  req.on('end', () => {
    Logger.debug(req.url);
    const data = Buffer.concat(chunks);
    if (!data) {
      Logger.debug(`EAM: No Data`);
      res.sendStatus(404);
      return;
    }

    let body = data;
    let encrypted = false;

    if (eamuseInfo) {
      encrypted = true;
      const key = new KonmaiEncrypt(eamuseInfo.toString());
      const decrypted = key.encrypt(body);
      body = decrypted;
    }

    if (body && compress === 'lz77') {
      body = LzKN.inflate(body);
    }

    if (!body) {
      Logger.debug(`EAM: Failed Data Processing`);
      res.sendStatus(404);
      return;
    }

    let xml;
    if (!isKBin(body)) {
      xml = xmlToData(body);
    } else {
      xml = kdecode(body);
    }

    const eaModule = findKey(get(xml, 'call'), x => has(x, '@attr.method'));
    const eaMethod = get(xml, `call.${eaModule}.@attr.method`);
    const model = get(xml, 'call.@attr.model');

    if (!eaModule || !eaMethod) {
      res.sendStatus(404);
      return;
    }

    Logger.debug(`${eaModule}.${eaMethod}`);

    req.body = {
      data: xml,
      buffer: data,
      module: eaModule as string,
      method: eaMethod as string,
      compress,
      encrypted,
      model,
    } as EABody;
    next();
  });
};

export const EamuseRoute = (container: EamuseModuleContainer): RequestHandler => {
  const route: RequestHandler = async (req, res) => {
    const body = req.body as EABody;

    const sendObject = async (content: any = {}, options: EamuseSendOption = {}) => {
      const encoding = defaultTo(options.encoding, 'SHIFT_JIS');
      const attr = defaultTo(options.attr, {});
      const status = defaultTo(options.status, 0);
      const rootName = defaultTo(options.rootName, req.body.module);

      const resAttr = {
        ...attr,
      };
      const result = { response: { '@attr': resAttr } };
      if (!has(content, '@attr')) {
        content['@attr'] = { status };
      } else {
        set(content, '@attr.status', status);
      }

      set(result, `response.${rootName}`, content);

      let kBin = kencode(result, encoding, true);
      const key = new KonmaiEncrypt();
      const pubKey = key.getPublicKey();
      let compress = 'none';

      const kBinLen = kBin.length;
      if (body.compress !== 'none' && kBinLen > 500) {
        compress = 'lz77';
        kBin = LzKN.deflate(kBin);
      }

      res.setHeader('X-Compress', compress);
      if (body.encrypted) {
        res.setHeader('X-Eamuse-Info', pubKey);
        kBin = key.encrypt(kBin);
      }

      res.send(kBin);
    };

    const sendXml = async (template: string, data?: any, options?: EamuseSendOption) => {
      return sendObject(xmlToData(ejs(template, data)), options);
    };

    const sendPug = async (template: string, data?: any, options?: EamuseSendOption) => {
      return sendObject(xmlToData(pug(template, data)), options);
    };

    const sendXmlFile = async (template: string, data?: any, options?: EamuseSendOption) => {
      const caller = getCallerFile();
      const callerPath = path.dirname(caller);
      const callerFile = path.basename(caller);
      if (callerPath.endsWith('modules')) {
        Logger.error(`[${callerFile}] Cannot render file templates from single-file modules`);
        return sendObject({}, { status: 1 });
      } else {
        return sendObject(xmlToData(ejsFile(path.join(callerPath, template), data)), options);
      }
    };

    const sendPugFile = async (template: string, data?: any, options?: EamuseSendOption) => {
      const caller = getCallerFile();
      const callerPath = path.dirname(caller);
      const callerFile = path.basename(caller);
      if (callerPath.endsWith('modules')) {
        Logger.error(`[${callerFile}] Cannot render file templates from single-file modules`);
        return sendObject({}, { status: 1 });
      } else {
        return sendObject(xmlToData(pugFile(path.join(callerPath, template), data)), options);
      }
    };
    const gameCode = body.model.split(':')[0];
    try {
      await container.run(
        gameCode,
        body.module,
        body.method,
        { module: body.module, method: body.method, model: body.model },
        get(body.data, `call.${body.module}`),
        {
          success: options => sendObject(options),
          deny: options => sendObject({}, { ...options, status: 1 }),
          status: (status, options) => sendObject({}, { ...options, status }),
          object: sendObject,
          xml: sendXml,
          pug: sendPug,
          xmlFile: sendXmlFile,
          pugFile: sendPugFile,
        }
      );
    } catch (err) {
      if ((process as any).pkg == null) {
        throw err;
      }
      await sendObject({}, { status: 1 });
    }
  };

  return route;
};
