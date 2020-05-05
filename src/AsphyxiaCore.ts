import { Logger } from './utils/Logger';
import { ARGS } from './utils/ArgParser';
import { services } from './eamuse/Services';
import { VERSION } from './utils/Consts';
import { pad } from 'lodash';
import express from 'express';
import chalk from 'chalk';
import { LoadExternalModules } from './eamuse/ExternalModuleLoader';

process.title = `Asphyxia CORE ${VERSION}`;

Logger.info('                        _                _        ');
Logger.info('        /\\             | |              (_)      ');
Logger.info('       /  \\   ___ _ __ | |__  _   ___  ___  __ _ ');
Logger.info("      / /\\ \\ / __| '_ \\| '_ \\| | | \\ \\/ / |/ _` |");
Logger.info('     / ____ \\\\__ \\ |_) | | | | |_| |>  <| | (_| |');
Logger.info('    /_/    \\_\\___/ .__/|_| |_|\\__, /_/\\_\\_|\\__,_|');
Logger.info('                 | |           __/ |     __   __   __   ___ ');
Logger.info('                 |_|          |___/     /  ` /  \\ |__) |__  ');
Logger.info('                                        \\__, \\__/ |  \\ |___ ');
Logger.info('');
Logger.info(chalk.cyanBright(pad(`Asphyxia ${VERSION}`, 60)));
Logger.info(pad(`Brought you by TsFreddie`, 60));
Logger.info(` `);
Logger.info(chalk.redBright(pad(`FREE SOFTWARE. BEWARE OF SCAMMERS.`, 60)));
Logger.info(pad(`If you bought this software, request refund immediately.`, 60));
Logger.info(` `);

const EAMUSE = express();

EAMUSE.disable('etag');
EAMUSE.disable('x-powered-by');

const external = LoadExternalModules();
process.title = `Asphyxia CORE ${VERSION} | Modules: ${external.modules.length}`;
if (external.modules.length <= 0) {
  Logger.warn(chalk.yellowBright('no modules are installed.'));
  Logger.info('');
}

EAMUSE.use('*', services(`http://${ARGS.bind}:${ARGS.port}`, external.router));

const server = EAMUSE.listen(ARGS.port, ARGS.bind, () => {
  const serverInfo = `http://${ARGS.bind}:${ARGS.port}`;
  Logger.info(`       +==========================================+`);
  Logger.info(`       |${pad(serverInfo, 42)}|`);
  Logger.info(`       +==========================================+`);
});

server.on('error', (err: any) => {
  if (err && err.code == 'EADDRINUSE') {
    Logger.info('Server failed to start: port might be in use.');
    Logger.info('Use -p argument to change port.');
  }
  Logger.info(' ');
  Logger.error(`     ${err.message}`);
  Logger.info(' ');
  Logger.info('Press any key to exit.');
  process.stdin.resume();
  process.stdin.on('data', process.exit.bind(process, 0));
});
