// Zips dist/ into MeetNotes-<version>.zip (the file people download from Releases).
import { readFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';
const { version } = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
rmSync('release', { recursive: true, force: true });
mkdirSync('release/MeetNotes', { recursive: true });
cpSync('dist', 'release/MeetNotes', { recursive: true });
execSync(`cd release && zip -qr MeetNotes-${version}.zip MeetNotes`);
console.log(`release/MeetNotes-${version}.zip`);
