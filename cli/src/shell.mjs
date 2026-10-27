export const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'"
