import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Logger } from './Logger';
import { xmlToData, dataToXML } from './KBinJSON';
import getCallerFile from 'get-caller-file';

export function ExistsFile(file: string): boolean {
  try {
    return existsSync(`${file}.json`);
  } catch (err) {
    return false;
  }
}

export function ReadFile(file: string): any {
  try {
    if (!existsSync(`${file}.json`)) {
      return null;
    }
    const data = JSON.parse(
      readFileSync(`${file}.json`, {
        encoding: 'UTF-8',
      })
    );
    return data;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export function WriteFile(file: string, data: any, formated = false) {
  try {
    if (formated) {
      writeFileSync(`${file}.json`, JSON.stringify(data, null, 4));
    } else {
      writeFileSync(`${file}.json`, JSON.stringify(data));
    }
    Logger.info(`${file}.json Saved`);
  } catch (err) {
    Logger.error(err);
  }
}

// export function WriteDebugFile(file: string, data: any) {
//   if (process.env.ASPHYXIA_PRINT_LOG !== 'print') return;
//   try {
//     let output = JSON.stringify(data, null, 2);
//     const kitemReplace = /\{\s*\n\s*['"]@attr['"]: \{\s*\n\s*['"]?__type['"]?: ['"](.*)['"],?\s*\n\s*\},\s*\n\s*['"]@content['"]: \[\s*\n*\s*(.*)\s*\n*\s*\],?\s*\n\s*\}/g;
//     const strReplace = /\{\s*\n\s*['"]@attr['"]: \{\s*\n\s*['"]?__type['"]?: ['"](str)['"],?\s*\n\s*\},\s*\n\s*['"]@content['"]: (['"].*['"]),?\s*\n\s*\}/g;
//     const karrayReplace = /\{\s*\n\s*['"]@attr['"]: \{\s*\n\s*['"]?__type['"]?: ['"](.*)['"],\s*\n\s*['"]?__count['"]?: .*\s*\n\s*\},?\s*\n\s*['"]@content['"]: (\[(?:[^\]]|\n)*\]),?\s*\n\s*\}/g;

//     output = output.replace(kitemReplace, "kitem('$1', $2)");
//     output = output.replace(strReplace, "kitem('$1', $2)");
//     output = output.replace(karrayReplace, "karray('$1', $2)");
//     writeFileSync(`${file}.js`, `const debug = ${output};`);
//     Logger.debug(`Debug File ${file}.js Saved`);
//   } catch (err) {
//     Logger.debug(`Debug File ${file}.js Saving Failed`);
//   }
// }

export function ReadXML(file: string): any {
  try {
    if (!existsSync(`${file}.xml`)) {
      return null;
    }
    const data = xmlToData(readFileSync(`${file}.xml`));
    return data;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export function WriteXML(file: string, data: any) {
  try {
    writeFileSync(`${file}.xml`, dataToXML(data));
    Logger.info(`${file}.xml Saved`);
  } catch (err) {
    Logger.error(err);
  }
}

export function PrintXML(data: any) {
  try {
    Logger.info(dataToXML(data));
  } catch (err) {
    Logger.error(err);
  }
}
