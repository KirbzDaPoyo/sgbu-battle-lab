import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("../", import.meta.url).pathname);
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, "src"), resolve(output, "src"), { recursive: true });
await cp(resolve(root, "index.html"), resolve(output, "index.html"));
await cp(resolve(root, "styles.css"), resolve(output, "styles.css"));

const html = await readFile(resolve(output, "index.html"), "utf8");
for (const required of ["styles.css", "src/data.js", "src/engine.js", "src/app.js"]) {
  if (!html.includes(required)) throw new Error(`index.html does not reference ${required}`);
}

await writeFile(resolve(output, "build-info.json"), `${JSON.stringify({ name: "SGBU Battle Lab", builtAt: new Date().toISOString() }, null, 2)}\n`);
console.log("Static production build created in dist/.");
