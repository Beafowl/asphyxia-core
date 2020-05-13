import { Router } from 'express';

import { EamuseMiddleware, EamuseRoute } from '../middlewares/EamuseMiddleware';
import { core } from './Core';
import { EamuseModuleContainer } from './EamuseModuleContainer';
import { dataToXML } from '../utils/KBinJSON';

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
    'sidmgr',
    'globby',
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

    // <response>
    //   <services>
    //     <item name="pcbtracker" url="http://192.168.1.57:60079/+" />
    //     <item name="posevent" url="http://192.168.1.57:60079/+" />
    //     <item name="pcbevent" url="http://192.168.1.57:60079/+" />
    //     <item name="message" url="http://192.168.1.57:60079/+" />
    //     <item name="facility" url="http://192.168.1.57:60079/+" />
    //     <item name="userdata" url="http://192.168.1.57:60079/+" />
    //     <item name="userid" url="http://192.168.1.57:60079/+" />
    //     <item name="cardmng" url="http://192.168.1.57:60079/+" />
    //     <item name="sidmgr" url="http://192.168.1.57:60079/+" />
    //     <item name="local" url="http://192.168.1.57:60079/+" />
    //     <item name="ntp" url="http://192.168.1.57:60079/+" />
    //     <item name="globby" url="http://192.168.1.57:5730/+" />
    //     <item
    //       name="keepalive"
    //       url="http://192.168.1.57:60079/+&amp;ga=192.168.1.57:60079&amp;ma=192.168.1.57:60079&amp;pa=192.168.1.57:60079&amp;ia=192.168.1.57:60079&amp;t1=1&amp;t2=5"
    //     />
    //   </services>
    // </response>;

    await send.object(services);
    return;
  });

  /* Core */
  rootEA.add(core);
  rootEA.add(modules);

  return routeEamuse;
};
