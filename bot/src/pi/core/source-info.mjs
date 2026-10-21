// Derived from earendil-works/pi v1.3.0 (71023aec1546d6d677a65669c5665c0927ce0dd0).
// Copyright (c) 2025 Mario Zechner. MIT; see third_party/pi/LICENSE and SOURCES.json.
export const BUILTIN_PATH_PREFIX = "builtin:";
export function getSyntheticPathSource(path) {
    if (path.startsWith(BUILTIN_PATH_PREFIX)) return "builtin";
    if (path.startsWith("<") && path.endsWith(">")) return path.slice(1, -1).split(":")[0] || "temporary";
    return undefined;
}
export function isSyntheticPath(path) {
    return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}
export function createSourceInfo(path, metadata) {
    return {
        path,
        source: metadata.source,
        scope: metadata.scope,
        origin: metadata.origin,
        baseDir: metadata.baseDir
    };
}
export function createSyntheticSourceInfo(path, options) {
    return {
        path,
        source: options.source,
        scope: options.scope ?? "temporary",
        origin: options.origin ?? "top-level",
        baseDir: options.baseDir
    };
}
