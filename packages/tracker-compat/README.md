# tracker-compat

Plausible's compiled tracker scripts (MIT, see `LICENSE.md`), served unchanged at
`/js/*` on your ingest hostname while sites migrate to the QWA tracker. Copied from
Plausible CE v3.2.1.

Only the most common variants are vendored (see `apps/worker/src/compat/scripts.ts`); `pa-*.js`
scripts are generated per site:

| Requested URL | File served |
|---|---|
| `/js/script.js` | `plausible.js` |
| `/js/script.outbound-links.js` | `plausible.outbound-links.js` |
| `/js/script.file-downloads.hash.outbound-links.js` | `plausible.file-downloads.hash.outbound-links.js` |
| `/js/script.file-downloads.hash.outbound-links.tagged-events.js` | `plausible.file-downloads.hash.outbound-links.tagged-events.js` |
| `/js/script.manual.js` | `plausible.manual.js` |
| `/js/pa-<id>.js` | `plausible-web.js` with the site's config injected in place of `"<%= @config_js %>"` |

Legacy names are normalised the way Plausible does: base name `script|plausible|analytics`,
feature segments sorted alphabetically, `pageleave` ignored. Unknown variants return 404 and
are logged, so a missing variant shows up in the logs rather than silently dropping data.

You can delete this package (and the compat routes) once every site uses the QWA tracker.
