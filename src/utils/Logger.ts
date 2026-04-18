import winston from 'winston';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

const isDebug = (process as any).pkg == null;

// Put log files next to the running binary / process cwd. Default is fine
// for both `npm run dev` (dist/logs) and pkg-packaged exe (logs/ beside
// the exe). Users can tail these between runs to see traffic summaries,
// slow-request warnings, plugin console output, and plugin errors.
const LOGS_DIR = path.resolve(process.cwd(), 'logs');
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

// Console format keeps the colored, human-friendly layout we had before.
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(info => {
    let stack = '';
    if (info.stack) {
      stack += `\n${info.stack}`;
    } else if (info.message && (info.message as any).stack) {
      stack += `\n${(info.message as any).stack}`;
    }

    const plugin =
      info.plugin == 'core' ? chalk.cyanBright('core') : chalk.yellowBright(info.plugin);
    if (info.level.indexOf('info') < 0) {
      return `  [${plugin}] ${info.level}: ${info.message}` + stack;
    } else {
      if (info.plugin == 'core') {
        return `${info.message}`;
      }
      return `  [${plugin}] ${info.message}` + stack;
    }
  })
);

// File format is plain ASCII with an ISO timestamp and no ANSI color codes
// (which would be garbage in a file viewer). Lines are always prefixed
// [timestamp] [plugin] level: message to make grep easy.
const fileFormat = winston.format.printf(info => {
  const ts = new Date().toISOString();
  let stack = '';
  if (info.stack) {
    stack += `\n${info.stack}`;
  } else if (info.message && (info.message as any).stack) {
    stack += `\n${(info.message as any).stack}`;
  }
  // info.level here has no ANSI codes because the colorize() format is
  // attached only to the console transport below.
  const plugin = info.plugin || 'core';
  return `[${ts}] [${plugin}] ${info.level}: ${info.message}${stack}`;
});

export const Logger = winston.createLogger({
  level: isDebug ? 'debug' : 'info',
  defaultMeta: { plugin: 'core' },
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      debugStdout: true,
      format: consoleFormat,
    }),
    // Main rolling log: captures everything (info+ in prod, debug+ in dev).
    // Rotates at 10 MB, keeps the last 5 files so total disk use stays
    // bounded at ~50 MB.
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'asphyxia.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    // Traffic-only log: the 5-minute summary lines and slow-request
    // warnings from EamuseMiddleware, isolated for quick analysis of
    // hot endpoints over time. Level filter is permissive (warn+ covers
    // both since summaries are info-level from plugin='core' and slow
    // warnings are warn-level).
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'traffic.log'),
      format: winston.format.combine(
        winston.format((info) => {
          const msg = String(info.message || '');
          if (msg.includes('Eamuse traffic summary') || msg.startsWith('Slow eamuse request:')) {
            return info;
          }
          return false;
        })(),
        fileFormat
      ),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});
