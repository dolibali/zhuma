/** Public labels only. Neither an inherited property nor any non-string value
 * may turn an unknown stable identity into a different displayed person. */
export function memberName(
  names: Readonly<Record<string, string>> | undefined,
  id: string,
): string {
  const value = names && Object.hasOwn(names, id) ? names[id] : undefined;
  return typeof value === 'string' && value ? value : id;
}
