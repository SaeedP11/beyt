import pkg from "../package.json";

// Typed here, not re-exported from package.json, so the package's type
// definitions don't point at a file outside the package.
export const VERSION: string = pkg.version;
