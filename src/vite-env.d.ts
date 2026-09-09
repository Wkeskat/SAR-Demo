/// <reference types="vite/client" />

// Vite's client types declare the CSS/asset module shapes (`declare module
// '*.css'` and friends) and `import.meta.env`. tsconfig already lists
// "types": ["vite/client"], which is enough for `tsc` on the command line —
// but editors resolve types per-file and some TS server versions do not pick
// up the compilerOptions "types" entry for a file that imports CSS. The
// triple-slash reference makes it explicit, which is why the red squiggles
// on `import './style.css'` disappear.
