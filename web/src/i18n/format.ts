export type Catalog = Record<string, unknown>;
export type Params = Record<string, string | number> | (string | number)[];

/** Looks up "ns.key" or "ns.nested.key" in a catalog. */
export function lookup(catalog: Catalog, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Fills placeholders: named ({name}) from an object, positional ({1}, {2}) from an array
 * (docs/DESIGN_SYSTEM.md §1.2). Unknown placeholders are left visible so gaps show up in tests.
 */
export function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = Array.isArray(params) ? params[Number(name) - 1] : params[name];
    return value === undefined ? whole : String(value);
  });
}
