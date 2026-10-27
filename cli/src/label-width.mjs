/*
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
*/
// Unicode 17.0 EastAsianWidth W/F ranges, merged from
// https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt (Unicode data license).
const WIDE = /[\u{1100}-\u{115f}\u{231a}-\u{231b}\u{2329}-\u{232a}\u{23e9}-\u{23ec}\u{23f0}\u{23f3}\u{25fd}-\u{25fe}\u{2614}-\u{2615}\u{2630}-\u{2637}\u{2648}-\u{2653}\u{267f}\u{268a}-\u{268f}\u{2693}\u{26a1}\u{26aa}-\u{26ab}\u{26bd}-\u{26be}\u{26c4}-\u{26c5}\u{26ce}\u{26d4}\u{26ea}\u{26f2}-\u{26f3}\u{26f5}\u{26fa}\u{26fd}\u{2705}\u{270a}-\u{270b}\u{2728}\u{274c}\u{274e}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27b0}\u{27bf}\u{2b1b}-\u{2b1c}\u{2b50}\u{2b55}\u{2e80}-\u{2e99}\u{2e9b}-\u{2ef3}\u{2f00}-\u{2fd5}\u{2ff0}-\u{303e}\u{3041}-\u{3096}\u{3099}-\u{30ff}\u{3105}-\u{312f}\u{3131}-\u{318e}\u{3190}-\u{31e5}\u{31ef}-\u{321e}\u{3220}-\u{3247}\u{3250}-\u{a48c}\u{a490}-\u{a4c6}\u{a960}-\u{a97c}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe10}-\u{fe19}\u{fe30}-\u{fe52}\u{fe54}-\u{fe66}\u{fe68}-\u{fe6b}\u{ff01}-\u{ff60}\u{ffe0}-\u{ffe6}\u{16fe0}-\u{16fe4}\u{16ff0}-\u{16ff6}\u{17000}-\u{18cd5}\u{18cff}-\u{18d1e}\u{18d80}-\u{18df2}\u{1aff0}-\u{1aff3}\u{1aff5}-\u{1affb}\u{1affd}-\u{1affe}\u{1b000}-\u{1b122}\u{1b132}\u{1b150}-\u{1b152}\u{1b155}\u{1b164}-\u{1b167}\u{1b170}-\u{1b2fb}\u{1d300}-\u{1d356}\u{1d360}-\u{1d376}\u{1f004}\u{1f0cf}\u{1f18e}\u{1f191}-\u{1f19a}\u{1f200}-\u{1f202}\u{1f210}-\u{1f23b}\u{1f240}-\u{1f248}\u{1f250}-\u{1f251}\u{1f260}-\u{1f265}\u{1f300}-\u{1f320}\u{1f32d}-\u{1f335}\u{1f337}-\u{1f37c}\u{1f37e}-\u{1f393}\u{1f3a0}-\u{1f3ca}\u{1f3cf}-\u{1f3d3}\u{1f3e0}-\u{1f3f0}\u{1f3f4}\u{1f3f8}-\u{1f43e}\u{1f440}\u{1f442}-\u{1f4fc}\u{1f4ff}-\u{1f53d}\u{1f54b}-\u{1f54e}\u{1f550}-\u{1f567}\u{1f57a}\u{1f595}-\u{1f596}\u{1f5a4}\u{1f5fb}-\u{1f64f}\u{1f680}-\u{1f6c5}\u{1f6cc}\u{1f6d0}-\u{1f6d2}\u{1f6d5}-\u{1f6d8}\u{1f6dc}-\u{1f6df}\u{1f6eb}-\u{1f6ec}\u{1f6f4}-\u{1f6fc}\u{1f7e0}-\u{1f7eb}\u{1f7f0}\u{1f90c}-\u{1f93a}\u{1f93c}-\u{1f945}\u{1f947}-\u{1f9ff}\u{1fa70}-\u{1fa7c}\u{1fa80}-\u{1fa8a}\u{1fa8e}-\u{1fac6}\u{1fac8}\u{1facd}-\u{1fadc}\u{1fadf}-\u{1faea}\u{1faef}-\u{1faf8}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]/u;

/** Code points with East Asian Width W or F take two columns; every other takes one. */
export function labelWidth(label) {
  let width = 0;
  for (const ch of label) width += WIDE.test(ch) ? 2 : 1;
  return width;
}
