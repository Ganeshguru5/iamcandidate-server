/**
 * pdfLaTeX font packages under Tectonic (XeTeX).
 *
 * Packages like charter, times or palatino ship only Type 1 fonts in the T1
 * encoding. Overleaf compiles with pdfLaTeX, where they work. Under XeTeX the
 * default encoding is TU (Unicode): they find no matching font and LaTeX falls
 * back to Latin Modern *regular* for everything, so bold and italics vanish.
 *
 * {@link wrapperSource} fixes this in one of two ways:
 * - Plain-ASCII source: load T1 first, so the package gets its own Type 1
 *   fonts — the same files Overleaf uses, so line breaks match exactly.
 * - Source with typed Unicode (–, é, €): T1 can't show those under XeTeX, so
 *   load {@link PDFTEX_FONTS_SOURCE}, which swaps in the OpenType equivalent
 *   (same design, real bold/italic, any Unicode) when the document stayed in
 *   TU and doesn't use fontspec itself.
 * Documents that load none of these packages compile exactly as before.
 */

/** Packages that only work in T1 (pdfLaTeX); each has a mapping below. */
const PDFTEX_FONT_PACKAGES = [
  "charter",
  "times",
  "mathptmx",
  "tgtermes",
  "palatino",
  "mathpazo",
  "tgpagella",
  "bookman",
  "tgbonum",
  "newcent",
  "tgschola",
  "helvet",
  "tgheros",
  "avant",
  "tgadventor",
  "courier",
  "tgcursor",
]

/** `\usepackage[...]{a, b}` lines, with comments stripped. */
function loadedPackages(source: string): string[] {
  const code = source.replace(/(^|[^\\])%.*$/gm, "$1")
  const names: string[] = []
  for (const match of code.matchAll(
    /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g,
  )) {
    names.push(...(match[1] ?? "").split(",").map((name) => name.trim()))
  }
  return names
}
export const PDFTEX_FONTS_FILE = "knot-pdftex-fonts.tex"

export const PDFTEX_FONTS_SOURCE = String.raw`% knot: OpenType stand-ins for pdfLaTeX-only font packages (see latex-fonts.ts).
% Each hook records the replacement for a package the document loads; they are
% applied at \begin{document} only if the document is still in TU encoding.
\makeatletter
\def\knot@fonts{}
\def\knot@otf#1#2#3#4#5#6{%
  \g@addto@macro\knot@fonts{%
    #1{#2}[Extension=.otf, UprightFont=*#3, BoldFont=*#4,
      ItalicFont=*#5, BoldItalicFont=*#6, Ligatures=TeX]}}
\def\knot@gyre#1#2{\knot@otf#1{texgyre#2}{-regular}{-bold}{-italic}{-bolditalic}}
\def\knot@map#1#2{\AddToHook{package/#1/after}{#2}}

\knot@map{charter}{\knot@otf\setmainfont{XCharter}{-Roman}{-Bold}{-Italic}{-BoldItalic}}
\knot@map{times}{\knot@gyre\setmainfont{termes}}
\knot@map{mathptmx}{\knot@gyre\setmainfont{termes}}
\knot@map{tgtermes}{\knot@gyre\setmainfont{termes}}
\knot@map{palatino}{\knot@gyre\setmainfont{pagella}}
\knot@map{mathpazo}{\knot@gyre\setmainfont{pagella}}
\knot@map{tgpagella}{\knot@gyre\setmainfont{pagella}}
\knot@map{bookman}{\knot@gyre\setmainfont{bonum}}
\knot@map{tgbonum}{\knot@gyre\setmainfont{bonum}}
\knot@map{newcent}{\knot@gyre\setmainfont{schola}}
\knot@map{tgschola}{\knot@gyre\setmainfont{schola}}
\knot@map{helvet}{\knot@gyre\setsansfont{heros}}
\knot@map{tgheros}{\knot@gyre\setsansfont{heros}}
\knot@map{avant}{\knot@gyre\setsansfont{adventor}}
\knot@map{tgadventor}{\knot@gyre\setsansfont{adventor}}
\knot@map{courier}{\knot@gyre\setmonofont{cursor}}
\knot@map{tgcursor}{\knot@gyre\setmonofont{cursor}}

\def\knot@TU{TU}
\AddToHook{begindocument/before}{%
  \ifx\knot@fonts\@empty\else
    \edef\knot@enc{\encodingdefault}%
    \ifx\knot@enc\knot@TU
      \@ifpackageloaded{fontspec}{}{%
        % Keep the family the document picked (e.g. \familydefault = \sfdefault).
        \let\knot@family\familydefault
        \RequirePackage{fontspec}%
        \knot@fonts
        \let\familydefault\knot@family}%
    \fi
  \fi}
\makeatother
`

/**
 * The file Tectonic actually compiles (one line, then the user's document via
 * \input, so TeX errors keep the document's own line numbers).
 */
export function wrapperSource(source: string, documentFile: string): string {
  const name = (file: string) => file.replace(/\.tex$/, "")
  const input = String.raw`\input{${name(documentFile)}}` + "\n"
  const packages = loadedPackages(source)
  if (!packages.some((p) => PDFTEX_FONT_PACKAGES.includes(p)) || packages.includes("fontspec")) {
    return input
  }
  // eslint-disable-next-line no-control-regex -- "anything outside ASCII"
  const ascii = !/[^\x00-\x7f]/.test(source)
  return (
    (ascii
      ? String.raw`\RequirePackage[T1]{fontenc}`
      : String.raw`\input{${name(PDFTEX_FONTS_FILE)}}`) + input
  )
}
