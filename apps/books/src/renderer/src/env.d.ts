/// <reference types="vite/client" />
import type { BooksApi } from '../../shared/ipc'

declare global {
  interface Window {
    /** The preload bridge. Declared here, once per program, for main,
     * preload, renderer and tests alike — do not redeclare it elsewhere. */
    booksApi?: BooksApi
  }
}
