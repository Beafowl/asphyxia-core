// Revert the previous fix-puc-scores.js run which incorrectly set scores to 10M.
// Restores original scores, sets clear to MXV (4), and recomputes volforce.
//
// Usage: Stop asphyxia-core first, then run:
//   node revert-puc-scores.js

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

// Records that were changed: mid, type, original score
const toRevert = [
  { mid: 1036, type: 2, score: 9891506 },
  { mid: 1879, type: 4, score: 9867139 },
  { mid: 838, type: 2, score: 9912060 },
  { mid: 1185, type: 2, score: 9927208 },
  { mid: 80, type: 3, score: 9878892 },
  { mid: 2237, type: 4, score: 9876223 },
  { mid: 1243, type: 4, score: 9855574 },
  { mid: 1832, type: 4, score: 9928360 },
  { mid: 1539, type: 4, score: 9901112 },
  { mid: 656, type: 2, score: 9915380 },
  { mid: 1964, type: 2, score: 9906029 },
  { mid: 1240, type: 2, score: 9859195 },
  { mid: 1812, type: 2, score: 9856857 },
  { mid: 2060, type: 2, score: 9902152 },
  { mid: 1015, type: 4, score: 9927897 },
  { mid: 1903, type: 2, score: 9948849 },
  { mid: 1930, type: 4, score: 9871926 },
  { mid: 1666, type: 2, score: 9934660 },
  { mid: 1783, type: 4, score: 9936733 },
  { mid: 1797, type: 2, score: 9920765 },
  { mid: 2166, type: 4, score: 9852135 },
  { mid: 1190, type: 2, score: 9926372 },
  { mid: 2137, type: 2, score: 9837110 },
  { mid: 2145, type: 2, score: 9978734 },
  { mid: 1518, type: 4, score: 9907094 },
  { mid: 2285, type: 2, score: 9906639 },
  { mid: 1675, type: 4, score: 9812889 },
  { mid: 1260, type: 2, score: 9855923 },
  { mid: 2237, type: 2, score: 9927370 },
  { mid: 1610, type: 2, score: 9905213 },
  { mid: 827, type: 3, score: 9910569 },
  { mid: 2220, type: 4, score: 9904063 },
  { mid: 2341, type: 2, score: 9904435 },
  { mid: 827, type: 3, score: 9940379 },
  { mid: 1474, type: 2, score: 9938016 },
  { mid: 1708, type: 2, score: 9895833 },
];

// Build a lookup: key -> list of original scores (multiple records can share mid+type)
const revertMap = new Map();
for (const r of toRevert) {
  const key = `${r.mid}:${r.type}`;
  if (!revertMap.has(key)) revertMap.set(key, []);
  revertMap.get(key).push(r.score);
}

function gradeFromScore(score) {
  if (score >= 9900000) return 10;
  if (score >= 9800000) return 9;
  if (score >= 9700000) return 8;
  if (score >= 9500000) return 7;
  if (score >= 9300000) return 6;
  if (score >= 9000000) return 5;
  if (score >= 8700000) return 4;
  if (score >= 7500000) return 3;
  if (score >= 6500000) return 2;
  return 1;
}

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
      doc.score === 10000000 &&
      doc.clear === 6
    ) {
      const key = `${doc.mid}:${doc.type}`;
      const scores = revertMap.get(key);
      if (scores && scores.length > 0) {
        const origScore = scores.shift(); // consume one entry
        doc.score = origScore;
        doc.clear = 4; // MXV
        doc.grade = gradeFromScore(origScore);

        const diffLevel = getDiffLevel(doc.mid, doc.type);
        if (diffLevel > 0) {
          doc.volforce = computeForce(diffLevel, origScore, 4, doc.grade);
        }

        fixed++;
        console.log(`Reverted mid=${doc.mid} type=${doc.type} score=10000000->${origScore} clear=6->4 (MXV) vf=${doc.volforce}`);
        return JSON.stringify(doc);
      }
    }
  } catch {}
  return line;
});

fs.writeFileSync(DB_PATH, output.join('\n'));
console.log(`\nDone. Reverted ${fixed} records.`);

// Check for any remaining bad records
let remaining = 0;
for (const line of output) {
  if (!line.trim()) continue;
  try {
    const doc = JSON.parse(line);
    if (doc.collection === 'music' && doc.version === 7 && doc.clear === 6 && doc.score < 10000000) {
      remaining++;
    }
  } catch {}
}
if (remaining > 0) {
  console.log(`Warning: ${remaining} records still have PUC with score < 10M`);
} else {
  console.log('All PUC records now have correct scores.');
}
