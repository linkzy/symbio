import { test } from "node:test";
import assert from "node:assert/strict";
import { browserLocale, DICTS, LOCALES } from "../web/src/i18n.js";
import { en, type MessageKey } from "../web/src/i18n/en.js";

test("the interface starts in the browser's language when Symbio has it, else English", () => {
  assert.equal(browserLocale(["pt-BR", "en-US"]), "pt-BR");
  assert.equal(browserLocale(["pt-PT"]), "pt-BR", "any Portuguese");
  assert.equal(browserLocale(["fr-FR", "en-GB"]), "en", "the first one Symbio has");
  assert.equal(browserLocale(["de-DE"]), "en");
  assert.equal(browserLocale([]), "en");
});

test("translations keep English's {placeholders}", () => {
  const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const { id } of LOCALES) {
    const dict = DICTS[id];
    const wrong = (Object.keys(en) as MessageKey[]).filter((k) => dict[k] !== undefined && names(dict[k]!) !== names(en[k]));
    assert.deepEqual(wrong, [], `${id}: placeholders differ`);
  }
});
