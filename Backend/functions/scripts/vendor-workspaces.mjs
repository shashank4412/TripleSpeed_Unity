/**
 * Vendor @redline/sim-core and @redline/rating into functions/vendor/ for the
 * Cloud Functions upload.
 *
 * WHY THIS EXISTS
 *
 * `firebase deploy` tars only the functions/ folder and runs a plain
 * `npm install` on it in Cloud Build. Our two dependencies are npm-workspace
 * packages ("@redline/sim-core": "*") that are not on the public registry, so
 * that install 404s. Both packages are deliberately zero-dependency and
 * self-contained (their package.json has no `dependencies`, and rating does not
 * import sim-core at runtime), so vendoring their built `lib/` and pointing the
 * dep at `file:./vendor/<name>` is enough — no bundler, no import rewriting, and
 * the import specifiers in the source stay exactly `@redline/sim-core` /
 * `@redline/rating`, which is the property the "one implementation" guarantee
 * depends on.
 *
 * This does NOT touch functions/package.json — the deploy wrapper
 * (Tools/deploy-backend) swaps the dep specifiers in and restores them, so the
 * committed manifest stays workspace-shaped for local dev and the tests.
 *
 *   node functions/scripts/vendor-workspaces.mjs      # run from Backend/
 */
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const functionsDir = resolve(here, '..');
const backendDir = resolve(functionsDir, '..');

/** name in node_modules -> workspace directory under Backend/ */
const PACKAGES = [
  ['sim-core', 'sim-core-ts'],
  ['rating', 'rating'],
];

for (const [vendorName, workspaceDir] of PACKAGES) {
  const srcDir = resolve(backendDir, workspaceDir);
  const srcLib = resolve(srcDir, 'lib');
  const srcPkgPath = resolve(srcDir, 'package.json');

  if (!existsSync(resolve(srcLib, 'index.js'))) {
    throw new Error(
      `${workspaceDir}/lib/index.js is missing — run the workspace build first ` +
        `(npm run build --workspace @redline/${vendorName === 'sim-core' ? 'sim-core' : 'rating'}).`,
    );
  }

  const srcPkg = JSON.parse(readFileSync(srcPkgPath, 'utf8'));
  if (srcPkg.dependencies && Object.keys(srcPkg.dependencies).length > 0) {
    // If either package ever grows a runtime dependency, this vendoring is no
    // longer sufficient — the cloud install would need to resolve it too.
    throw new Error(
      `${srcPkg.name} has runtime dependencies ${JSON.stringify(srcPkg.dependencies)}; ` +
        `vendor-workspaces.mjs assumes zero-dependency packages.`,
    );
  }

  const destDir = resolve(functionsDir, 'vendor', vendorName);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(srcLib, resolve(destDir, 'lib'), { recursive: true });

  // Keep only the fields Node's module resolver needs. No scripts (nothing to
  // run), no devDependencies (not installed for a file: dep anyway).
  const vendoredPkg = {
    name: srcPkg.name,
    version: srcPkg.version,
    private: true,
    type: srcPkg.type,
    main: srcPkg.main,
    types: srcPkg.types,
    exports: srcPkg.exports,
    _vendoredFrom: `Backend/${workspaceDir}`,
    _vendoredBy: 'functions/scripts/vendor-workspaces.mjs',
  };
  writeFileSync(resolve(destDir, 'package.json'), JSON.stringify(vendoredPkg, null, 2) + '\n');
  console.log(`vendored ${srcPkg.name}  ->  functions/vendor/${vendorName}`);
}
