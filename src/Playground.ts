import { xmlToData, dataToXML, kencode, kitem, kdecode } from './utils/KBinJSON';
import { KonmaiEncrypt } from './utils/KonmaiEncrypt';
import iconv from 'iconv-lite';
import { writeFileSync, readFileSync, write } from 'fs';

// const data = readFileSync('response.bin');
// const decode = kdecode(data);
// console.log(dataToXML(decode));

const request = iconv.encode(
  '<call model="GLD:J:A:A:2007072301" srcid="01201000000E7AC029BE">\n<services method="get"/>\n</call>',
  'utf8'
);

const key = new KonmaiEncrypt('1-5ebc47ba-9868');
writeFileSync(`${key.getPublicKey()}.bin`, key.encrypt(request));
