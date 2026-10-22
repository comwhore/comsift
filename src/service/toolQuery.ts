/** Usernames are passed as one argument and may also become report filenames. */
export function validToolQuery(query: string): boolean {
  return query.length > 0 && query.length <= 200 && !query.startsWith("-") &&
    !Array.from(query).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) && !/[/\\:*?"<>|]/.test(query) && query !== "." && query !== "..";
}
