import winston from 'winston';
import chalk from 'chalk';

const isDebug = (process as any).pkg == null;
export const Logger = winston.createLogger({
  level: isDebug ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(info => {
      const module =
        info.module == 'core' ? chalk.cyanBright('core') : chalk.yellowBright(info.module);
      if (info.level.indexOf('info') < 0) {
        return `  [${module}] ${info.level}: ${info.message}`;
      } else {
        if (info.module == 'core') {
          return `${info.message}`;
        }
        return `  [${module}] ${info.message}`;
      }
    })
  ),
  defaultMeta: { module: 'core' },
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      debugStdout: true,
    }),
  ],
});
