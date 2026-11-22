import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
test("MCP input IDs and dates use executable digit regexes, not literal backslash-d",()=>{
  const doubleEscaped=String.raw`\\d`;
  assert.equal(source.includes(doubleEscaped),false,"MCP input validators must not double-escape regex digit classes");
  assert.ok(source.includes(String.raw`account_id: z.string().regex(/^\d{1,30}$/)`));
  assert.ok(source.includes(String.raw`campaign_id: z.string().regex(/^\d{1,30}$/)`));
  assert.ok(source.includes(String.raw`first_allowed_local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`));
});
