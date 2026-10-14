/** Normalize only SQL identifier qualifiers; string literals and function bodies retain semantics. */
export function normalizeSchemaQualifiers(source: string, schema: string): string {
  let result = '';
  let offset = 0;
  while (offset < source.length) {
    const start = offset;
    if (source.startsWith('--', offset)) {
      const end = source.indexOf('\n', offset + 2);
      offset = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', offset)) {
      let depth = 1;
      offset += 2;
      while (offset < source.length && depth > 0) {
        if (source.startsWith('/*', offset)) {
          depth++;
          offset += 2;
        } else if (source.startsWith('*/', offset)) {
          depth--;
          offset += 2;
        } else offset++;
      }
    } else if (source[offset] === "'") {
      const escape =
        start > 0 &&
        /[eE]/.test(source[start - 1]!) &&
        (start < 2 || !/[\w$]/.test(source[start - 2]!));
      offset++;
      while (offset < source.length) {
        if (escape && source[offset] === '\\') offset += 2;
        else if (source[offset] === "'") {
          offset++;
          if (source[offset] !== "'") break;
          offset++;
        } else offset++;
      }
    } else if (source[offset] === '$' && /^\$(?:[A-Za-z_][\w]*|)\$/.test(source.slice(offset))) {
      const delimiter = source.slice(offset).match(/^\$(?:[A-Za-z_][\w]*|)\$/)![0];
      const end = source.indexOf(delimiter, offset + delimiter.length);
      offset = end < 0 ? source.length : end + delimiter.length;
    } else if (source[offset] === '"' || /[A-Za-z_]/.test(source[offset]!)) {
      let identifier: string;
      if (source[offset] === '"') {
        offset++;
        identifier = '';
        while (offset < source.length) {
          if (source[offset] === '"') {
            offset++;
            if (source[offset] !== '"') break;
            identifier += '"';
            offset++;
          } else identifier += source[offset++]!;
        }
      } else {
        offset++;
        while (offset < source.length && /[\w$]/.test(source[offset]!)) offset++;
        identifier = source.slice(start, offset).toLowerCase();
      }
      let qualifierEnd = offset;
      while (/\s/.test(source[qualifierEnd] ?? '')) qualifierEnd++;
      if (identifier === schema && source[qualifierEnd] === '.') {
        result += '<schema>';
        continue;
      }
    } else offset++;
    result += source.slice(start, offset);
  }
  return result;
}
