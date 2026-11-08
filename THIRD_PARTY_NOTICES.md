# Third-party notices

## 7-Zip

This package bundles a shared-library build of 7-Zip 26.06 from the official
`ip7z/7zip` repository, preserved as a git submodule at `vendor/7zip`.
Copyright (C) 1999-2026 Igor Pavlov.

Most bundled files are licensed under GNU LGPL 2.1 or later. Some files have
separate BSD or public-domain notices, as identified by upstream. The complete
license texts are preserved in `vendor/7zip/DOC/License.txt`; distribution
must retain those notices and comply with the applicable license for each
component.

RAR decompression uses source subject to the additional unRAR license
restriction. RAR source may handle RAR archives, but may not be used to
recreate the proprietary RAR compression algorithm. This package offers no
RAR creation functionality. The full restriction is preserved in
`vendor/7zip/DOC/unRarLicense.txt`.

The addon adapter and TypeScript API are MIT-licensed. The addon dynamically
links the upstream engine shared library rather than statically linking its
code into the Node-API module.
