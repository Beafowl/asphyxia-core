// Fix v7 records where clear=6 (PUC) but score < 10,000,000.
// Score is the source of truth — downgrade lamp to MXV (clear=4) and recompute volforce.
//
// Usage: Stop asphyxia-core first, then run:
//   node fix-puc-scores.js

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'dist', 'savedata', 'sdvx@asphyxia.db');
const MUSIC_DB_PATH = path.join(__dirname, 'plugins', 'sdvx@asphyxia', 'webui', 'asset', 'json', 'music_db.json');

const medalCoef = [0, 0.5, 1.0, 1.02, 1.04, 1.06, 1.1];
const gradeCoef = [0, 0.8, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.0, 1.02, 1.05];
const diffName = ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate'];

function computeForce(diff, score, medal, grade) {
  return Math.floor(diff * (score / 10000000) * (gradeCoef[grade] || 0.8) * (medalCoef[medal] || 0.5) * 20);
}

// Load music DB for difficulty levels
let musicDb = null;
if (fs.existsSync(MUSIC_DB_PATH)) {
  musicDb = JSON.parse(fs.readFileSync(MUSIC_DB_PATH, 'utf8'));
  const customPath = MUSIC_DB_PATH.replace('music_db.json', 'custom_music_db.json');
  if (fs.existsSync(customPath)) {
    try {
      const custom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
      if (custom?.mdb?.music?.length) {
        musicDb.mdb.music = musicDb.mdb.music.concat(custom.mdb.music);
      }
    } catch {}
  }
}

function getDiffLevel(mid, type) {
  if (!musicDb) return 0;
  const song = musicDb.mdb.music.find(m => String(m.id) === String(mid));
  if (!song) return 0;
  return parseFloat(song.difficulty?.[diffName[type]]) || 0;
}

// Read and process the database
const raw = fs.readFileSync(DB_PATH, 'utf8');
const lines = raw.split('\n');
let fixed = 0;

const output = lines.map(line => {
  if (!line.trim()) return line;
  try {
    const doc = JSON.parse(line);
    if (
      doc.collection === 'music' &&
      doc.version === 7 &&
      doc.clear === 6 &&
      doc.score < 10000000
    ) {
      const oldClear = doc.clear;
      doc.clear = 4; // MXV

      const diffLevel = getDiffLevel(doc.mid, doc.type);
      if (diffLevel > 0) {
        doc.volforce = computeForce(diffLevel, doc.score, 4, doc.grade);
      }

      fixed++;
      console.log(`Fixed mid=${doc.mid} type=${doc.type} clear=${oldClear}->4 (PUC->MXV) score=${doc.score} vf=${doc.volforce}`);
      return JSON.stringify(doc);
    }
  } catch {}
  return line;
});

fs.writeFileSync(DB_PATH, output.join('\n'));
console.log(`\nDone. Fixed ${fixed} records.`);
