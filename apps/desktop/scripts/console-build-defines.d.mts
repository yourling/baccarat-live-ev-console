/**
 * Type declarations for `console-build-defines.mjs`.
 *
 * The module is plain ESM used by both `vite.config.ts` and the packaging
 * scripts, so TypeScript needs a sibling declaration to resolve the import
 * under `moduleResolution: Bundler`.
 */
export declare function consoleGitSha(): string;
export declare function consoleBuildDefines(): Record<string, string>;
