import { xmlToData, dataToXML, kencode, kitem } from './utils/KBinJSON';
import ejs from 'ejs';
import pug from 'pug';

const data = {
  attr: 0,
  text: 'text',
};

const xmlData = {
  root: { '@attr': { test: data.attr }, 'test': kitem('str', data.text) },
};
const ejsData = xmlToData(
  ejs.render('<root test="<%= attr %>"><test><%= text %></test></root>', data)
);
const pugData = xmlToData(pug.render('root(test=attr)\n    test #{text}', data));

console.log(JSON.stringify(xmlData, null, 4));
console.log(JSON.stringify(ejsData, null, 4));
console.log(JSON.stringify(pugData, null, 4));

console.log(kencode(xmlData).compare(kencode(ejsData)));
console.log(kencode(xmlData).compare(kencode(pugData)));
console.log(kencode(xmlData));
console.log(kencode(ejsData));
console.log(kencode(pugData));
