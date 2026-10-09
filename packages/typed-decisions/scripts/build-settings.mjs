import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
for (const file of ["console-client.js", "rule-form.js"])
  copyFileSync(
    new URL(`../src/${file}`, import.meta.url),
    new URL(`../dist/${file}`, import.meta.url),
  );
const source = readFileSync(
  new URL("../src/console-page.html", import.meta.url),
  "utf8",
);
const helpers = readFileSync(
  new URL("../src/rule-form.js", import.meta.url),
  "utf8",
).replace(/^export /gm, "");
if (!source.includes("/* RULE_FORM_HELPERS */"))
  throw Error("Rule form helper marker missing");
writeFileSync(
  new URL("../dist/console-page.html", import.meta.url),
  source.replace("/* RULE_FORM_HELPERS */", helpers),
);
