export interface QueueFileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

export const fileIdentity = (file: QueueFileIdentity): string =>
  `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

/** Keep selection order stable while ignoring the same browser File twice. */
export function appendUniqueFiles<T extends QueueFileIdentity>(current: T[], incoming: Iterable<T>): T[] {
  const merged = [...current];
  const known = new Set(current.map(fileIdentity));
  for (const file of incoming) {
    const key = fileIdentity(file);
    if (known.has(key)) continue;
    merged.push(file);
    known.add(key);
  }
  return merged;
}
