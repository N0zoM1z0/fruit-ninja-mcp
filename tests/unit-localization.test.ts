import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "acorn";
import { loadGame, packagedGame, sha256, upstream } from "../src/upstream.js";
import { refereedGame } from "../src/evaluator/referee.js";
import { englishUi, localize } from "../src/localization.js";

const chinese = /[　-〿㐀-鿿豈-﫿＀-￯]/;
const ids = (html: string) =>
  [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]).sort();
const script = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1];

test("both evaluation builds show the same English UI with unchanged ids and valid script", async () => {
  const original = await loadGame();
  assert.equal(
    sha256(original),
    upstream.sha256,
    "the pinned upstream bytes are untouched",
  );
  const builds = {
    packaged: packagedGame(original),
    refereed: refereedGame(original).html,
  };
  for (const [name, html] of Object.entries(builds)) {
    assert.ok(!chinese.test(html), `${name} still contains Chinese text`);
    assert.deepEqual(ids(html), ids(original), `${name} changed DOM ids`);
    assert.ok(html.includes('<html lang="en">'));
    parse(script(html), { ecmaVersion: "latest" });
    for (const [, english] of englishUi)
      assert.ok(html.includes(english), `${name} lacks: ${english}`);
  }
});

test("localization fails closed when upstream text changes", async () => {
  const original = await loadGame();
  assert.throws(
    () => localize(original.replace("开始切水果", "开始")),
    /localization anchor changed|Untranslated/,
  );
  assert.throws(
    () => localize(original + "<p>新文字</p>"),
    /Untranslated game text/,
  );
});
