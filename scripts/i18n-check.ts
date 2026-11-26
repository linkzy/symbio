// The interface's translations against English (web/src/i18n/en.ts): the keys each language lacks
// (shown in English until translated), and texts whose {placeholders} differ from English's.
//
//   npm run i18n:check            a report; exits 0 (CI shows it as a warning)
//   npm run i18n:check -- --strict  exits 1 when a language lacks keys or has a wrong placeholder

import { DICTS, LOCALES } from "../web/src/i18n.ts";
import { en, type MessageKey } from "../web/src/i18n/en.ts";

const strict = process.argv.includes("--strict");
const inCi = !!process.env.GITHUB_ACTIONS;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const keys = Object.keys(en) as MessageKey[];
let problems = 0;

for (const { id, label } of LOCALES) {
  if (id === "en") continue;
  const dict = DICTS[id];
  const missing = keys.filter((k) => dict[k] === undefined);
  const wrong = keys.filter((k) => dict[k] !== undefined && placeholders(dict[k]!) !== placeholders(en[k]));
  problems += missing.length + wrong.length;
  const done = keys.length - missing.length;
  console.log(`${label} (${id}): ${done} of ${keys.length} texts translated${missing.length ? `, ${missing.length} missing` : ""}${wrong.length ? `, ${wrong.length} with other placeholders than English` : ""}.`);
  for (const k of missing) console.log(`  missing  ${k}: ${JSON.stringify(en[k])}`);
  for (const k of wrong) console.log(`  placeholders  ${k}: English has {${placeholders(en[k])}}, this has {${placeholders(dict[k]!)}}`);
  if (inCi && (missing.length || wrong.length)) {
    console.log(`::warning title=Translations (${id})::${missing.length} text(s) not translated, ${wrong.length} with other placeholders. Run npm run i18n:check for the list.`);
  }
}

if (strict && problems) process.exit(1);
