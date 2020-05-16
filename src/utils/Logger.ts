import winston from 'winston';
import chalk from 'chalk';

const isDebug = (process as any).pkg == null;

export const Logger = winston.createLogger({
  level: isDebug ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(info => {
      const plugin =
        info.plugin == 'core' ? chalk.cyanBright('core') : chalk.yellowBright(info.plugin);
      if (info.level.indexOf('info') < 0) {
        return `  [${plugin}] ${info.level}: ${info.message}`;
      } else {
        if (info.plugin == 'core') {
          return `${info.message}`;
        }
        return `  [${plugin}] ${info.message}`;
      }
    })
  ),
  defaultMeta: { plugin: 'core' },
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      debugStdout: true,
    }),
  ],
});
