/**
 * Metro in a pnpm workspace: watch the repo root so edits to `packages/*`
 * trigger a rebuild, resolve from both the app's and the root's `node_modules`,
 * and turn off Node's hierarchical lookup so a package can never be resolved
 * from a `.pnpm` directory that only happens to sit above it on disk.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
