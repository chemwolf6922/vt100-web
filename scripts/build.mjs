import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const buildDirectory = join(projectDirectory, 'build');

async function compile(argumentsToCompiler = []) {
  await new Promise((resolveBuild, rejectBuild) => {
    const compiler = spawn(
      process.execPath,
      [join(projectDirectory, 'node_modules/typescript/bin/tsc'), ...argumentsToCompiler],
      { cwd: projectDirectory, stdio: 'inherit' },
    );
    compiler.once('error', rejectBuild);
    compiler.once('exit', (code, signal) => {
      if (code === 0) {
        resolveBuild();
      } else {
        rejectBuild(new Error(`TypeScript compilation failed (${signal ?? code}).`));
      }
    });
  });
}

export async function build() {
  await compile(['--noEmit']);
  await rm(buildDirectory, { recursive: true, force: true });
  await mkdir(buildDirectory, { recursive: true });
  await compile();
  await cp(join(projectDirectory, 'public'), buildDirectory, { recursive: true });
  await copyFile(join(projectDirectory, 'src/index.css'), join(buildDirectory, 'index.css'));
  console.log('Built the VT100 console in build/.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
}
