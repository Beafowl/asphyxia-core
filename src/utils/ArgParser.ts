import { ArgumentParser } from 'argparse';
import { VERSION } from './Consts';

const parser = new ArgumentParser({
  version: VERSION,
  addHelp: true,
  description: 'AsphyxiaCore: A Rhythm Game Helper',
  prog: 'asphyxia_core',
});

parser.addArgument(['-p', '--port'], {
  help: 'Set listening port. (default: 8083)',
  defaultValue: 8083,
  type: 'int',
  metavar: 'PORT',
  dest: 'port',
});

parser.addArgument(['-b', '--bind'], {
  help: 'Hostname binding. In case you need to access it through LAN. (default: "localhost")',
  defaultValue: 'localhost',
  metavar: 'HOST',
  dest: 'bind',
});

// parser.addArgument(['-uip', '--webui-port'], {
//   help: 'Set WebUI port. (default: 8084)',
//   defaultValue: 8084,
//   type: 'int',
//   metavar: 'PORT',
//   dest: 'ui_port',
// });

// parser.addArgument(['-uib', '--webui-bind'], {
//   help: 'WebUI Hostname binding. (default: "localhost")',
//   defaultValue: 'localhost',
//   metavar: 'HOST',
//   dest: 'ui_bind',
// });

parser.addArgument(['-m', '--matching-port'], {
  help: 'Set matching port. (default: 5700)',
  defaultValue: 5700,
  type: 'int',
  dest: 'mport',
  metavar: 'PORT',
});

parser.addArgument(['-s', '--save-path'], {
  help: 'Set custom savedata directory',
  dest: 'save_path',
  metavar: 'PATH',
});

parser.addArgument(['--console'], {
  help: 'Enable console for modules.',
  defaultValue: false,
  dest: 'dev',
  action: 'storeTrue',
});

export const ARGS = parser.parseArgs();
