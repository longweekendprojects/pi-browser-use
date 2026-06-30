// Exercises the dispatcher exactly as index.ts execute() does, for verifying
// primitives and shortcuts without a pi reload.
//   node test-harness.mjs <action> key=value ...
import { run } from "./core.mjs";

const action = process.argv[2];
const params = { action };
for (const a of process.argv.slice(3)) {
  const i = a.indexOf("=");
  params[a.slice(0, i)] = a.slice(i + 1);
}
const r = await run(params, {
  confirm: async () => true,
  onUpdate: (u) => process.stderr.write(`… ${u.content?.[0]?.text ?? ""}\n`),
});
if (r.isError) process.exitCode = 1;
console.log(r.text);
