// SPDX-License-Identifier: AGPL-3.0-only
// Every message the web app uses must be in its source catalog (en-GB.po).
// A missing one shows as its hashed id (such as "-aXLs4") in production
// builds. Run after `lingui extract-template`, which writes messages.pot from
// the sources; this compares its messages with en-GB.po's.
import fs from 'node:fs';

const ids = (file) =>
  new Set(
    [...fs.readFileSync(new URL(`../../packages/web/src/locales/${file}`, import.meta.url), 'utf8')
      .matchAll(/^msgid "(.+)"$/gm)].map((m) => m[1])
  );

const used = ids('messages.pot');
const catalog = ids('en-GB.po');
const missing = [...used].filter((id) => !catalog.has(id));
if (missing.length) {
  console.error(`${missing.length} message(s) missing from packages/web/src/locales/en-GB.po:`);
  for (const id of missing) console.error(`  ${id}`);
  console.error('Add each as an entry (msgid and identical msgstr), and to messages.pot, at the end of the files.');
  process.exit(1);
}
console.log(`All ${used.size} web app messages are in en-GB.po.`);
