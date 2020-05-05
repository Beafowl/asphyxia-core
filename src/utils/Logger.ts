import winston from 'winston';

const isDebug = (process as any).pkg == null;

export const Logger = winston.createLogger({
  level: isDebug ? 'debug' : 'info',
  format: winston.format.printf(info => {
    if (info.level !== 'info') {
      return `${info.level}: ${info.message}`;
    } else {
      return `${info.message}`;
    }
  }),
  defaultMeta: { service: 'eamuse' },
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      debugStdout: true,
    }),
  ],
});
