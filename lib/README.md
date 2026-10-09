# Third-party libraries, hosted with the site

Copied byte for byte from the CDN addresses the site used to load them
from (checked by SHA-256 on 6 Oct 2026), so a CDN outage or a blocked CDN
can no longer stop the site. Both are MIT-licensed; each licence text sits
beside its file and is published with it.

They are not loaded with the page: `js/libs.js` loads one the first time a
PDF or Word download needs it.

| File | Version | Was loaded from | SHA-256 |
|---|---|---|---|
| `docx.umd.js` | docx 8.5.0 | `https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js` | `02d568d203c0180af37609bcf5ff6c0919d220f933a88ca896eba0556a08faad` |
| `jspdf.umd.min.js` | jsPDF 4.2.1 | `https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js` | `e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54` |

FileSaver.js 2.0.5 was dropped on 7 Oct 2026: `CVLibs.saveBlob` in
`js/libs.js` does the same job in a few lines.

To upgrade one: download the new version, replace the file, update this
table and the licence file, then run the full test set (the PDF and .docx
outputs depend on these libraries directly).
