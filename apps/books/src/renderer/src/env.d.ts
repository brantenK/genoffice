/// <reference types="vite/client" />
import type { BooksApi } from '../../shared/ipc'

declare global {
  interface Window {
    booksApi?: BooksApi
  }
}
