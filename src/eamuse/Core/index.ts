import { cardmng } from './CardManager';
import { eacoin } from './EamuseCoin';
import { facility } from './Facility';
import { pcbtracker } from './PCBTracker';
import { kitem } from '../../utils/KBinJSON';
import { EamuseModuleContainer } from '../EamuseModuleContainer';

export const core = new EamuseModuleContainer();

core.add('*', 'message.get', async (info, data, send) => {
  await send.object({
    '@attr': { expire: 1200 },
  });
});

core.add('*', 'package.list', async (info, data, send) => {
  await send.object({
    '@attr': { expire: 1200 },
  });
});

core.add('*', 'pcbevent.put', async (info, data, send) => {
  await send.success();
});

core.add('*', 'tax.get_phase', async (info, data, send) => {
  await send.object({
    phase: kitem('s32', 0),
  });
});

core.add(eacoin);
core.add(facility);
core.add(cardmng);
core.add(pcbtracker);
