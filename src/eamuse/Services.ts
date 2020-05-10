import { Router } from 'express';

import { EamuseMiddleware, EamuseRoute } from '../middlewares/EamuseMiddleware';
import { core } from './Core';
import { EamuseModuleContainer } from './EamuseModuleContainer';

export const services = (url: string, modules: EamuseModuleContainer) => {
  const routeEamuse = Router();
  const rootEA = new EamuseModuleContainer();

  const coreModules = [
    'cardmng',
    'facility',
    'message',
    'numbering',
    'package',
    'pcbevent',
    'pcbtracker',
    'pkglist',
    'posevent',
    'userdata',
    'userid',
    'eacoin',
    'local',
    'local2',
    'lobby',
    'lobby2',
    'dlstatus',
    'netlog',
  ];

  /* General Information */
  routeEamuse.use(EamuseMiddleware).all('*', EamuseRoute(rootEA));

  /* - Service */
  rootEA.add('*', 'services.get', async (info, data, send) => {
    const services = {
      '@attr': {
        expire: 10800,
        method: 'get',
        mode: 'operation',
      },
      'item': [
        {
          '@attr': {
            name: 'ntp',
            url: 'ntp://pool.ntp.org/',
          },
        },
        {
          '@attr': {
            name: 'keepalive',
            url: `http://127.0.0.1/keepalive?pa=127.0.0.1&ia=127.0.0.1&ga=127.0.0.1&ma=127.0.0.1&t1=2&t2=10`,
          },
        },
      ],
    };

    for (const moduleName of coreModules) {
      services.item.push({ '@attr': { name: moduleName, url } });
    }

    await send.object(services);
    return;
  });

  /* Core */
  rootEA.add(core);
  rootEA.add(modules);

  return routeEamuse;
};
