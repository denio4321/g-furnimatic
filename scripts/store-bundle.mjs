// Builds the G-ExtensionStore submission from store/ and the portable exe:
// release/store/<title>/ (extension.json, extension.zip, icon.png, screenshot.png) and release/<title>-store.zip
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

const STORE_REPO = 'sirjonasxx/G-ExtensionStore';
const EXE = 'release/G-FurniMatic.exe';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const warn = (message) =>
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARNING: ${message}`);

// Same limits the store's pull request tests enforce
const pngSize = (file) => {
  const png = readFileSync(file);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

const checkPng = (file, [minWidth, minHeight], [maxWidth, maxHeight]) => {
  const { width, height } = pngSize(file);
  if (width < minWidth || height < minHeight || width > maxWidth || height > maxHeight) {
    throw new Error(
      `${file} is ${width}x${height}, the store wants between ${minWidth}x${minHeight} and ${maxWidth}x${maxHeight}`
    );
  }
};

// The store only accepts updates that keep the date of the first submission
const currentSubmissionDate = async (title) => {
  try {
    // Shared CI runners easily hit the anonymous rate limit
    const headers = process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
    const repo = await (await fetch(`https://api.github.com/repos/${STORE_REPO}`, { headers })).json();
    const index = await (
      await fetch(`https://raw.githubusercontent.com/${STORE_REPO}/${repo.default_branch}/.auto-generated/extensions.json`)
    ).json();
    return index.find((extension) => extension.title === title)?.submissionDate;
  } catch (err) {
    warn(`Could not read the store index (${err.message}), treating this as a first submission`);
  }
};

const storeDate = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${pad(date.getUTCMonth() + 1)}-${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

const zip = (source, destination) =>
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${path.resolve(source)}' -DestinationPath '${path.resolve(destination)}' -Force`,
  ], { stdio: 'inherit' });

const template = readJson('store/extension.json');
const { version } = readJson('package.json');
const gnode = readJson('node_modules/gnode-api/package.json');

if (!/^[^_.]+$/.test(template.title) || template.title.length <= 4) {
  throw new Error(`"${template.title}" is not a valid store title: more than 4 characters, no dots or underscores`);
}
if (!/^([0-9]+\.)*[0-9]+$/.test(version) || !/[1-9]/.test(version)) {
  throw new Error(`"${version}" is not a valid store version: only numbers and dots`);
}
if (!existsSync(EXE)) {
  throw new Error(`${EXE} not found, run "yarn dist" first`);
}
if (!existsSync('store/icon.png')) {
  warn('store/icon.png is missing (PNG, 20x20 to 80x80), skipping the store bundle');
  process.exit(0);
}
checkPng('store/icon.png', [20, 20], [80, 80]);
if (existsSync('store/screenshot.png')) checkPng('store/screenshot.png', [128, 64], [960, 1200]);

const now = storeDate(new Date());
const manifest = {
  ...template,
  version,
  framework: { name: 'G-Node', version: gnode.version },
  submissionDate: (await currentSubmissionDate(template.title)) ?? now,
  updateDate: now,
};

const outDir = path.join('release', 'store', template.title);
rmSync(path.join('release', 'store'), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

writeFileSync(path.join(outDir, 'extension.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync('store/icon.png', path.join(outDir, 'icon.png'));
if (existsSync('store/screenshot.png')) copyFileSync('store/screenshot.png', path.join(outDir, 'screenshot.png'));
zip(EXE, path.join(outDir, 'extension.zip'));
zip(outDir, path.join('release', `${template.title}-store.zip`));

console.log(`Store bundle ready: ${outDir} (version ${version}, submitted ${manifest.submissionDate})`);
