/** Bounds shared by the vector store and its HTTP layer. */
export const MAX_BATCH = 100
export const MAX_CONTENT = 1_000_000
export const MAX_INGEST_TEXT = 5_000_000
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_PDF_PAGES = 1000
/** Zip containers (DOCX/ODT/EPUB) may expand past their download size. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 5000
export const MAX_METADATA = 64 * 1024
export const MAX_TOP_K = 100
export const MAX_RAG_TOP_K = 20
export const MAX_POINT_ID = 128
export const DEFAULT_LIST_LIMIT = 25
export const MAX_LIST_LIMIT = 500
/** Rows fetched per search page. Keeps peak memory bounded on large collections. */
export const SCAN_BATCH = 2000
