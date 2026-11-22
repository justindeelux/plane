import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: false,
  // the workspace package is private; bundle it so the published CLI has no workspace dependency
  noExternal: [/^@plane\/markdown/],
});
