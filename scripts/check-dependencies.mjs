import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
const minimumDownloads = 100_000;
const minimumAge = 14 * 24 * 60 * 60 * 1000;
const cutoff = Date.now() - minimumAge;

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Registry request failed: ${response.status} ${url}`);
  }
  return response.json();
}

async function check() {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`${name} must use an exact stable version, not ${version}.`);
      }
      if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
        throw new Error(`The lockfile does not match ${name}@${version}.`);
      }
    }
  }

  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error('A version 3 npm lockfile is required.');
  }

  const packages = Object.entries(lock.packages).filter(([path]) => path !== '');
  for (const [path, entry] of packages) {
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    const version = entry.version;
    if (entry.link || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`${path} is not a pinned stable registry package.`);
    }
    if (!entry.resolved || new URL(entry.resolved).origin !== 'https://registry.npmjs.org') {
      throw new Error(`${name}@${version} must resolve through the official npm registry.`);
    }

    const encoded = encodeURIComponent(name);
    const [metadata, downloads] = await Promise.all([
      getJSON(`https://registry.npmjs.org/${encoded}`),
      getJSON(`https://api.npmjs.org/downloads/point/last-week/${encoded}`),
    ]);
    const release = metadata.versions?.[version];
    const published = Date.parse(metadata.time?.[version] ?? '');
    if (!release || !Number.isFinite(published) || published > cutoff) {
      throw new Error(`${name}@${version} is not verifiably at least 14 days old.`);
    }
    if (!Number.isFinite(downloads.downloads) || downloads.downloads < minimumDownloads) {
      throw new Error(`${name} has fewer than 100,000 verified weekly downloads.`);
    }
    if (release.deprecated) {
      throw new Error(`${name}@${version} is deprecated: ${release.deprecated}`);
    }
    if (!entry.integrity || entry.integrity !== release.dist?.integrity) {
      throw new Error(`${name}@${version} does not match the official integrity hash.`);
    }
    if (entry.resolved !== release.dist?.tarball) {
      throw new Error(`${name}@${version} does not match the official tarball URL.`);
    }
    if (!release.dist?.signatures?.length) {
      throw new Error(`${name}@${version} has no registry signature to verify.`);
    }
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (release.scripts?.[hook]) {
        throw new Error(`${name}@${version} declares ${hook}; review it before changing this policy.`);
      }
    }
    console.log(
      `${name}@${version}: published ${new Date(published).toISOString()}, ` +
      `${downloads.downloads.toLocaleString('en-US')} downloads ` +
      `(${downloads.start} through ${downloads.end}); integrity matches.`,
    );
  }
  console.log(`Dependency policy passed for ${packages.length} locked package(s).`);
}

try {
  await check();
} catch (error) {
  console.error('Dependency policy failed:', error);
  process.exitCode = 1;
}
